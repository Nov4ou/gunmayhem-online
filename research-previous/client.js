const qs = new URLSearchParams(location.search);

const roomForm = document.querySelector("#roomForm");
const roomInput = document.querySelector("#roomInput");
const seatInput = document.querySelector("#seatInput");
const presetInput = document.querySelector("#presetInput");
const connectionStatus = document.querySelector("#connectionStatus");
const peerStatus = document.querySelector("#peerStatus");
const shareLink = document.querySelector("#shareLink");
const reloadButton = document.querySelector("#reloadButton");
const gameContainer = document.querySelector("#gameContainer");

const injectedEvents = new WeakSet();
let socket;
let player;
let clientId = null;
let room = qs.get("room") || "";
let seat = Number(qs.get("seat") || localStorage.getItem("seat") || 1);
let preset = qs.get("preset") || localStorage.getItem("preset") || "gm1";
let joined = false;
let role = "client";
let inputSeq = 0;
let reloadTimer = null;
let stateFlushTimer = null;
let spawnFlushTimer = null;
const authoritativePlayerStates = new Map();
const pendingPlayerStates = new Map();
const pendingSpawns = [];
const inboundSpawns = [];
const pressedBySeat = {
  1: new Set(),
  2: new Set(),
};

window.gmNetRole = function gmNetRole() {
  if (!joined) return 1;
  return role === "host" ? 1 : 2;
};

window.gmKeyDown = function gmKeyDown(playerNumber, keyCode) {
  const activeSeat = Number(playerNumber);
  if (!joined || !pressedBySeat[activeSeat]) return null;
  return pressedBySeat[activeSeat].has(Number(keyCode));
};

window.gmPushPlayerState = function gmPushPlayerState(playerNumber, state) {
  if (!joined || role !== "host") return false;
  pendingPlayerStates.set(Number(playerNumber), String(state || ""));
  if (!stateFlushTimer) {
    stateFlushTimer = window.setTimeout(flushPlayerStates, 16);
  }
  return true;
};

window.gmPullPlayerState = function gmPullPlayerState(playerNumber) {
  return authoritativePlayerStates.get(Number(playerNumber)) || "";
};

window.gmPushSpawn = function gmPushSpawn(kind, clipName, x, y, rotation, asdf, asdf2) {
  if (!joined || role !== "host") return false;
  pendingSpawns.push([
    Number(kind) === 2 ? 2 : 1,
    String(clipName || ""),
    Number(x) || 0,
    Number(y) || 0,
    Number(rotation) || 0,
    Number(asdf) || 0,
    Number(asdf2) || 0,
  ]);
  if (!spawnFlushTimer) {
    spawnFlushTimer = window.setTimeout(flushSpawns, 16);
  }
  return true;
};

window.gmPullSpawns = function gmPullSpawns() {
  if (inboundSpawns.length === 0) return "";
  const batch = inboundSpawns.splice(0, 80);
  return batch.map(encodeSpawnForFlash).join(";");
};

roomInput.value = room;
seatInput.value = String(seat === 2 ? 2 : 1);
presetInput.value = preset === "gm2" ? "gm2" : "gm1";

const gameKeys = {
  p1: {
    left: keyDef("ArrowLeft", "ArrowLeft", 37),
    right: keyDef("ArrowRight", "ArrowRight", 39),
    up: keyDef("ArrowUp", "ArrowUp", 38),
    down: keyDef("ArrowDown", "ArrowDown", 40),
    shootGm1: keyDef("[", "BracketLeft", 219),
    bombGm1: keyDef("]", "BracketRight", 221),
    shootGm2: keyDef("z", "KeyZ", 90),
    bombGm2: keyDef("x", "KeyX", 88),
  },
  p2: {
    left: keyDef("a", "KeyA", 65),
    right: keyDef("d", "KeyD", 68),
    up: keyDef("w", "KeyW", 87),
    down: keyDef("s", "KeyS", 83),
    shootGm1: keyDef("t", "KeyT", 84),
    bombGm1: keyDef("y", "KeyY", 89),
    shootGm2: keyDef("t", "KeyT", 84),
    bombGm2: keyDef("y", "KeyY", 89),
  },
  menu: {
    enter: keyDef("Enter", "Enter", 13),
    escape: keyDef("Escape", "Escape", 27),
    space: keyDef(" ", "Space", 32),
  },
};

const localBindings = new Map([
  ["ArrowLeft", "left"],
  ["KeyA", "left"],
  ["ArrowRight", "right"],
  ["KeyD", "right"],
  ["ArrowUp", "up"],
  ["KeyW", "up"],
  ["ArrowDown", "down"],
  ["KeyS", "down"],
  ["KeyJ", "shoot"],
  ["KeyT", "shoot"],
  ["BracketLeft", "shoot"],
  ["KeyK", "bomb"],
  ["KeyY", "bomb"],
  ["BracketRight", "bomb"],
  ["Enter", "enter"],
  ["Escape", "escape"],
  ["Space", "space"],
]);

