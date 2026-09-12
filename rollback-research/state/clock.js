/* Independent replacement for public/ruffle-clock.js for rollback experiments. */
(() => {
  'use strict';
  if (!globalThis.RuffleRollback) throw new Error('Load snapshot.js before clock.js');
  if (window.GunMayhemClock) throw new Error('The game clock is already installed');
  const fps = 35, callbacks = new Map();
  const NativeDate = window.Date, realNow = performance.now.bind(performance);
  let nextId = 1, frame = 0, timestamp = 0, inCallback = false, lastCallbackCount = 0, replay = false;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => timestamp });
  window.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') throw new TypeError('Expected an animation callback');
    const id = nextId++; callbacks.set(id, callback); return id;
  };
  window.cancelAnimationFrame = id => callbacks.delete(id);
  const epoch = NativeDate.UTC(2026, 0, 1);
  function SimulationDate(...args) {
    if (!new.target) return new NativeDate(epoch + timestamp).toString();
    return Reflect.construct(NativeDate, args.length ? args : [epoch + timestamp], new.target);
  }
  Object.setPrototypeOf(SimulationDate, NativeDate);
  SimulationDate.prototype = NativeDate.prototype;
  SimulationDate.now = () => epoch + Math.floor(timestamp);
  window.Date = SimulationDate;
  document.addEventListener('visibilitychange', event => event.stopImmediatePropagation(), true);
  function drain() {
    if (inCallback) throw new Error('Reentrant simulation tick');
    const pending = Array.from(callbacks);
    lastCallbackCount = pending.length; inCallback = true;
    try {
      for (const [id, callback] of pending) {
        if (!callbacks.delete(id)) continue;
        callback(timestamp);
      }
    } finally { inCallback = false; }
    return pending.length;
  }
  function state() { return { frame, timestamp, queued: callbacks.size, lastCallbackCount, inCallback, replay }; }
  globalThis.RuffleRollback.registerParticipant('clock', {
    capture: () => ({ nextId, frame, timestamp, lastCallbackCount, callbacks: Array.from(callbacks) }),
    restore(saved) {
      ({ nextId, frame, timestamp, lastCallbackCount } = saved);
      callbacks.clear();
      for (const [id, callback] of saved.callbacks) callbacks.set(id, callback);
    },
  });
  window.GunMayhemClock = Object.freeze({ fps, flush: drain, snapshot: state, realNow,
    setReplay(value) { replay = !!value; },
    advance(options) {
      if (!callbacks.size) throw new Error('Ruffle has no queued animation callback');
      if (inCallback) throw new Error('Reentrant simulation tick');
      frame++;
      timestamp = frame * (1000 / fps) + 0.001;
      const info = { frame, timestamp, replay };
      globalThis.RuffleRollback.beforeTick(info);
      if (options && 'render' in options) globalThis.RuffleRollback.setRenderSkipped(!options.render);
      try { drain(); }
      finally { if (options && 'render' in options) globalThis.RuffleRollback.setRenderSkipped(false); }
      globalThis.RuffleRollback.afterTick(info);
      return frame;
    },
  });
})();
