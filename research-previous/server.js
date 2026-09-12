const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DEFAULT_PATCHED_SWF = path.join(ROOT, "gunmayhem_authority_patch.swf");
const GAME_SWF = process.env.GAME_SWF
  ? path.resolve(ROOT, process.env.GAME_SWF)
  : fs.existsSync(DEFAULT_PATCHED_SWF)
    ? DEFAULT_PATCHED_SWF
    : path.join(ROOT, "gunmayhem.swf");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".swf": "application/x-shockwave-flash",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const rooms = new Map();

function roomCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function clientId() {
  return crypto.randomBytes(16).toString("hex");
}

function safeRoom(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function ensureRoom(code) {
  const id = safeRoom(code) || roomCode();
  if (!rooms.has(id)) {
    rooms.set(id, { clients: new Set() });
  }
  return { id, room: rooms.get(id) };
}

function publicClient(client) {
  return {
    id: client.id,
    seat: client.seat,
    role: client.seat === 1 ? "host" : "client",
    connectedAt: client.connectedAt,
  };
}

function broadcast(room, payload, except) {
  const data = JSON.stringify(payload);
  for (const peer of room.clients) {
    if (peer !== except && peer.ws.readyState === peer.ws.OPEN) {
      peer.ws.send(data);
    }
  }
}

function roomSnapshot(room) {
  return [...room.clients].map(publicClient);
}

function pickSeat(room, requestedSeat) {
  if (room.clients.size === 0) {
    return 1;
  }

  const taken = new Set([...room.clients].map((client) => client.seat));
  if ((requestedSeat === 1 || requestedSeat === 2) && !taken.has(requestedSeat)) {
    return requestedSeat;
  }
  if (!taken.has(1)) return 1;
  if (!taken.has(2)) return 2;
  return 0;
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const filePath =
    pathname === "/"
      ? path.join(PUBLIC, "index.html")
      : pathname === "/game.swf"
        ? GAME_SWF
      : pathname === "/gunmayhem.swf"
        ? path.join(ROOT, "gunmayhem.swf")
        : path.normalize(path.join(PUBLIC, pathname));

  if (
    !filePath.startsWith(PUBLIC) &&
    filePath !== path.join(ROOT, "gunmayhem.swf") &&
    filePath !== GAME_SWF
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": ext === ".swf" ? "public, max-age=3600" : "no-cache",
    });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const client = {
    id: clientId(),
    connectedAt: Date.now(),
    roomId: null,
    room: null,
    seat: 0,
    ws,
  };

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      sendJson(ws, { type: "error", message: "Bad JSON message." });
      return;
    }

    if (message.type === "join") {
      if (client.room) {
        client.room.clients.delete(client);
      }

      const { id, room } = ensureRoom(message.room);
      const seat = pickSeat(room, Number(message.seat));

      if (seat === 0) {
        sendJson(ws, { type: "full", room: id });
        return;
      }

      client.roomId = id;
      client.room = room;
      client.seat = seat;
      room.clients.add(client);

      sendJson(ws, {
        type: "joined",
        clientId: client.id,
        room: id,
        seat,
        role: seat === 1 ? "host" : "client",
        peers: roomSnapshot(room),
        serverTime: Date.now(),
      });
      broadcast(room, { type: "peer-joined", peer: publicClient(client), peers: roomSnapshot(room) }, client);
      return;
    }

    if (!client.room) {
      sendJson(ws, { type: "error", message: "Join a room before sending game data." });
      return;
    }

    if (message.type === "input") {
      broadcast(
        client.room,
        {
          type: "input",
          from: client.id,
          seat: client.seat,
          input: message.input,
          serverTime: Date.now(),
        },
        client,
      );
      return;
    }

    if (message.type === "player-state") {
      if (client.seat !== 1) {
        return;
      }
      broadcast(
        client.room,
        {
          type: "player-state",
          from: client.id,
          players: message.players || {},
          serverTime: Date.now(),
        },
        client,
      );
      return;
    }

    if (message.type === "spawn") {
      if (client.seat !== 1) {
        return;
      }
      broadcast(
        client.room,
        {
          type: "spawn",
          from: client.id,
          spawns: Array.isArray(message.spawns) ? message.spawns : [],
          serverTime: Date.now(),
        },
        client,
      );
      return;
    }

    if (message.type === "sync-reload") {
      broadcast(client.room, { type: "sync-reload", from: client.id, at: Date.now() + 1500 }, null);
      return;
    }

    if (message.type === "ping") {
      sendJson(ws, { type: "pong", at: Date.now() });
    }
  });

  ws.on("close", () => {
    if (!client.room) return;
    client.room.clients.delete(client);
    broadcast(client.room, { type: "peer-left", peer: publicClient(client), peers: roomSnapshot(client.room) }, client);
    if (client.room.clients.size === 0) {
      rooms.delete(client.roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Gun Mayhem netplay server running at http://localhost:${PORT}`);
  console.log(`Serving game SWF: ${GAME_SWF}`);
});
