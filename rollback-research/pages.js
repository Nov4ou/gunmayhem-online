/* Persistent pages keep the full WASM image, including allocator and GC state.
 * The SIMD helper compares bytes exactly; hashes are never used as equality.
 */
(() => {
  'use strict';
  const api = RuffleRollback;
  let helper, length = 0, currentOffset, previousOffset, indicesOffset, pages;
  const stats = { captures: 0, changedPages: 0, maximumChangedPages: 0, copiedBytes: 0 };
  const ready = (async () => {
    const url = new URL('./pages.wasm', document.currentScript.src);
    helper = (await WebAssembly.instantiate(await (await fetch(url)).arrayBuffer(), {})).instance.exports;
  })();
  api.pagesReady = ready;
  api.memoryStore = {
    capture(memory) {
      if (!helper) throw new Error('Await RuffleRollback.pagesReady before capture');
      if (length !== memory.buffer.byteLength) {
        length = memory.buffer.byteLength;
        currentOffset = Math.ceil(Number(helper.__heap_base.value) / 65536) * 65536;
        previousOffset = currentOffset + length;
        indicesOffset = previousOffset + length;
        const capacity = indicesOffset + (length / 4096) * 4;
        const grow = Math.ceil((capacity - helper.memory.buffer.byteLength) / 65536);
        if (grow > 0) helper.memory.grow(grow);
        pages = null;
      }
      const incoming = new Uint8Array(memory.buffer);
      const heap = new Uint8Array(helper.memory.buffer);
      heap.set(incoming, currentOffset);
      if (!pages) {
        pages = Array.from({length: length / 4096}, (_, i) => incoming.slice(i * 4096, (i + 1) * 4096));
        heap.set(incoming, previousOffset);
        stats.copiedBytes += length;
      } else {
        const count = helper.changed_pages(currentOffset, previousOffset, length, indicesOffset);
        const indices = new Uint32Array(helper.memory.buffer, indicesOffset, count);
        pages = pages.slice();
        for (const index of indices) pages[index] = incoming.slice(index * 4096, (index + 1) * 4096);
        stats.changedPages += count;
        stats.maximumChangedPages = Math.max(stats.maximumChangedPages, count);
        stats.copiedBytes += count * 4096;
      }
      stats.captures++;
      return { length, pages };
    },
    restore(memory, token) {
      if (memory.buffer.byteLength !== token.length) throw new Error('Checkpoint memory size mismatch');
      const target = new Uint8Array(memory.buffer);
      for (let i = 0; i < token.pages.length; i++) target.set(token.pages[i], i * 4096);
      // The comparison image intentionally stays at the last capture. The next
      // comparison detects both the restored past and the newly replayed future.
    },
    release(token) { token.pages = null; },
    inspect: () => ({ ...stats, length, helperBytes: helper?.memory.buffer.byteLength || 0 }),
  };
})();
