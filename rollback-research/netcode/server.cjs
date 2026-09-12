'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { WebSocketServer, WebSocket } = require('ws');
const { LockstepRelay, ProtocolError } = require('./rollback-inputs.js');

const FPS = 35;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function defaultAssetRoot(name) {
  const packaged = path.join(__dirname, name);
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, '../build', name);
}

/** Clients simulate locally; the server relays framed inputs. */
function createServer(options = {}) {
  const publicRoot = path.resolve(options.publicDir || process.env.PUBLIC_DIR || defaultAssetRoot('public'));
  const ruffleRoot = path.resolve(options.ruffleDir || process.env.RUFFLE_DIR || defaultAssetRoot('ruffle'));
  const limits = {
    maxConnections: 256,
    maxConnectionsPerIp: 64,
    maxRooms: 64,
    maxPayload: 4096,
    messagesPerSecond: 160,
    messageBurst: 240,
    heartbeatMs: 15000,
    joinTimeoutMs: 600000,
    loadTimeoutMs: 120000,
    ackTimeoutMs: 20000,
    maxRollbackFrames: 24,
    futureSlackFrames: 12,
    maxInputGapFrames: 70,
    lockstepGraceMs: 6,
    lockstepFrameMs: 1000 / FPS,
    ...options.limits,
  };
  const rooms = new Map();
  const clients = new Set();
  const ipCounts = new Map();
  let closing = false;

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (!pathname.startsWith('/') || pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}');
      return;
    }
    const isRuffle = pathname.startsWith('/ruffle/');
    const root = isRuffle ? ruffleRoot : publicRoot;
    const relative = isRuffle ? pathname.slice('/ruffle/'.length) : pathname.slice(1) || 'index.html';
    const requestedPath = path.resolve(root, relative);
    if (!requestedPath.startsWith(root + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    // realpath also prevents a public-directory symlink from exposing private files.
    Promise.all([fs.promises.realpath(root), fs.promises.realpath(requestedPath)]).then(async ([realRoot, realFile]) => {
      if (!realFile.startsWith(realRoot + path.sep)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      const stat = await fs.promises.stat(realFile);
      if (!stat.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(realFile).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': isRuffle ? 'public, max-age=86400' : 'no-cache',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      if (req.method === 'HEAD') res.end();
      else {
        const stream = fs.createReadStream(realFile);
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
      }
    }).catch((error) => {
      if (res.headersSent) res.destroy();
      else res.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500).end('Not found');
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayload, perMessageDeflate: false });

  function send(client, message) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > 1024 * 1024) {
      client.ws.terminate();
      return;
    }
    client.ws.send(JSON.stringify(message), (error) => { if (error) client.ws.terminate(); });
  }
  function broadcast(room, message) {
    for (const client of room.players) send(client, message);
  }
  function fail(client, message) { send(client, { type: 'error', message }); }
  function roomState(room) {
    return {
      type: 'room',
      room: room.code,
      host: room.host,
      players: room.players.map(({ id, name, slot }) => ({ id, name, slot })),
      phase: room.phase,
      settings: { ...room.settings },
    };
  }
  function updateRoom(room) { broadcast(room, roomState(room)); }
  function stop(room, reason, finished = false) {
    if (room.phase === 'lobby') return;
    room.phase = 'lobby';
    room.match = null;
    room.relay?.disconnect();
    room.relay = null;
    room.pausedAt = null;
    room.hashes.clear();
    for (const client of room.players) {
      client.mask = 0;
      client.loaded = false;
      client.ack = 0;
      client.finishedFrame = null;
    }
    broadcast(room, { type: 'stopped', reason, finished });
    updateRoom(room);
  }
  function leave(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    client.slot = null;
    client.mask = 0;
    room.players = room.players.filter((player) => player !== client);
    room.players.forEach((player, slot) => { player.slot = slot; });
    if (!room.players.length) {
      rooms.delete(room.code);
      return;
    }
    if (room.host === client.id) room.host = room.players[0].id;
    if (room.phase !== 'lobby') stop(room, 'A player left the room; the match has been terminated.');
    else updateRoom(room);
  }
  function validName(value) {
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return name.length >= 1 && name.length <= 24 && !/[\u0000-\u001f\u007f]/u.test(name) ? name : null;
  }
  function enter(client, room, name) {
    client.name = name;
    client.room = room;
    client.slot = room.players.length;
    client.mask = 0;
    room.players.push(client);
    if (!room.host) room.host = client.id;
    send(client, { type: 'joined', room: room.code, slot: client.slot, id: client.id });
    updateRoom(room);
  }
  function begin(room, now) {
    room.phase = 'running';
    room.frame = 0;
    room.relay = new LockstepRelay({
      match: room.match, players: room.players.length,
      maxFutureFrames: limits.maxInputGapFrames,
      retentionFrames: 140,
    });
    room.nextFrameAt = now + limits.lockstepFrameMs;
    room.frameGraceStartedAt = null;
    room.pausedAt = null;
    for (const player of room.players) {
      player.mask = 0;
      player.ack = 0;
      player.lastAckAt = now;
      player.finishedFrame = null;
    }
    broadcast(room, { type: 'begin', match: room.match, fps: FPS, maxRollbackFrames: limits.maxRollbackFrames });
    updateRoom(room);
  }
  function receive(client, message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      fail(client, 'Invalid message format.');
      return;
    }
    const now = performance.now();
    if (message.type === 'ping') {
      if (!Number.isSafeInteger(message.sequence) || message.sequence < 1 ||
          Object.keys(message).some((key) => !['type', 'sequence'].includes(key))) {
        return fail(client, 'The latency probe is invalid.');
      }
      send(client, { type: 'pong', sequence: message.sequence });
      return;
    }
    if (message.type === 'create' || message.type === 'join') {
      if (client.room) return fail(client, 'Leave the current room before entering another room.');
      const name = validName(message.name);
      if (!name) return fail(client, 'Display names must contain between 1 and 24 characters.');
      if (now - client.lastRoomAction < 250) return fail(client, 'Requests are being submitted too quickly. Try again shortly.');
      client.lastRoomAction = now;
      if (message.type === 'create') {
        if (rooms.size >= limits.maxRooms) return fail(client, 'Room capacity has been reached. Try again later.');
        let code;
        do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
        const room = { code, host: null, players: [], phase: 'lobby', settings: { mode: 'last-man-standing', map: 1, lives: 10 }, hashes: new Map() };
        rooms.set(code, room);
        enter(client, room, name);
      } else {
        if (typeof message.room !== 'string' || !/^[a-f\d]{6}$/i.test(message.room)) return fail(client, 'The room code is invalid.');
        const room = rooms.get(message.room.toUpperCase());
        if (!room) return fail(client, 'The specified room does not exist.');
        if (room.phase !== 'lobby') return fail(client, 'A match is currently in progress in this room. Join after it has concluded.');
        if (room.players.length >= 4) return fail(client, 'The room has reached its maximum capacity of four players.');
        enter(client, room, name);
      }
      return;
    }
    if (message.type === 'leave') {
      leave(client);
      send(client, { type: 'left' });
      return;
    }
    const room = client.room;
    if (!room) return fail(client, 'Join a room before performing this action.');
    if (message.type === 'settings') {
      if (room.host !== client.id) return fail(client, 'Only the host may modify the match settings.');
      if (room.phase !== 'lobby') return fail(client, 'Match settings cannot be changed after the match has started.');
      if (!['last-man-standing', 'gun-game'].includes(message.mode) ||
          !Number.isInteger(message.map) || message.map < 1 || message.map > 12 ||
          !Number.isInteger(message.lives) || message.lives < 1 || message.lives > 20 ||
          Object.keys(message).some((key) => !['type', 'mode', 'map', 'lives'].includes(key))) {
        return fail(client, 'Select Last Man Standing or Gun Game, a map from 1 to 12, and a lives value from 1 to 20.');
      }
      room.settings = { mode: message.mode, map: message.map, lives: message.lives };
      updateRoom(room);
    } else if (message.type === 'start') {
      if (room.host !== client.id) return fail(client, 'Only the host may start the match.');
      if (room.phase !== 'lobby') return fail(client, 'The match has already started.');
      if (room.players.length < 2) return fail(client, 'At least two players are required to start a match.');
      if (Object.keys(message).some((key) => key !== 'type')) return fail(client, 'Select the game mode, map, and lives value through the room settings.');
      room.phase = 'loading';
      room.match = crypto.randomBytes(12).toString('hex');
      room.seed = crypto.randomInt(1, 0x7fffffff);
      room.loadDeadline = now + limits.loadTimeoutMs;
      room.hashes.clear();
      for (const player of room.players) { player.loaded = false; player.mask = 0; player.ack = 0; player.finishedFrame = null; }
      updateRoom(room);
      broadcast(room, { type: 'load', match: room.match, seed: room.seed, settings: { ...room.settings }, players: room.players.length });
    } else if (message.type === 'stop') {
      if (room.host !== client.id) return fail(client, 'Only the host may end the match.');
      if (room.phase === 'lobby') return fail(client, 'There is no match currently in progress.');
      stop(room, 'The host ended the current match. A new match may now be started.');
    } else if (message.type === 'finish') {
      if (room.phase !== 'running' || message.match !== room.match) return;
      if (!Number.isInteger(message.frame) || message.frame < 1 || message.frame > client.ack || message.frame > room.relay.confirmedFrame) {
        return fail(client, 'The completion frame must be a synchronized, confirmed positive frame.');
      }
      // End-screen discovery may happen on different browser frames. Every peer
      // must confirm the end of this match before it can be restarted.
      if (client.finishedFrame === null) client.finishedFrame = message.frame;
      if (room.players.every((player) => player.finishedFrame !== null)) {
        stop(room, 'The match has concluded. A new match may now be started.', true);
      }
    } else if (message.type === 'loaded') {
      if (room.phase !== 'loading' || message.match !== room.match) return;
      client.loaded = true;
      if (room.players.every((player) => player.loaded)) begin(room, now);
    } else if (message.type === 'input') {
      if (room.phase !== 'running' || message.match !== room.match) return;
      try {
        const result = room.relay.receiveInput(client.slot, message, now);
        if (result.status !== 'accepted' && result.status !== 'updated') return;
        // Inputs are buffered server-side only. Browsers receive one
        // authoritative `frame` row per simulation frame, not N per-player input
        // echoes, which keeps 3/4-player message volume bounded.
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        fail(client, 'Invalid frame input (' + error.code + ').');
      }
    } else if (message.type === 'ack' || message.type === 'hash') {
      if (room.phase !== 'running' || message.match !== room.match) return;
      // Runtime acknowledgements represent corrected, fully confirmed state,
      // unlike the speculative display frame, which may run ahead of the relay.
      if (!Number.isInteger(message.frame) || message.frame < 0 ||
          message.frame > room.relay.confirmedFrame) return fail(client, 'The confirmed frame is invalid.');
      if (message.type === 'hash' || message.hash !== undefined) {
        if (typeof message.hash !== 'string' || !/^[0-9a-f]{1,64}$/.test(message.hash)) {
          return fail(client, 'The state verification value is invalid.');
        }
        try {
          const result = room.relay.receiveHash(client.slot, {
            type: 'hash', match: room.match, frame: message.frame,
            hash: message.hash.padStart(8, '0'),
          });
          if (result.status === 'desync') {
            stop(room, 'State verification failed and the match has been terminated. Start a new match.');
            return;
          }
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          fail(client, 'Invalid state verification (' + error.code + ').');
          if (error.code === 'conflict') stop(room, 'Conflicting state verification values were received; the match has been terminated.');
          return;
        }
      }
      if (message.frame > client.ack) {
        client.ack = message.frame;
        client.lastAckAt = now;
      }
    } else {
      fail(client, 'The message type is not supported.');
    }
  }

  server.on('upgrade', (req, socket, head) => {
    let allowed = false;
    try {
      const origin = new URL(req.headers.origin);
      // A TLS reverse proxy must preserve the external Host header. Never trust
      // client-controlled X-Forwarded-Host to weaken this origin check.
      const target = new URL(`${origin.protocol}//${req.headers.host}`);
      allowed = ['http:', 'https:'].includes(origin.protocol) && origin.origin === target.origin &&
        [origin, target].every((url) => url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash);
    } catch { /* Browsers must provide a valid same-origin Origin header. */ }
    const ip = req.socket.remoteAddress || 'unknown';
    const route = (req.url || '').split('?')[0];
    const overLimit = clients.size >= limits.maxConnections || (ipCounts.get(ip) || 0) >= limits.maxConnectionsPerIp;
    if (closing || route !== '/ws' || !allowed || overLimit) {
      const status = closing ? '503 Service Unavailable' : overLimit ? '429 Too Many Requests' : '403 Forbidden';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const now = performance.now();
    const ip = req.socket.remoteAddress || 'unknown';
    const client = {
      ws, ip, id: crypto.randomBytes(12).toString('hex'), room: null, slot: null,
      name: '', mask: 0, loaded: false, ack: 0, finishedFrame: null, lastAckAt: now, alive: true,
      connectedAt: now, tokens: limits.messageBurst, tokenAt: now, lastRoomAction: -Infinity,
    };
    clients.add(client);
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    send(client, { type: 'hello', id: client.id });
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => { /* close performs room cleanup, including protocol errors. */ });
    ws.on('message', (raw, isBinary) => {
      const receivedAt = performance.now();
      client.tokens = Math.min(limits.messageBurst, client.tokens + (receivedAt - client.tokenAt) * limits.messagesPerSecond / 1000) - 1;
      client.tokenAt = receivedAt;
      if (client.tokens < 0) { ws.close(1008, 'Message rate limit'); return; }
      if (isBinary) { fail(client, 'Only JSON text messages are supported.'); return; }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { fail(client, 'The JSON message is malformed.'); return; }
      receive(client, message);
    });
    ws.on('close', () => {
      clients.delete(client);
      const count = (ipCounts.get(ip) || 1) - 1;
      if (count) ipCounts.set(ip, count); else ipCounts.delete(ip);
      leave(client);
    });
  });

  const stepTimer = setInterval(() => {
    const now = performance.now();
    for (const room of rooms.values()) {
      if (room.phase === 'loading') {
        if (now > room.loadDeadline) stop(room, 'A player exceeded the loading deadline. Verify the connection and start a new match.');
        continue;
      }
      if (room.phase !== 'running') continue;

      // Server-clocked delayed-input lockstep. A slow or backgrounded browser
      // never pauses the room: after one small grace window its missing input is
      // finalized as neutral. Subsequent late packets for that frame are stale
      // and cannot trigger rollback or change history.
      let finalized = 0;
      while (now >= room.nextFrameAt && finalized < 4) {
        const nextFrame = room.relay.confirmedFrame + 1;
        if (!room.relay.isComplete(nextFrame)) {
          if (room.frameGraceStartedAt === null && room.relay.shouldGrace(nextFrame, now)) {
            room.frameGraceStartedAt = now;
          }
          if (room.frameGraceStartedAt !== null && now - room.frameGraceStartedAt < limits.lockstepGraceMs) break;
        }
        const frame = room.relay.finalizeNext();
        room.frame = frame.frame;
        room.frameGraceStartedAt = null;
        broadcast(room, frame);
        room.nextFrameAt += limits.lockstepFrameMs;
        finalized++;
      }
      // A long server event-loop stall should not cause an unbounded burst.
      if (now - room.nextFrameAt > 4 * limits.lockstepFrameMs) room.nextFrameAt = now + limits.lockstepFrameMs;
    }
  }, 4);
  const heartbeatTimer = setInterval(() => {
    const now = performance.now();
    for (const client of clients) {
      if (!client.alive || !client.room && now - client.connectedAt > limits.joinTimeoutMs) {
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
    }
  }, limits.heartbeatMs);
  stepTimer.unref();
  heartbeatTimer.unref();

  const close = server.close.bind(server);
  server.close = (callback) => {
    closing = true;
    clearInterval(stepTimer);
    clearInterval(heartbeatTimer);
    for (const client of clients) client.ws.terminate();
    wss.close();
    return close(callback);
  };
  return server;
}

module.exports = { createServer, FPS };

if (require.main === module) {
  const server = createServer();
  const port = Number(process.env.PORT || 3003);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`Gun Mayhem rollback server listening on http://${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
}
