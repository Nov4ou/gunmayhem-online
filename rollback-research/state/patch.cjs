'use strict';

// Deliberately pinned to @ruffle-rs/ruffle 0.6.0's modern wasm-bindgen bundle.
// The original npm files are never overwritten. A test/development server can
// transform them while serving this isolated experiment.
const CORE_FILE = 'core.ruffle.c80159b526e567babaf5.js';
const WASM_FILE = '826bb0938097485a2c9d.wasm';

function replaceExact(source, search, replacement, expected = 1) {
  const count = source.split(search).length - 1;
  if (count !== expected) throw new Error(`Pinned Ruffle patch mismatch: ${search} (${count}, expected ${expected})`);
  return source.split(search).join(replacement);
}

function patchCore(source) {
  source = replaceExact(source, 'e_=e,__=e.exports,Ze=_,',
    'e_=e,__=e.exports,Ze=_,globalThis.RuffleRollback.attach(__),');
  source = replaceExact(source, 'const _=b();',
    'const _=globalThis.RuffleRollback.wrapImports(b());', 2);
  source = replaceExact(source, 'xe.register(r,t,t),r',
    'xe.register(r,t,t),globalThis.RuffleRollback.registerClosure(r,t),r', 2);
  source = replaceExact(source, 'r=(...e)=>{t.cnt++;',
    'r=(...e)=>{if(t.rollbackInvalid)return;t.cnt++;', 2);
  source = replaceExact(source, 'r._wbg_cb_unref=()=>{0===--t.cnt',
    'r._wbg_cb_unref=()=>{if(t.rollbackInvalid)return;0===--t.cnt', 2);
  // A finalizer in a discarded future must never free a restored allocation.
  // Explicit wasm-bindgen drops remain enabled and are rolled back with memory.
  source = replaceExact(source, '"undefined"==typeof FinalizationRegistry', 'true', 7);
  return source;
}

function readUleb(bytes, start) {
  let value = 0, shift = 0, offset = start;
  do {
    const byte = bytes[offset++];
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return { value, offset };
    shift += 7;
  } while (shift < 35);
  throw new Error('Invalid WASM u32 LEB');
}
function uleb(value) {
  const out = [];
  do { const byte = value & 127; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(out);
}
function exportEntry(name, kind, index) {
  const encoded = Buffer.from(name);
  return Buffer.concat([uleb(encoded.length), encoded, Buffer.from([kind]), uleb(index)]);
}
function patchWasm(input) {
  const bytes = Buffer.from(input);
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) throw new Error('Invalid WASM header');
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).some(entry => entry.kind !== 'function')) {
    throw new Error('This snapshot patch requires the pinned module with no imported memory, globals, or tables');
  }
  if (!WebAssembly.Module.exports(module).some(entry => entry.name === '__wbindgen_externrefs')) {
    throw new Error('MVP/JS-heap runtime unsupported; use the pinned modern Ruffle WASM');
  }
  const sections = [];
  let globals = 0, tables = 0;
  for (let offset = 8; offset < bytes.length;) {
    const id = bytes[offset++];
    const size = readUleb(bytes, offset);
    const payload = bytes.subarray(size.offset, size.offset + size.value);
    if (id === 6) globals = readUleb(payload, 0).value;
    if (id === 4) tables = readUleb(payload, 0).value;
    sections.push({ id, payload });
    offset = size.offset + size.value;
  }
  // RuffleHandle::tick inlines Player::render in this release. Insert a branch
  // at the start of its existing render-only block, after Player::tick and
  // before any render locals/allocations. The existing outer block also skips
  // rendering when needs_render is false and rejoins before mutex/Rc cleanup.
  // This avoids an early return from submit_frame, which would leak its owned
  // command list. See the checked-in disassembly notes for the exact boundary.
  const renderGlobal = globals;
  const globalSection = sections.find(section => section.id === 6);
  const globalCount = readUleb(globalSection.payload, 0);
  globalSection.payload = Buffer.concat([
    uleb(globals + 1), globalSection.payload.subarray(globalCount.offset),
    Buffer.from([0x7f, 0x01, 0x41, 0x00, 0x0b]), // mutable i32 initialized to 0
  ]);
  const codeSection = sections.find(section => section.id === 10);
  const codeCount = readUleb(codeSection.payload, 0);
  const marker = Buffer.from('2009202810df0820132d00ea034101470d010b4100211723004190036b22032400', 'hex');
  const newBodies = [];
  let cursor = codeCount.offset, patchedBodies = 0;
  for (let i = 0; i < codeCount.value; i++) {
    const bodySize = readUleb(codeSection.payload, cursor);
    let body = codeSection.payload.subarray(bodySize.offset, bodySize.offset + bodySize.value);
    const found = body.indexOf(marker);
    if (found >= 0) {
      if (body.indexOf(marker, found + 1) >= 0) throw new Error('Ambiguous render block in pinned WASM');
      // Include the inner block's end (0x0b). Inserting before it merely exits
      // that inner block and still falls through into the expensive renderer.
      const insertion = found + 19;
      body = Buffer.concat([body.subarray(0, insertion), Buffer.from([0x23]), uleb(renderGlobal), Buffer.from([0x0d, 0x00]), body.subarray(insertion)]);
      patchedBodies++;
    }
    newBodies.push(uleb(body.length), body);
    cursor = bodySize.offset + bodySize.value;
  }
  if (patchedBodies !== 1) throw new Error(`Pinned Ruffle render boundary mismatch: ${patchedBodies}`);
  codeSection.payload = Buffer.concat([uleb(codeCount.value), ...newBodies]);
  const exportSection = sections.find(section => section.id === 7);
  if (!exportSection) throw new Error('Missing WASM export section');
  const count = readUleb(exportSection.payload, 0);
  const additions = [];
  for (let i = 0; i < globals; i++) additions.push(exportEntry(`__rollback_global_${i}`, 3, i));
  for (let i = 0; i < tables; i++) additions.push(exportEntry(`__rollback_table_${i}`, 1, i));
  additions.push(exportEntry('__rollback_skip_render', 3, renderGlobal));
  exportSection.payload = Buffer.concat([uleb(count.value + additions.length), exportSection.payload.subarray(count.offset), ...additions]);
  return Buffer.concat([bytes.subarray(0, 8), ...sections.flatMap(section => [Buffer.from([section.id]), uleb(section.payload.length), section.payload])]);
}

module.exports = { patchCore, patchWasm, CORE_FILE, WASM_FILE };
