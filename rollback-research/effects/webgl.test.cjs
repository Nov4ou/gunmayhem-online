'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class GL {
  constructor() {
    this.ARRAY_BUFFER = 1; this.FRAMEBUFFER = 2; this.RENDERBUFFER = 3;
    this.TEXTURE0 = 4; this.TEXTURE_2D = 5;
    this.buffers = new Map(); this.bindings = new Map(); this.uniforms = new Map();
    this.deleted = new Set(); this.program = null; this.caps = new Set();
  }
  getParameter() {}
  createShader() { return {}; }
  createBuffer() { const buffer = {}; this.buffers.set(buffer, []); return buffer; }
  deleteBuffer(buffer) { this.deleted.add(buffer); }
  bindBuffer(target, buffer) { assert(!this.deleted.has(buffer)); this.bindings.set(target, buffer); }
  bufferData(target, bytes) { this.buffers.set(this.bindings.get(target), Array.from(bytes)); }
  useProgram(program) { this.program = program; }
  uniform1f(location, value) { this.uniforms.set(location, value); }
  enable(cap) { this.caps.add(cap); }
  disable(cap) { this.caps.delete(cap); }
  bindFramebuffer() {} bindRenderbuffer() {} activeTexture() {} bindTexture() {}
  readPixels() {}
}

const participants = new Map();
const env = { RuffleRollback: {
  registerParticipant(name, participant) { participants.set(name, participant); },
} };
env.window = env;
vm.runInNewContext(fs.readFileSync(`${__dirname}/webgl.js`, 'utf8'), env);
const effects = participants.get('webgl');
const gl = new GL();
env.RuffleRollbackGL.observe(gl);
const buffer = gl.createBuffer();
const program = {};
const location = {};
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
const sourceBytes = new Uint8Array([1, 2, 3]);
gl.bufferData(gl.ARRAY_BUFFER, sourceBytes);
gl.useProgram(program);
gl.uniform1f(location, 4);
const token = effects.capture();
sourceBytes.fill(99);
gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([8, 8, 8]));
gl.uniform1f(location, 12);
gl.enable(123);
gl.deleteBuffer(buffer);
assert(!gl.deleted.has(buffer), 'Deletion must wait for snapshots');
const future = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, future);
gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array([9]));
effects.beforeRestore(token);
effects.restore(token);
assert.deepEqual(gl.buffers.get(buffer), [1, 2, 3], 'Upload bytes must be copied and restored');
assert.equal(gl.bindings.get(gl.ARRAY_BUFFER), buffer, 'Driver binding restored');
assert.equal(gl.program, program);
assert.equal(gl.uniforms.get(location), 4, 'Driver uniform restored');
assert(!gl.caps.has(123), 'Future-only capability reset');
effects.release(token);
assert(!gl.deleted.has(buffer), 'Restored active resource cannot be deleted');
assert(gl.deleted.has(future), 'Abandoned future resource is collected');
const guard = effects.capture();
gl.readPixels();
assert.throws(() => effects.beforeRestore(guard), /readback/);
process.stdout.write('PASS: deferred deletes, driver binding/uniform restoration, upload copies, future cleanup, readback guard\n');