function keyDef(key, code, keyCode) {
  return { key, code, keyCode };
}

function setStatus(text, mode = "idle") {
  connectionStatus.textContent = text;
  document.body.classList.toggle("is-online", mode === "online");
  document.body.classList.toggle("is-error", mode === "error");
}

function actionToGameKey(action, playerSeat, activePreset) {
  if (action === "enter" || action === "escape" || action === "space") {
    return gameKeys.menu[action];
  }

  const table = playerSeat === 2 ? gameKeys.p2 : gameKeys.p1;
  if (action === "shoot") return table[activePreset === "gm2" ? "shootGm2" : "shootGm1"];
  if (action === "bomb") return table[activePreset === "gm2" ? "bombGm2" : "bombGm1"];
  return table[action];
}

function eventTargetList() {
  const targets = [window, document, gameContainer];
  if (player) {
    targets.push(player);
    if (player.shadowRoot) {
      const canvas = player.shadowRoot.querySelector("canvas");
      if (canvas) targets.push(canvas);
    }
  }
  return targets;
}

function buildKeyboardEvent(type, def) {
  const event = new KeyboardEvent(type, {
    key: def.key,
    code: def.code,
    keyCode: def.keyCode,
    which: def.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  });

  for (const prop of ["keyCode", "which"]) {
    try {
      Object.defineProperty(event, prop, { get: () => def.keyCode });
    } catch {
      // Some browsers keep these fields non-configurable.
    }
  }

  injectedEvents.add(event);
  return event;
}

function injectKey(type, def) {
  for (const target of eventTargetList()) {
    target.dispatchEvent(buildKeyboardEvent(type, def));
  }
}

function sendInput(input) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !joined) return;
  socket.send(JSON.stringify({ type: "input", input }));
}

function flushPlayerStates() {
  stateFlushTimer = null;
  if (!socket || socket.readyState !== WebSocket.OPEN || !joined || role !== "host") return;
  if (pendingPlayerStates.size === 0) return;

  const players = {};
  for (const [playerNumber, state] of pendingPlayerStates) {
    players[playerNumber] = state;
  }
  pendingPlayerStates.clear();
  socket.send(JSON.stringify({ type: "player-state", players }));
}

function flushSpawns() {
  spawnFlushTimer = null;
  if (!socket || socket.readyState !== WebSocket.OPEN || !joined || role !== "host") return;
  if (pendingSpawns.length === 0) return;

  const spawns = pendingSpawns.splice(0, pendingSpawns.length);
  socket.send(JSON.stringify({ type: "spawn", spawns }));
}

function encodeSpawnForFlash(spawn) {
  const kind = Number(spawn[0]) === 2 ? 2 : 1;
  const clipName = String(spawn[1] || "").replace(/[;|]/g, "");
  return [
    kind,
    clipName,
    Number(spawn[2]) || 0,
    Number(spawn[3]) || 0,
    Number(spawn[4]) || 0,
    Number(spawn[5]) || 0,
    Number(spawn[6]) || 0,
  ].join("|");
}

function updatePressedSeat(playerSeat, def, type) {
  const keys = pressedBySeat[playerSeat];
  if (!keys || !def) return;
  if (type === "keyup") {
    keys.delete(def.keyCode);
  } else {
    keys.add(def.keyCode);
  }
}

function handleLocalKey(event) {
  if (injectedEvents.has(event)) return;

  const action = localBindings.get(event.code);
  if (!action || !joined) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const def = actionToGameKey(action, seat, preset);
  if (!def) return;

  const type = event.type === "keyup" ? "keyup" : "keydown";
  const input = {
    seq: ++inputSeq,
    type,
    action,
    preset,
    key: def.key,
    code: def.code,
    keyCode: def.keyCode,
    at: performance.now(),
  };

  updatePressedSeat(seat, def, type);
  injectKey(type, def);
  sendInput(input);
}

function applyRemoteInput(message) {
  if (!message.input || message.from === clientId) return;
  const incoming = message.input;
  const remotePreset = incoming.preset || preset;
  const def =
    incoming.action && Number.isInteger(message.seat)
      ? actionToGameKey(incoming.action, message.seat, remotePreset)
      : keyDef(incoming.key, incoming.code, incoming.keyCode);

  if (def) {
    const type = incoming.type === "keyup" ? "keyup" : "keydown";
    updatePressedSeat(message.seat, def, type);
    injectKey(type, def);
  }
}

