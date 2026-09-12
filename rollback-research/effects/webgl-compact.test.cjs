'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class GL {
  constructor() {
    Object.assign(this, { ARRAY_BUFFER: 0x8892, ELEMENT_ARRAY_BUFFER: 0x8893, FRAMEBUFFER: 0x8d40,
      READ_FRAMEBUFFER: 0x8ca8, DRAW_FRAMEBUFFER: 0x8ca9, RENDERBUFFER: 0x8d41,
      TEXTURE0: 0x84c0, TEXTURE_2D: 0x0de1, RGBA: 0x1908, RGBA8: 0x8058, UNSIGNED_BYTE: 0x1401,
      UNPACK_ALIGNMENT: 0x0cf5, UNPACK_ROW_LENGTH: 0x0cf2, UNPACK_SKIP_PIXELS: 0x0cf4,
      UNPACK_SKIP_ROWS: 0x0cf3, UNPACK_FLIP_Y_WEBGL: 0x9240, UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
      drawingBufferWidth: 900, drawingBufferHeight: 600 });
    this.bufferContents = new Map(); this.bindings = new Map(); this.uniforms = new Map();
    this.deleted = new Set(); this.program = null; this.caps = new Set(); this.texture = null;
    this.textureContents = new Map(); this.textureSizes = new Map();
  }
  getParameter() {}
  createShader() { return {}; }
  createProgram() { return {}; }
  createVertexArray() { return {}; }
  bindVertexArray() {}
  createBuffer() { const buffer = {}; this.bufferContents.set(buffer, []); return buffer; }
  deleteBuffer(buffer) { this.deleted.add(buffer); }
  bindBuffer(target, buffer) { assert(!this.deleted.has(buffer)); this.bindings.set(target, buffer); }
  bufferData(target, bytes) { this.bufferContents.set(this.bindings.get(target), typeof bytes === 'number' ? new Array(bytes).fill(0) : Array.from(bytes)); }
  bufferSubData(target, offset, bytes) { this.bufferContents.get(this.bindings.get(target)).splice(offset, bytes.length, ...bytes); }
  copyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size) {
    const values = this.bufferContents.get(this.bindings.get(readTarget)).slice(readOffset, readOffset + size);
    this.bufferContents.get(this.bindings.get(writeTarget)).splice(writeOffset, size, ...values);
  }
  useProgram(program) { this.program = program; }
  uniform1f(location, value) { this.uniforms.set(location, value); }
  enable(cap) { this.caps.add(cap); }
  disable(cap) { this.caps.delete(cap); }
  bindFramebuffer() {} bindRenderbuffer() {} activeTexture() {} pixelStorei() {}
  createTexture() { return {}; }
  bindTexture(target, texture) { this.texture = texture; }
  texStorage2D(target, levels, format, width, height) {
    this.textureSizes.set(this.texture, [width, height]); this.textureContents.set(this.texture, new Uint8Array(width * height * 4));
  }
  texImage2D(target, level, internalFormat, width, height, border, format, type, bytes) {
    this.textureSizes.set(this.texture, [width, height]); this.textureContents.set(this.texture, bytes.slice());
  }
  texSubImage2D(target, level, x, y, width, height, format, type, bytes) {
    const [w] = this.textureSizes.get(this.texture), pixels = this.textureContents.get(this.texture);
    for (let row = 0; row < height; row++) pixels.set(bytes.subarray(row * width * 4, (row + 1) * width * 4), ((row + y) * w + x) * 4);
  }
  readPixels() {}
}

