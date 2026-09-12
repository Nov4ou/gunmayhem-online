/* Isolated experiment: whole-instance WASM snapshots for pinned Ruffle 0.6.0. */
(() => {
  'use strict';
  if (globalThis.RuffleRollback) throw new Error('RuffleRollback already installed');
  let wasm = null, busy = false, serial = 0;
  const closures = new Map();
  const participants = new Map();
  const snapshots = new Set();
  const immutableTables = new Map();
  const stats = { captures: 0, restores: 0, captureMs: 0, restoreMs: 0 };
  const wallNow = performance.now.bind(performance);

  function requireIdle() {
    if (!wasm) throw new Error('Patched modern Ruffle WASM has not initialized');
    if (busy) throw new Error('Reentrant rollback operation');
    if (globalThis.GunMayhemClock?.snapshot().inCallback) throw new Error('Snapshots require a completed simulation tick');
  }
  function tables() {
    return Object.entries(wasm).filter(([name, value]) => name.startsWith('__rollback_table_') && value instanceof WebAssembly.Table);
  }
  function globals() {
    return Object.entries(wasm).filter(([name, value]) => name.startsWith('__rollback_global_') && value instanceof WebAssembly.Global);
  }
  function capture() {
    requireIdle();
    busy = true;
    const started = wallNow();
    try {
      const token = {
        id: ++serial,
        memoryBytes: wasm.memory.buffer.byteLength,
        memoryStore: api.memoryStore || null,
        memory: api.memoryStore ? api.memoryStore.capture(wasm.memory) : new Uint8Array(wasm.memory.buffer).slice(),
        tables: tables().map(([name, table]) => immutableTables.get(name) || ({ name, values: Array.from({ length: table.length }, (_, i) => table.get(i)) })),
        globals: globals().map(([name, global]) => [name, global.value]),
        closures: Array.from(closures, ([fn, state]) => ({ fn, state, a: state.a, b: state.b, cnt: state.cnt, invalid: !!state.rollbackInvalid })),
        participants: Array.from(participants, ([name, hooks]) => [name, hooks.capture?.()]),
        released: false,
      };
      snapshots.add(token);
      stats.captures++;
      return token;
    } finally { stats.captureMs += wallNow() - started; busy = false; }
  }
  function restore(token) {
    requireIdle();
    if (!snapshots.has(token) || token.released) throw new Error('Unknown/released rollback snapshot');
    if (wasm.memory.buffer.byteLength !== token.memoryBytes) {
      throw new Error('WASM memory grew across this checkpoint; reserve sufficient memory before the match');
    }
    busy = true;
    const started = wallNow();
    try {
      for (const [name, saved] of token.participants) participants.get(name).beforeRestore?.(saved);
      if (token.memoryStore) token.memoryStore.restore(wasm.memory, token.memory);
      else new Uint8Array(wasm.memory.buffer).set(token.memory);
      for (const [name, value] of token.globals) {
        if (wasm[name].value !== value) wasm[name].value = value;
      }
      for (const entry of token.tables) {
        const table = wasm[entry.name];
        if (entry.immutable) {
          if (table.length !== entry.values.length) throw new Error('The pinned immutable function table changed size');
          continue;
        }
        for (let i = 0; i < entry.values.length; i++) table.set(i, entry.values[i]);
        for (let i = entry.values.length; i < table.length; i++) table.set(i, null);
      }
      // Futures from the discarded branch may still be queued in the browser.
      // Their wrappers become no-ops, preventing calls into reused WASM memory.
      for (const state of closures.values()) state.rollbackInvalid = true;
      for (const saved of token.closures) {
        Object.assign(saved.state, { a: saved.a, b: saved.b, cnt: saved.cnt, rollbackInvalid: saved.invalid });
        closures.set(saved.fn, saved.state);
      }
      for (const [name, saved] of token.participants) participants.get(name).restore?.(saved);
      stats.restores++;
    } finally { stats.restoreMs += wallNow() - started; busy = false; }
  }
  function release(token) {
    if (!snapshots.delete(token)) return;
    for (const [name, saved] of token.participants) participants.get(name).release?.(saved);
    token.memoryStore?.release?.(token.memory);
    token.released = true;
    token.memory = null;
    token.tables = token.closures = token.participants = null;
    // Live callbacks and snapshots retain their respective state; discarded
    // callback wrappers can be garbage collected once browser queues drop them.
    const retained = new Set();
    for (const active of snapshots) for (const saved of active.closures) retained.add(saved.fn);
    for (const [fn, state] of closures) if ((state.rollbackInvalid || state.cnt === 0) && !retained.has(fn)) closures.delete(fn);
  }
  const api = {
    attach(exports) {
      if (wasm && wasm !== exports) throw new Error('Only one Ruffle instance/module is supported in this isolated realm');
      if (!(exports.__wbindgen_externrefs instanceof WebAssembly.Table)) throw new Error('Modern externref Ruffle build required');
      if (!Object.keys(exports).some(key => key.startsWith('__rollback_global_'))) throw new Error('WASM globals were not exported by patchWasm');
      wasm = exports;
      // Complete disassembly of this pinned module has table.set/grow only for
      // table 1 (externrefs). The indirect function table is immutable after its
      // active element initialization, and the original JS glue cannot reach it.
      // Retain it once instead of ~10,000 get/set calls per checkpoint.
      for (const [name, table] of tables()) if (table !== wasm.__wbindgen_externrefs) {
        immutableTables.set(name, { name, immutable: true, values: Array.from({ length: table.length }, (_, i) => table.get(i)) });
      }
    },
    reserveMemory(megabytes = 192) {
      requireIdle();
      if (snapshots.size) throw new Error('Reserve memory before creating snapshots');
      // Growing WebAssembly.Memory directly bypasses dlmalloc's free lists and
      // does not reserve usable allocator capacity. Allocate and free a large
      // block through Rust instead, so future game objects can reuse it.
      const reserveBytes = Math.ceil(megabytes * 1024 * 1024 - wasm.memory.buffer.byteLength);
      if (reserveBytes > 0) {
        const ptr = wasm.__wbindgen_malloc(reserveBytes, 8) >>> 0;
        if (!ptr) throw new Error('Unable to reserve rollback allocator capacity');
        wasm.__wbindgen_free(ptr, reserveBytes, 8);
      }
      return wasm.memory.buffer.byteLength;
    },
    registerClosure(fn, state) { closures.set(fn, state); },
    setRenderSkipped(value) {
      if (!wasm?.__rollback_skip_render) throw new Error('The pinned render-block patch is unavailable');
      wasm.__rollback_skip_render.value = value ? 1 : 0;
    },
    canSkipRender() { return !!wasm?.__rollback_skip_render; },
    registerParticipant(name, hooks) {
      if (snapshots.size || participants.has(name)) throw new Error('Register each participant once, before the first snapshot');
      participants.set(name, hooks);
    },
    wrapImports(imports) { return typeof api.importWrapper === 'function' ? api.importWrapper(imports) : imports; },
    beforeTick(info) { for (const hooks of participants.values()) hooks.beforeTick?.(info); },
    afterTick(info) { for (const hooks of participants.values()) hooks.afterTick?.(info); },
    capture, restore, release,
    inspect() {
      return { initialized: !!wasm, memoryBytes: wasm?.memory.buffer.byteLength ?? 0,
        tables: wasm ? tables().map(([name, table]) => ({ name, length: table.length })) : [],
        globals: wasm ? globals().map(([name, global]) => ({ name, value: String(global.value) })) : [],
        closures: closures.size, snapshots: snapshots.size, participants: [...participants.keys()], stats: { ...stats } };
    },
    inspectExternrefs() {
      requireIdle();
      const counts = new Map(), mutableWrappers = [];
      const table = wasm.__wbindgen_externrefs;
      for (let i = 0; i < table.length; i++) {
        const value = table.get(i);
        const name = value == null ? String(value) : typeof value === 'function' ? 'Function' : value.constructor?.name || typeof value;
        counts.set(name, (counts.get(name) || 0) + 1);
        if (value && (typeof value === 'object' || typeof value === 'function') && Object.hasOwn(value, '__wbg_ptr')) {
          mutableWrappers.push({ index: i, type: name, pointer: value.__wbg_ptr });
        }
      }
      return { types: Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])), mutableWrappers };
    },
  };
  globalThis.RuffleRollback = api;
})();