function updatePeers(peers = []) {
  const playerCount = peers.filter((peer) => peer.seat === 1 || peer.seat === 2).length;
  peerStatus.textContent = `${playerCount} / 2`;
}

function updateShareLink() {
  if (!room) {
    shareLink.textContent = "进入房间后生成";
    shareLink.disabled = true;
    return;
  }

  const url = new URL(location.href);
  url.searchParams.set("room", room);
  url.searchParams.set("seat", seat === 1 ? "2" : "1");
  url.searchParams.set("preset", preset);
  shareLink.textContent = url.href;
  shareLink.disabled = false;
}

function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }

  room = roomInput.value.trim();
  seat = Number(seatInput.value) === 2 ? 2 : 1;
  preset = presetInput.value === "gm2" ? "gm2" : "gm1";
  localStorage.setItem("seat", String(seat));
  localStorage.setItem("preset", preset);

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  joined = false;
  setStatus("正在连接...");

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "join", room, seat }));
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "joined") {
      joined = true;
      clientId = message.clientId;
      room = message.room;
      seat = message.seat;
      role = message.role || (seat === 1 ? "host" : "client");
      pressedBySeat[1].clear();
      pressedBySeat[2].clear();
      authoritativePlayerStates.clear();
      pendingPlayerStates.clear();
      pendingSpawns.length = 0;
      inboundSpawns.length = 0;
      roomInput.value = room;
      seatInput.value = String(seat);
      setStatus(`已连接：房间 ${room}，玩家 ${seat}，${role === "host" ? "房主" : "客机"}`, "online");
      updatePeers(message.peers);
      updateShareLink();
      reloadButton.disabled = false;

      const url = new URL(location.href);
      url.searchParams.set("room", room);
      url.searchParams.set("seat", String(seat));
      url.searchParams.set("preset", preset);
      history.replaceState(null, "", url);
      focusGame();
      return;
    }

    if (message.type === "peer-joined" || message.type === "peer-left") {
      updatePeers(message.peers);
      return;
    }

    if (message.type === "input") {
      applyRemoteInput(message);
      return;
    }

    if (message.type === "player-state") {
      for (const [playerNumber, state] of Object.entries(message.players || {})) {
        authoritativePlayerStates.set(Number(playerNumber), String(state || ""));
      }
      return;
    }

    if (message.type === "spawn") {
      if (Array.isArray(message.spawns)) {
        inboundSpawns.push(...message.spawns);
      }
      return;
    }

    if (message.type === "sync-reload") {
      scheduleReload(message.at);
      return;
    }

    if (message.type === "full") {
      setStatus(`房间 ${message.room} 已满`, "error");
    }
  });

  socket.addEventListener("close", () => {
    joined = false;
    role = "client";
    pressedBySeat[1].clear();
    pressedBySeat[2].clear();
    authoritativePlayerStates.clear();
    pendingPlayerStates.clear();
    pendingSpawns.length = 0;
    inboundSpawns.length = 0;
    if (stateFlushTimer) {
      window.clearTimeout(stateFlushTimer);
      stateFlushTimer = null;
    }
    if (spawnFlushTimer) {
      window.clearTimeout(spawnFlushTimer);
      spawnFlushTimer = null;
    }
    reloadButton.disabled = true;
    setStatus("连接已断开", "error");
    updatePeers([]);
  });

  socket.addEventListener("error", () => {
    setStatus("连接失败", "error");
  });
}

function focusGame() {
  gameContainer.focus({ preventScroll: true });
  if (player && typeof player.focus === "function") {
    player.focus({ preventScroll: true });
  }
}

function loadGame() {
  const ruffle = window.RufflePlayer?.newest();
  if (!ruffle) {
    setStatus("Ruffle 加载失败", "error");
    return;
  }

  gameContainer.textContent = "";
  player = ruffle.createPlayer();
  gameContainer.append(player);
  player.ruffle().load({ url: "/game.swf" });
  focusGame();
}

function scheduleReload(at) {
  clearTimeout(reloadTimer);
  const delay = Math.max(0, Number(at) - Date.now());
  setStatus("即将同步重载...");
  reloadTimer = setTimeout(() => {
    loadGame();
    if (joined) setStatus(`已连接：房间 ${room}，玩家 ${seat}，${role === "host" ? "房主" : "客机"}`, "online");
  }, delay);
}

roomForm.addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});

reloadButton.addEventListener("click", () => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: "sync-reload" }));
});

shareLink.addEventListener("click", async () => {
  if (!room || shareLink.disabled) return;
  await navigator.clipboard?.writeText(shareLink.textContent);
});

for (const type of ["keydown", "keyup"]) {
  window.addEventListener(type, handleLocalKey, { capture: true });
}

loadGame();
updateShareLink();

if (room) {
  connect();
}