function fixture() {
  const participants = new Map();
  const env = { RuffleRollback: { registerParticipant(name, hooks) { participants.set(name, hooks); } } };
  env.window = env;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/webgl-compact.js`, 'utf8'), env);
  const effects = participants.get('webgl'), gl = new GL();
  env.RuffleRollbackGL.observe(gl);
  return { effects, gl, diagnostics: env.RuffleRollbackGL.diagnostics };
}

{
  const { gl, effects, diagnostics } = fixture();
  const buffer = gl.createBuffer(), program = gl.createProgram(), location = {};
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([1, 2, 3, 4]), 0x88e8);
  gl.useProgram(program); gl.uniform1f(location, 4);
  const token = effects.capture();
  gl.bufferSubData(gl.ARRAY_BUFFER, 1, new Uint8Array([8, 9])); gl.uniform1f(location, 12); gl.enable(123);
  gl.deleteBuffer(buffer);
  const future = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, future); gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([9]), 0x88e8);
  effects.beforeRestore(token); effects.restore(token);
  assert.deepEqual(gl.bufferContents.get(buffer), [1, 2, 3, 4]);
  assert.equal(gl.bindings.get(gl.ARRAY_BUFFER), buffer); assert.equal(gl.uniforms.get(location), 4); assert(!gl.caps.has(123));
  effects.release(token);
  assert(!gl.deleted.has(buffer)); assert(gl.deleted.has(future));
  const initialEntries = diagnostics().stateEntries;
  for (let i = 0; i < 100; i++) {
    const saved = effects.capture(); gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array([i])); gl.uniform1f(location, i);
    effects.restore(saved); effects.release(saved);
  }
  assert.equal(diagnostics().stateEntries, initialEntries, 'State history must not grow by frame');
  assert.equal(diagnostics().resources, 2, 'Abandoned resources do not accumulate');
  assert.equal(diagnostics().bytes, 4);
  const other = gl.createBuffer(); gl.bindBuffer(0x8f36, buffer); gl.bindBuffer(0x8f37, other);
  gl.bufferData(0x8f37, 4, 0x88e8); gl.copyBufferSubData(0x8f36, 0x8f37, 0, 1, 3);
  const copied = effects.capture(); gl.bufferSubData(0x8f37, 0, new Uint8Array([9, 9, 9, 9]));
  effects.restore(copied); effects.release(copied);
  assert.deepEqual(gl.bufferContents.get(other), [0, 1, 2, 3], 'GPU buffer copies have restorable CPU mirrors');
  const guard = effects.capture(); gl.readPixels();
  assert.throws(() => effects.beforeRestore(guard), /Unsupported GPU mutation/);
}

{
  const { gl, effects, diagnostics } = fixture();
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 2, 2);
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  const token = effects.capture();
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 1, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([99, 98, 97, 96]));
  assert.equal(gl.textureContents.get(texture)[4], 99);
  effects.beforeRestore(token); effects.restore(token); effects.release(token);
  assert.deepEqual(Array.from(gl.textureContents.get(texture)), Array.from(bytes));
  assert.equal(diagnostics().bytes, 16);
  assert.equal(diagnostics().unsupported.length, 0);
}

{
  const { gl, effects } = fixture();
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([1, 2]), 0x88e8);
  const older = effects.capture();
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array([3, 4]));
  const newer = effects.capture();
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array([5, 6]));
  gl.deleteBuffer(buffer); gl.bindBuffer(gl.ARRAY_BUFFER, null);
  effects.beforeTick({ frame: 4 }); effects.afterTick();
  assert(!gl.deleted.has(buffer), 'Old overlapping checkpoints retain deleted native handles');
  effects.restore(newer); effects.release(newer);
  assert.deepEqual(gl.bufferContents.get(buffer), [3, 4]);
  effects.restore(older); effects.release(older);
  assert.deepEqual(gl.bufferContents.get(buffer), [1, 2]);
  assert(!gl.deleted.has(buffer));
}

{
  const { gl, effects } = fixture();
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([1, 2]), 0x88e8);
  gl.deleteBuffer(buffer);
  const deletedWhileBound = effects.capture();
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  const collector = effects.capture(); effects.release(collector);
  assert(!gl.deleted.has(buffer), 'Checkpoint bindings retain delete-pending native handles');
  effects.restore(deletedWhileBound);
  assert.equal(gl.bindings.get(gl.ARRAY_BUFFER), buffer, 'Restore can rebind a delete-pending resource');
  effects.release(deletedWhileBound);
}
process.stdout.write('PASS: compact driver state, COW buffer/texture snapshots, future resource cleanup, bounded 100-rollback storage, unsupported mutation guard\n');
