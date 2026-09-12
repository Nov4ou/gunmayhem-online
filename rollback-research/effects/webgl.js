/* Research correctness baseline, NOT a production-performance renderer.
 * Keeps GL resources alive across snapshots and restores driver state/uploads
 * by replaying recorded commands. Draws are omitted: the next Ruffle frame must
 * clear and redraw its render targets. GPU -> game readback is unsupported.
 * Compatible with the pinned modern externref Ruffle build only.
 */
(() => {
  'use strict';
  const root = typeof window === 'undefined' ? globalThis : window;
  const rollback = root.RuffleRollback;
  if (!rollback) throw new Error('Load RuffleRollback before rollback WebGL');
  const contexts = new Map();
  const tokens = new Set();
  let restoring = false, frame = 0, serial = 0, readbackSerial = 0;
  const stats = { contexts: 0, commands: 0, restores: 0, replayed: 0, deferredDeletes: 0 };
  const methodCounts = new Map();
  const createPattern = /^create(Buffer|Texture|Framebuffer|Renderbuffer|VertexArray|Program|Shader|Sampler|Query|TransformFeedback)$/;
  const deletePattern = /^delete(Buffer|Texture|Framebuffer|Renderbuffer|VertexArray|Program|Shader|Sampler|Query|TransformFeedback|Sync)$/;
  // Shader linking and immutable texStorage allocation must NOT be replayed:
  // relinking invalidates existing WebGLUniformLocation objects, and texStorage
  // may only allocate once. Pinned Ruffle does those at resource construction.
  const recordPattern = /^(activeTexture|bindBuffer|bindBufferBase|bindBufferRange|bindFramebuffer|bindRenderbuffer|bindSampler|bindTexture|bindTransformFeedback|bindVertexArray|blendColor|blendEquation|blendEquationSeparate|blendFunc|blendFuncSeparate|bufferData|bufferSubData|clearColor|clearDepth|clearStencil|colorMask|compressedTexImage2D|compressedTexImage3D|compressedTexSubImage2D|compressedTexSubImage3D|cullFace|depthFunc|depthMask|depthRange|disable|disableVertexAttribArray|drawBuffers|enable|enableVertexAttribArray|framebufferRenderbuffer|framebufferTexture2D|framebufferTextureLayer|frontFace|generateMipmap|hint|lineWidth|pixelStorei|polygonOffset|readBuffer|renderbufferStorage|renderbufferStorageMultisample|sampleCoverage|samplerParameterf|samplerParameteri|scissor|stencilFunc|stencilFuncSeparate|stencilMask|stencilMaskSeparate|stencilOp|stencilOpSeparate|texImage2D|texImage3D|texParameterf|texParameteri|texSubImage2D|texSubImage3D|uniform.*|useProgram|vertexAttrib.*|viewport)$/;
  const readbackPattern = /^(readPixels|getBufferSubData|copyTexImage2D|copyTexSubImage2D|copyTexSubImage3D|copyBufferSubData)$/;

  function cloned(value) {
    if (ArrayBuffer.isView(value)) {
      if (value instanceof DataView) return new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      return value.slice();
    }
    if (Array.isArray(value)) return value.map(cloned);
    if (value instanceof ArrayBuffer) return value.slice(0);
    return value;
  }

  function defer(state, method, resource) {
    if (!resource) return;
    state.deleted.set(resource, { method, resource, serial: ++serial, frame });
    stats.deferredDeletes++;
  }

  function collect() {
    // An actual delete invalidates all historical object references forever.
    // Keep any object retained by any live token, regardless of frame numbering.
    const retained = new Set();
    for (const token of tokens) for (const saved of token.contexts.values()) {
      for (const resource of saved.resources) retained.add(resource);
    }
    // This baseline retains full state history. Historical commands may still
    // reference an otherwise deleted handle, so it must remain valid too.
    // A production adapter needs per-resource version compaction instead.
    for (const state of contexts.values()) for (const command of state.commands) {
      for (const arg of command.args) if (state.resources.has(arg)) retained.add(arg);
    }
    for (const state of contexts.values()) {
      for (const [resource, entry] of state.deleted) {
        if (!retained.has(resource)) {
          state.native.get(entry.method)?.(resource);
          state.deleted.delete(resource);
          state.resources.delete(resource);
        }
      }
    }
  }

  function observe(gl) {
    if (contexts.has(gl)) return;
    if (!gl || typeof gl.getParameter !== 'function' || typeof gl.createShader !== 'function') return;
    const state = { gl, native: new Map(), commands: [], resources: new Map(), deleted: new Map(),
      enabledCaps: new Set(), textureUnits: new Set(), bufferTargets: new Set() };
    contexts.set(gl, state); stats.contexts++;
    const names = new Set();
    for (let proto = gl; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    }
    for (const name of names) {
      if (typeof gl[name] !== 'function') continue;
      if (!createPattern.test(name) && !deletePattern.test(name) && !recordPattern.test(name) && !readbackPattern.test(name)) continue;
      const native = gl[name].bind(gl);
      state.native.set(name, native);
      gl[name] = (...args) => {
        if (restoring) return native(...args);
        methodCounts.set(name, (methodCounts.get(name) || 0) + 1);
        if (deletePattern.test(name)) { defer(state, name, args[0]); return; }
        if (createPattern.test(name)) {
          const resource = native(...args);
          if (resource) state.resources.set(resource, `delete${name.slice(6)}`);
          return resource;
        }
        if (readbackPattern.test(name)) {
          readbackSerial++;
          return native(...args);
        }
        if (name === 'enable') state.enabledCaps.add(args[0]);
        if (name === 'activeTexture') state.textureUnits.add(args[0]);
        if (name === 'bindBuffer') state.bufferTargets.add(args[0]);
        const result = native(...args);
        state.commands.push({ name, args: args.map(cloned) }); stats.commands++;
        return result;
      };
    }
  }

  function resetTouchedBindings(state) {
    const { gl, native } = state;
    for (const cap of state.enabledCaps) native.get('disable')?.(cap);
    native.get('useProgram')?.(null);
    native.get('bindVertexArray')?.(null);
    for (const target of state.bufferTargets) native.get('bindBuffer')?.(target, null);
    for (const unit of state.textureUnits) {
      native.get('activeTexture')?.(unit);
      for (const name of ['TEXTURE_2D', 'TEXTURE_CUBE_MAP', 'TEXTURE_3D', 'TEXTURE_2D_ARRAY']) {
        if (typeof gl[name] === 'number') native.get('bindTexture')?.(gl[name], null);
      }
    }
    if (typeof gl.TEXTURE0 === 'number') native.get('activeTexture')?.(gl.TEXTURE0);
    native.get('bindFramebuffer')?.(gl.FRAMEBUFFER, null);
    native.get('bindRenderbuffer')?.(gl.RENDERBUFFER, null);
  }

  const participant = {
    beforeTick(tick) { frame = tick.frame; },
    capture() {
      const token = { frame, serial, readbackSerial, contexts: new Map() };
      for (const [gl, state] of contexts) token.contexts.set(gl, {
        // Records and typed-array payloads are immutable; copies share them safely.
        commands: state.commands.slice(), resources: new Set(state.resources.keys()),
        deleted: new Map(state.deleted),
      });
      tokens.add(token);
      return token;
    },
    beforeRestore(token) {
      if (readbackSerial !== token.readbackSerial) {
        throw new Error('Rollback GL research adapter cannot restore GPU readback/copy effects');
      }
    },
    restore(token) {
      restoring = true;
      try {
        for (const [gl, saved] of token.contexts) {
          const state = contexts.get(gl);
          // Future resources cannot be returned to the restored WASM. Retain
          // them only if a later live token still refers to their native handle.
          state.deleted = new Map(saved.deleted);
          for (const [resource, method] of state.resources) {
            if (!saved.resources.has(resource)) defer(state, method, resource);
          }
          resetTouchedBindings(state);
          for (const command of saved.commands) {
            state.native.get(command.name)(...command.args);
            stats.replayed++;
          }
          state.commands = saved.commands.slice();
        }
        frame = token.frame; readbackSerial = token.readbackSerial;
        stats.restores++;
      } finally { restoring = false; }
    },
    release(token) { tokens.delete(token); collect(); },
  };

  const previousWrapper = rollback.importWrapper;
  rollback.importWrapper = imports => {
    imports = previousWrapper ? previousWrapper(imports) : imports;
    for (const module of Object.values(imports)) for (const [name, original] of Object.entries(module)) {
      if (!name.startsWith('__wbg_') || typeof original !== 'function') continue;
      module[name] = function (...args) {
        // Modern externref imports expose actual contexts, not integer heap ids.
        observe(args[0]);
        return original.apply(this, args);
      };
    }
    return imports;
  };
  rollback.registerParticipant('webgl', participant);
  root.RuffleRollbackGL = { diagnostics: () => ({ ...stats, tokens: tokens.size,
    pendingDeletes: Array.from(contexts.values()).reduce((n, state) => n + state.deleted.size, 0),
    retainedCommands: Array.from(contexts.values()).reduce((n, state) => n + state.commands.length, 0),
    readbackSerial, methodCounts: Object.fromEntries(methodCounts) }), observe };
})();
