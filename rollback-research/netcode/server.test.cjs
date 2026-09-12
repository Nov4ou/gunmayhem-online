'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createServer, FPS } = require('./server.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Peer {
  constructor(ws) {
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'tick' && this.onTick) this.onTick(message);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index < 0) this.messages.push(message);
      else {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    });
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  next(type, predicate = () => true, timeoutMs = 2000) {
    const matches = (message) => message.type === type && predicate(message);
    const index = this.messages.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate: matches, resolve };
      waiter.timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error(`Timed out waiting for ${type}; received: ${JSON.stringify(this.messages.slice(-8))}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  acknowledge(hash) {
    this.onTick = (tick) => this.send({
      type: 'ack', match: tick.match, frame: tick.frame,
      ...(tick.frame % FPS === 0 && hash !== undefined ? { hash } : {}),
    });
  }
}

async function setup(t, options = {}) {
  options = { ...options, limits: { lockstepFrameMs: 5, lockstepGraceMs: 1, ...(options.limits || {}) } };
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const peers = [];
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return {
    origin,
    async peer() {
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { origin });
      const peer = new Peer(ws);
      peers.push(peer);
      const hello = await peer.next('hello');
      peer.id = hello.id;
      return peer;
    },
  };
}

async function create(peer, name = 'Host') {
  peer.send({ type: 'create', name });
  return peer.next('joined');
}
async function join(peer, room, name = 'Guest') {
  peer.send({ type: 'join', room, name });
  return peer.next('joined');
}
async function roomPair(t, options) {
  const app = await setup(t, options);
  const host = await app.peer();
  const guest = await app.peer();
  const { room } = await create(host);
  await join(guest, room);
  return { app, host, guest, room };
}
async function loadMatch(host, peers) {
  host.send({ type: 'start' });
  const loads = await Promise.all(peers.map((peer) => peer.next('load')));
  for (const load of loads) assert.deepEqual(load, loads[0]);
  return loads[0];
}
async function startMatch(host, peers) {
  const load = await loadMatch(host, peers);
  for (const peer of peers) peer.send({ type: 'loaded', match: load.match });
  const begins = await Promise.all(peers.map((peer) => peer.next('begin')));
  for (const begin of begins) assert.deepEqual(begin, { type: 'begin', match: load.match, fps: FPS, maxRollbackFrames: 24 });
  return load;
}

async function relayFrames(peers, match, from, through) {
  for (let frame = from; frame <= through; frame++) {
    peers.forEach((peer, slot) => peer.send({ type: 'input', match, slot, frame, mask: (slot + frame) % 64 }));
  }
  await Promise.all(peers.map((peer) => peer.next('frame', message => message.frame >= through)));
}

function request(origin, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(origin, { path: pathname, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the page and Ruffle, handles HEAD, and blocks traversal and symlink escapes', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'gunmayhem-http-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const publicDir = path.join(temp, 'public');
  const ruffleDir = path.join(temp, 'ruffle');
  await fs.mkdir(publicDir);
  await fs.mkdir(ruffleDir);
  await fs.writeFile(path.join(publicDir, 'index.html'), '<h1>Game</h1>');
  await fs.writeFile(path.join(ruffleDir, 'ruffle.js'), '/* Ruffle fixture */');
  await fs.writeFile(path.join(temp, 'private.txt'), 'secret');
  await fs.symlink(path.join(temp, 'private.txt'), path.join(publicDir, 'escape.txt'));
  const { origin } = await setup(t, { publicDir, ruffleDir });
  assert.deepEqual(JSON.parse((await request(origin, '/health')).body), { ok: true });
  const page = await request(origin, '/');
  assert.equal(page.status, 200);
  assert.equal(page.body, '<h1>Game</h1>');
  assert.match(page.headers['content-type'], /text\/html/);
  const ruffle = await request(origin, '/ruffle/ruffle.js');
  assert.equal(ruffle.status, 200);
  assert.equal(ruffle.body, '/* Ruffle fixture */');
  assert.equal((await request(origin, '/', 'HEAD')).body, '');
  assert.equal((await request(origin, '/', 'POST')).status, 405);
  for (const pathname of ['/../private.txt', '/%2e%2e/private.txt', '/ruffle/../private.txt', '/%5c..%5cprivate.txt', '/escape.txt']) {
    const response = await request(origin, pathname);
    assert.equal(response.status, 403, pathname);
    assert.doesNotMatch(response.body, /secret/);
  }
  assert.equal((await request(origin, '/%E0%A4%A')).status, 400);
  assert.equal((await request(origin, '/missing')).status, 404);
});

test('returns an authenticated browser latency probe before room entry', async (t) => {
  const app = await setup(t);
  const peer = await app.peer();
  peer.send({ type: 'ping', sequence: 42 });
  assert.deepEqual(await peer.next('pong'), { type: 'pong', sequence: 42 });
  peer.send({ type: 'ping', sequence: 43, unexpected: true });
  assert.match((await peer.next('error')).message, /latency probe/);
});

test('isolates rooms, limits seats to four, and compacts seats when a player leaves', async (t) => {
  const app = await setup(t);
  const [a, b, c, d, e, other] = await Promise.all(Array.from({ length: 6 }, () => app.peer()));
  const first = await create(a, 'A');
  const second = await create(other, 'Other');
  assert.notEqual(first.room, second.room);
  assert.equal(first.slot, 0);
  assert.equal((await join(b, first.room, 'B')).slot, 1);
  assert.equal((await join(c, first.room, 'C')).slot, 2);
  assert.equal((await join(d, first.room, 'D')).slot, 3);
  const full = await a.next('room', (room) => room.players.length === 4);
  assert.deepEqual(full.players.map((player) => player.slot), [0, 1, 2, 3]);
  assert.equal(full.host, a.id);
  e.send({ type: 'join', room: first.room, name: 'E' });
  assert.match((await e.next('error')).message, /maximum capacity/);
  b.send({ type: 'leave' });
  await b.next('left');
  const remaining = await c.next('room', (room) => room.players.length === 3 && !room.players.some((player) => player.id === b.id));
  assert.deepEqual(remaining.players.map((player) => [player.id, player.slot]), [[a.id, 0], [c.id, 1], [d.id, 2]]);
  const newcomer = await app.peer();
  assert.equal((await join(newcomer, first.room)).slot, 3);
  await delay(30);
  assert(other.messages.filter((message) => message.type === 'room').every((message) => message.room === second.room && message.players.length === 1));
});

test('only the host controls a lobby and both original modes are preserved in match settings', async (t) => {
  const app = await setup(t);
  const host = await app.peer();
  const { room } = await create(host);
  host.send({ type: 'start' });
  assert.match((await host.next('error')).message, /At least two players/);
  const guest = await app.peer();
  await join(guest, room);
  guest.send({ type: 'start' });
  assert.match((await guest.next('error')).message, /host/);
  guest.send({ type: 'settings', mode: 'gun-game', map: 2, lives: 5 });
  assert.match((await guest.next('error')).message, /host/);
  for (const settings of [{ mode: 'last-man-standing', map: 0, lives: 5 }, { mode: 'last-man-standing', map: 13, lives: 5 }, { mode: 'last-man-standing', map: 1, lives: 0 }, { mode: 'last-man-standing', map: 1, lives: 21 }, { mode: 'last-man-standing', map: '1', lives: 5 }, { mode: 'deathmatch', map: 1, lives: 5 }, { map: 1, lives: 5 }]) {
    host.send({ type: 'settings', ...settings });
    assert.match((await host.next('error')).message, /Last Man Standing or Gun Game/);
  }
  host.send({ type: 'start', mode: 'campaign' });
  await host.next('error');
  host.send({ type: 'settings', mode: 'gun-game', map: 12, lives: 20 });
  const state = await guest.next('room', (message) => message.settings.mode === 'gun-game' && message.settings.map === 12);
  assert.deepEqual(state.settings, { mode: 'gun-game', map: 12, lives: 20 });
  const load = await loadMatch(host, [host, guest]);
  assert.deepEqual(load.settings, { mode: 'gun-game', map: 12, lives: 20 });
  assert.equal(load.players, 2);
  host.send({ type: 'settings', mode: 'last-man-standing', map: 1, lives: 5 });
  assert.match((await host.next('error')).message, /cannot be changed/);
});

test('waits for every browser to load, finalizes authoritative frame rows and isolates matches', async (t) => {
  const { app, host, guest } = await roomPair(t);
  const observer = await app.peer();
  await create(observer);
  const load = await loadMatch(host, [host, guest]);
  host.send({ type: 'loaded', match: load.match });
  guest.send({ type: 'loaded', match: 'stale-match' });
  await delay(70);
  assert.equal(host.messages.filter((message) => ['tick', 'begin', 'frame'].includes(message.type)).length, 0);
  guest.send({ type: 'loaded', match: load.match });
  await Promise.all([host.next('begin'), guest.next('begin')]);
  host.send({ type: 'input', match: load.match, slot: 0, frame: 1, mask: 8 });
  guest.send({ type: 'input', match: load.match, slot: 1, frame: 1, mask: 34 });
  const frames = await Promise.all([host, guest].map(peer => peer.next('frame', message => message.frame === 1)));
  for (const frame of frames) assert.deepEqual(frame.masks, [8, 34]);
  host.send({ type: 'input', match: load.match, slot: 0, frame: 1, mask: 8 }); // stale, ignored
  host.send({ type: 'input', match: 'stale-match', slot: 0, frame: 3, mask: 5 });
  await delay(40);
  assert.equal(observer.messages.filter((message) => ['load', 'begin', 'frame', 'input'].includes(message.type)).length, 0);
});

test('disconnect stops the game, transfers the host, and permits a fresh match with a new seed', async (t) => {
  const { app, host, guest, room } = await roomPair(t);
  const load = await startMatch(host, [host, guest]);
  host.send({ type: 'input', match: load.match, slot: 0, frame: 1, mask: 8 });
  await delay(5);
  host.ws.terminate();
  assert.match((await guest.next('stopped')).reason, /left/);
  const lobby = await guest.next('room', (message) => message.phase === 'lobby' && message.players.length === 1);
  assert.equal(lobby.host, guest.id);
  assert.equal(lobby.players[0].slot, 0);
  const newcomer = await app.peer();
  await join(newcomer, room);
  const rematch = await loadMatch(guest, [guest, newcomer]);
  assert.notEqual(rematch.match, load.match);
  assert(Number.isInteger(rematch.seed) && rematch.seed > 0);
  guest.send({ type: 'loaded', match: load.match });
  newcomer.send({ type: 'loaded', match: rematch.match });
  await delay(50);
  assert.equal(newcomer.messages.filter((message) => message.type === 'begin').length, 0);
  guest.send({ type: 'loaded', match: rematch.match });
  await newcomer.next('begin');
  guest.send({ type: 'input', match: rematch.match, slot: 0, frame: 1, mask: 0 });
  newcomer.send({ type: 'input', match: rematch.match, slot: 1, frame: 1, mask: 0 });
  const frame = await newcomer.next('frame', message => message.frame === 1);
  assert.deepEqual(frame.masks, [0, 0]);
});

test('buffers future inputs and rejects acknowledgements beyond the authoritative frame', async (t) => {
  const { host, guest } = await roomPair(t);
  const load = await startMatch(host, [host, guest]);
  for (let frame = 1; frame <= 5; frame++) host.send({ type: 'input', match: load.match, slot: 0, frame, mask: 8 });
  host.send({ type: 'ack', match: load.match, frame: 50 });
  assert.match((await host.next('error')).message, /confirmed frame/);
  for (let frame = 1; frame <= 5; frame++) guest.send({ type: 'input', match: load.match, slot: 1, frame, mask: 0 });
  const finalized = await host.next('frame', message => message.frame >= 5);
  assert(finalized.frame >= 5);
  host.send({ type: 'ack', match: load.match, frame: 5 });
  host.send({ type: 'finish', match: load.match, frame: 5 });
  await delay(40);
  assert.equal(host.messages.filter(message => ['tick', 'paused', 'resumed', 'error', 'stopped'].includes(message.type)).length, 0);
});

test('loading timeout still aborts, but an idle running peer no longer pauses or terminates the room', async (t) => {
  const { host, guest } = await roomPair(t, { limits: { loadTimeoutMs: 80, ackTimeoutMs: 150, maxAckLag: 1 } });
  const loading = await loadMatch(host, [host, guest]);
  host.send({ type: 'loaded', match: loading.match });
  assert.match((await host.next('stopped')).reason, /loading deadline/);
  await host.next('room', (message) => message.phase === 'lobby' && message.players.length === 2);
  await startMatch(host, [host, guest]);
  const frame = await host.next('frame', message => message.frame >= 5);
  assert(frame.fallbackSlots.length >= 1);
  await delay(200);
  assert.equal(host.messages.filter((message) => message.type === 'stopped').length, 0);
});

test('only the host can stop loading or running matches, and stopping permits another match', async (t) => {
  const { host, guest } = await roomPair(t);
  const loading = await loadMatch(host, [host, guest]);
  guest.send({ type: 'stop' });
  assert.match((await guest.next('error')).message, /Only the host/);
  assert.equal(host.messages.filter((message) => message.type === 'stopped').length, 0);
  host.send({ type: 'stop' });
  assert.match((await host.next('stopped')).reason, /host ended/);
  await guest.next('stopped');
  const running = await startMatch(host, [host, guest]);
  assert.notEqual(running.match, loading.match);
  guest.send({ type: 'stop' });
  assert.match((await guest.next('error')).message, /Only the host/);
  host.send({ type: 'stop' });
  assert.match((await guest.next('stopped')).reason, /host ended/);
  host.send({ type: 'stop' });
  assert.match((await host.next('error')).message, /no match currently/);
});

test('finishing requires an acknowledged frame and every peer reporting the current match', async (t) => {
  const { host, guest } = await roomPair(t);
  const load = await startMatch(host, [host, guest]);
  await relayFrames([host, guest], load.match, 1, 2);
  for (const frame of [-1, 0, 0.5, '1', 3, 1]) {
    host.send({ type: 'finish', match: load.match, frame });
    assert.match((await host.next('error')).message, /confirmed positive frame/);
  }
  host.send({ type: 'ack', match: load.match, frame: 1 });
  host.send({ type: 'finish', match: load.match, frame: 1 });
  guest.send({ type: 'ack', match: load.match, frame: 2 });
  guest.send({ type: 'finish', match: 'previous-match', frame: 2 });
  await delay(40);
  assert.equal(host.messages.filter((message) => message.type === 'stopped').length, 0);
  // Browsers can discover the end screen on different acknowledged frames.
  guest.send({ type: 'finish', match: load.match, frame: 2 });
  assert.match((await host.next('stopped')).reason, /match has concluded/);
  assert.match((await guest.next('stopped')).reason, /match has concluded/);
  const next = await startMatch(host, [host, guest]);
  assert.notEqual(next.match, load.match);
  host.send({ type: 'finish', match: load.match, frame: 1 });
  guest.send({ type: 'finish', match: load.match, frame: 2 });
  await delay(40);
  assert.equal(host.messages.filter((message) => message.type === 'stopped').length, 0);
  host.send({ type: 'finish', match: next.match, frame: 0 });
  guest.send({ type: 'finish', match: next.match, frame: 0 });
  assert.match((await host.next('error')).message, /confirmed positive frame/);
  assert.match((await guest.next('error')).message, /confirmed positive frame/);
});

test('equal confirmed frame hashes continue; different hashes stop a desynchronized match', async (t) => {
  const { host, guest } = await roomPair(t, { limits: { futureSlackFrames: 100 } });
  const load = await startMatch(host, [host, guest]);
  host.send({ type: 'ack', match: load.match, frame: 35, hash: 'aaa' });
  assert.match((await host.next('error')).message, /confirmed frame/);
  await relayFrames([host, guest], load.match, 1, 35);
  for (const peer of [host, guest]) peer.send({ type: 'ack', match: load.match, frame: 35, hash: 'aaa' });
  await delay(30);
  assert.equal(host.messages.filter((message) => ['error', 'stopped'].includes(message.type)).length, 0);
  await relayFrames([host, guest], load.match, 36, 70);
  host.send({ type: 'ack', match: load.match, frame: 70, hash: 'bbb' });
  guest.send({ type: 'ack', match: load.match, frame: 70, hash: 'ccc' });
  assert.match((await host.next('stopped')).reason, /State verification failed/);
  const lobby = await guest.next('room', (message) => message.phase === 'lobby' && message.players.length === 2);
  assert.equal(lobby.phase, 'lobby');
});

test('malformed messages, spoofed inputs and pending input revisions do not poison a rematch', async (t) => {
  const { host, guest } = await roomPair(t);
  for (const raw of ['', ' ', '\\n', '{}', '{broken', 'null', '[]', '123', '{"type":null}', '{"type":{}}']) {
    host.ws.send(raw);
    await host.next('error');
  }
  const load = await startMatch(host, [host, guest]);
  for (const mask of [-1, 64, 1.5, '2']) {
    host.send({ type: 'input', match: load.match, slot: 0, frame: 1, mask });
    assert.match((await host.next('error')).message, /frame input/);
  }
  for (const packet of [{ slot: 1, frame: 1 }, { slot: 0, frame: 9999 }]) {
    host.send({ type: 'input', match: load.match, mask: 0, ...packet });
    assert.match((await host.next('error')).message, /frame input/);
  }
  host.send({ type: 'ack', match: load.match, frame: 9999 });
  assert.match((await host.next('error')).message, /confirmed frame/);
  await relayFrames([host, guest], load.match, 1, 1);
  host.send({ type: 'input', match: load.match, slot: 0, frame: 5, mask: 0 });
  host.send({ type: 'input', match: load.match, slot: 0, frame: 5, mask: 63 });
  await delay(10);
  assert.equal(host.messages.some((message) => message.type === 'error' && /conflict/i.test(message.message || '')), false);
  assert.equal(host.messages.some((message) => message.type === 'stopped' && /Conflicting/i.test(message.reason || '')), false);
  host.send({ type: 'stop' });
  await host.next('stopped');
  await guest.next('stopped');
  const next = await startMatch(host, [host, guest]);
  assert.notEqual(next.match, load.match);
  await relayFrames([host, guest], next.match, 1, 1);
});

async function rejectedUpgrade(origin, headers = {}, pathname = '/ws') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + pathname, headers);
    ws.on('unexpected-response', (req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Upgrade unexpectedly succeeded')); });
  });
}

test('rejects cross-origin/missing-origin upgrades and enforces room and connection limits', async (t) => {
  const app = await setup(t, { limits: { maxConnections: 2, maxRooms: 1 } });
  assert.equal(await rejectedUpgrade(app.origin, { origin: 'https://attacker.example' }), 403);
  assert.equal(await rejectedUpgrade(app.origin), 403);
  assert.equal(await rejectedUpgrade(app.origin, { origin: app.origin }, '/wrong'), 403);
  const first = await app.peer();
  const second = await app.peer();
  assert.equal(await rejectedUpgrade(app.origin, { origin: app.origin }), 429);
  await create(first);
  second.send({ type: 'create', name: 'Second' });
  assert.match((await second.next('error')).message, /Room capacity/);
});

test('accepts external HTTPS origins behind a Host-preserving proxy, including ports, but ignores spoofed forwarding headers', async (t) => {
  const app = await setup(t);
  for (const [origin, host] of [['https://game.example', 'game.example'], ['https://game.example', 'game.example:443'], ['https://game.example:8443', 'game.example:8443']]) {
    const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', { origin, headers: { Host: host, 'X-Forwarded-Proto': 'https' } });
    const peer = new Peer(ws);
    t.after(() => ws.terminate());
    const hello = await peer.next('hello');
    assert.match(hello.id, /^[a-f0-9]{24}$/);
    assert.equal((await create(peer)).slot, 0);
  }
  assert.equal(await rejectedUpgrade(app.origin, { origin: 'https://game.example:8443', headers: { Host: 'game.example:9443' } }), 403);
  assert.equal(await rejectedUpgrade(app.origin, { origin: 'https://game.example', headers: { 'X-Forwarded-Host': 'game.example' } }), 403);
});

test('closes oversized messages and abusive message rates', async (t) => {
  const app = await setup(t, { limits: { maxPayload: 256, messageBurst: 5, messagesPerSecond: 1 } });
  const oversized = await app.peer();
  const largeClosed = once(oversized.ws, 'close');
  oversized.ws.send('x'.repeat(257));
  assert.equal((await largeClosed)[0], 1009);
  const flood = await app.peer();
  const floodClosed = once(flood.ws, 'close');
  for (let i = 0; i < 10; i += 1) flood.send({ type: 'leave' });
  assert.equal((await floodClosed)[0], 1008);
});

test('heartbeats disconnect an unresponsive peer and release its room', async (t) => {
  const app = await setup(t, { limits: { heartbeatMs: 30, maxRooms: 1 } });
  const ws = new WebSocket(app.origin.replace('http:', 'ws:') + '/ws', { origin: app.origin, autoPong: false });
  const silent = new Peer(ws);
  await silent.next('hello');
  await create(silent);
  const closed = once(ws, 'close');
  await closed;
  const replacement = await app.peer();
  assert.equal((await create(replacement)).slot, 0);
});
