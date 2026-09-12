/* Pinned WebGL2 rollback experiment. No frame history is retained: snapshots
 * share immutable resource versions and latest driver-state values. Original
 * WebGL objects remain alive until no checkpoint can restore them.
 * Render-target pixels are rebuilt by the next complete Ruffle render pass.
 * GPU readback and unsupported resource writes reject restoration explicitly.
 */
(() => {
  'use strict';
  const root = typeof window === 'undefined' ? globalThis : window;
  const rollback = root.RuffleRollback;
  if (!rollback) throw new Error('Load RuffleRollback before compact WebGL');
  const contexts = new Map(), tokens = new Set(), ids = new WeakMap(), freeResourceTables = [];
  let nextId = 0, restoring = false, generation = 0, frame = 0, collectGeneration = 0, restoreGeneration = 0;
  const metrics = { restores: 0, uploads: 0, restoredUploads: 0, deleted: 0, unsupported: [] };
  const wallNow = root.GunMayhemClock?.realNow || root.performance?.now.bind(root.performance) || (() => 0);
  const timings = { captureMs: 0, restoreMs: 0, collectMs: 0, restoredBytes: 0, nativeCalls: 0, resourceTableAllocations: 0 };
  const counts = new Map();
  const creations = /^create(Buffer|Texture|Framebuffer|Renderbuffer|VertexArray|Program|Shader|Sampler|Query|TransformFeedback)$/;
  const deletions = /^delete(Buffer|Texture|Framebuffer|Renderbuffer|VertexArray|Program|Shader|Sampler|Query|TransformFeedback|Sync)$/;
  const harmless = /^(get|is|check|drawArrays|drawElements|clear$|clearBuffer|blitFramebuffer|flush$|finish$|fenceSync$|clientWaitSync$|waitSync$|create|delete|compileShader$|shaderSource$|attachShader$|detachShader$|linkProgram$|validateProgram$|bindAttribLocation$)/;
  const mutations = /^(activeTexture|attach|begin|bind|blend|buffer|clear|color|compile|compressed|copy|cull|depth|detach|disable|draw|enable|end|framebuffer|front|generate|hint|invalidate|line|link|pause|pixel|polygon|read|renderbuffer|resume|sample|sampler|scissor|shader|stencil|tex|transform|uniform|use|vertex|viewport)/;

  function id(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object' && typeof value !== 'function') return String(value);
    if (!ids.has(value)) ids.set(value, ++nextId);
    return ids.get(value);
  }
  function clone(value) {
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    if (Array.isArray(value)) return value.slice();
    return value;
  }
  function typedClone(value) {
    if (ArrayBuffer.isView(value) && typeof value.slice === 'function') return value.slice();
    return clone(value);
  }
  function operation(name, args, setup = [], owner = null) {
    return { name, args: args.map(typedClone), setup, owner };
  }
  function reject(state, name) {
    state.barrier++;
    if (!metrics.unsupported.includes(name)) metrics.unsupported.push(name);
  }
  function record(state, key, op, initial = null, binding = false) {
    const map = binding ? state.bindings : state.values;
    if (!state.defaults.has(key)) state.defaults.set(key, initial);
    map.set(key, op);
  }
  function resourceVersion(state, resource) {
    if (!resource) throw new Error('GPU write without a bound resource');
    const info = state.resources.get(resource);
    if (!info) throw new Error('GPU resource predates rollback instrumentation');
    if (info.version.generation !== generation) {
      info.version = { ...info.version, generation, images: new Map(info.version.images),
        operations: new Map(info.version.operations), bytes: info.version.bytes?.slice() };
    }
    return info.version;
  }
  function byteView(value, offset = 0, length) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value, offset, length);
    if (!ArrayBuffer.isView(value)) return null;
    const size = value.BYTES_PER_ELEMENT || 1;
    const byteLength = length === undefined ? value.byteLength - offset * size : length * size;
    return new Uint8Array(value.buffer, value.byteOffset + offset * size, byteLength);
  }
  function boundTexture(state, target) {
    const bindingTarget = target >= 0x8515 && target <= 0x851a ? 0x8513 : target;
    return state.textures.get(`${state.activeUnit}:${bindingTarget}`) || null;
  }
  function unpack(state, bytes, width, height, pixelBytes) {
    if (!bytes) return null;
    const gl = state.gl;
    if (state.pixel.get(gl.UNPACK_FLIP_Y_WEBGL) || state.pixel.get(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL)) return null;
    const alignment = state.pixel.get(gl.UNPACK_ALIGNMENT) ?? 4;
    const rowPixels = state.pixel.get(gl.UNPACK_ROW_LENGTH) || width;
    const rowBytes = Math.ceil(rowPixels * pixelBytes / alignment) * alignment;
    const skip = (state.pixel.get(gl.UNPACK_SKIP_ROWS) || 0) * rowBytes +
      (state.pixel.get(gl.UNPACK_SKIP_PIXELS) || 0) * pixelBytes;
    if (skip + Math.max(0, height - 1) * rowBytes + width * pixelBytes > bytes.byteLength) return null;
    const result = new Uint8Array(width * height * pixelBytes);
    for (let row = 0; row < height; row++) result.set(bytes.subarray(skip + row * rowBytes,
      skip + row * rowBytes + width * pixelBytes), row * width * pixelBytes);
    return result;
  }
  function pixelBytes(format, type) {
    const channels = { 0x1903: 1, 0x8227: 2, 0x1907: 3, 0x1908: 4, 0x1906: 1, 0x1909: 1, 0x190a: 2 }[format];
    const size = { 0x1401: 1, 0x1400: 1, 0x1403: 2, 0x1402: 2, 0x140b: 2, 0x1405: 4, 0x1404: 4, 0x1406: 4 }[type];
    return channels && size ? channels * size : 0;
  }
  function storageFormat(format) {
    return { 0x8058: [0x1908, 0x1401], 0x8c43: [0x1908, 0x1401],
      0x8229: [0x1903, 0x1401], 0x822b: [0x8227, 0x1401],
      0x881a: [0x1908, 0x140b], 0x8814: [0x1908, 0x1406],
    }[format];
  }
  function parameterDefault(pname) {
    return { 0x2800: 0x2601, 0x2801: 0x2702, 0x2802: 0x2901, 0x2803: 0x2901,
      0x8072: 0x2901, 0x813a: -1000, 0x813b: 1000, 0x813c: 0, 0x813d: 1000,
      0x884c: 0, 0x884d: 0x0203, 0x84fe: 1,
    }[pname];
  }
  function setupTexture(state, resource, target) {
    return [['activeTexture', [state.gl.TEXTURE0]], ['bindTexture', [target, resource]]];
  }
  function uploadTexture(state, name, args) {
    const gl = state.gl, [target, level] = args;
    const resource = boundTexture(state, target), version = resourceVersion(state, resource);
    if (name === 'texStorage2D') {
      version.storage = args.slice();
      return;
    }
    const key = `${target}:${level}`;
    if (name === 'texImage2D') {
      if (args.length < 9) return reject(state, 'texImage2D DOM source');
      const [, , internalFormat, width, height, border, format, type, input, offset = 0] = args;
      const bpp = pixelBytes(format, type);
      const bytes = input == null ? new Uint8Array(width * height * bpp) : unpack(state, byteView(input, offset), width, height, bpp);
      if (!bpp || !bytes) return reject(state, 'texImage2D unsupported format/unpack');
      version.images.set(key, { target, level, internalFormat, width, height, border, format, type, bytes });
    } else {
      const [, , x, y, width, height, format, type, input, offset = 0] = args;
      const bpp = pixelBytes(format, type), patch = unpack(state, byteView(input, offset), width, height, bpp);
      if (!bpp || !patch) return reject(state, 'texSubImage2D unsupported source/format/unpack');
      let image = version.images.get(key);
      if (!image && version.storage) {
        const [, , internalFormat, storageWidth, storageHeight] = version.storage;
        const expected = storageFormat(internalFormat);
        if (!expected || expected[0] !== format || expected[1] !== type) return reject(state, 'texStorage2D unhandled pixel format');
        const w = Math.max(1, storageWidth >> level), h = Math.max(1, storageHeight >> level);
        image = { target, level, internalFormat, width: w, height: h, border: 0, format, type, bytes: new Uint8Array(w * h * bpp), immutable: true };
      }
      if (!image || image.format !== format || image.type !== type || x + width > image.width || y + height > image.height) return reject(state, 'texSubImage2D missing/incompatible base');
      image = { ...image, bytes: image.bytes.slice() };
      for (let row = 0; row < height; row++) image.bytes.set(patch.subarray(row * width * bpp, (row + 1) * width * bpp), ((y + row) * image.width + x) * bpp);
      version.images.set(key, image);
    }
    metrics.uploads++;
  }

  function stateOperation(state, name, args) {
    const gl = state.gl;
    const simple = {
      blendColor: [0, 0, 0, 0], clearColor: [0, 0, 0, 0], clearDepth: [1], clearStencil: [0],
      colorMask: [true, true, true, true], cullFace: [gl.BACK], depthFunc: [gl.LESS], depthMask: [true],
      depthRange: [0, 1], frontFace: [gl.CCW], lineWidth: [1], polygonOffset: [0, 0],
      sampleCoverage: [1, false], scissor: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
      viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
    };
    if (name in simple) { record(state, name, operation(name, args), operation(name, simple[name])); return true; }
    if (name === 'enable' || name === 'disable') {
      record(state, `cap:${args[0]}`, operation(name, args), operation(args[0] === gl.DITHER ? 'enable' : 'disable', args)); return true;
    }
    if (name === 'blendFunc' || name === 'blendFuncSeparate') {
      record(state, 'blendFunc', operation('blendFuncSeparate', name === 'blendFunc' ? [...args, ...args] : args), operation('blendFuncSeparate', [gl.ONE, gl.ZERO, gl.ONE, gl.ZERO])); return true;
    }
    if (name === 'blendEquation' || name === 'blendEquationSeparate') {
      record(state, 'blendEquation', operation('blendEquationSeparate', name === 'blendEquation' ? [args[0], args[0]] : args), operation('blendEquationSeparate', [gl.FUNC_ADD, gl.FUNC_ADD])); return true;
    }
    if (name === 'pixelStorei') {
      state.pixel.set(args[0], args[1]);
      const initial = args[0] === gl.UNPACK_ALIGNMENT || args[0] === gl.PACK_ALIGNMENT ? 4 : args[0] === gl.UNPACK_COLORSPACE_CONVERSION_WEBGL ? gl.BROWSER_DEFAULT_WEBGL : 0;
      record(state, `pixel:${args[0]}`, operation(name, args), operation(name, [args[0], initial])); return true;
    }
    if (name === 'hint') { record(state, `hint:${args[0]}`, operation(name, args), operation(name, [args[0], gl.DONT_CARE])); return true; }
    if (/^stencil(Func|Mask|Op)(Separate)?$/.test(name)) {
      const separate = name.endsWith('Separate'), base = separate ? name.slice(0, -8) : name;
      const face = separate ? args[0] : gl.FRONT_AND_BACK, values = separate ? args.slice(1) : args;
      const defaults = base === 'stencilFunc' ? [gl.ALWAYS, 0, 0xffffffff] : base === 'stencilMask' ? [0xffffffff] : [gl.KEEP, gl.KEEP, gl.KEEP];
      for (const side of face === gl.FRONT_AND_BACK ? [gl.FRONT, gl.BACK] : [face]) record(state, `${base}:${side}`, operation(`${base}Separate`, [side, ...values]), operation(`${base}Separate`, [side, ...defaults]));
      return true;
    }
    return false;
  }

  function update(state, name, args) {
    const gl = state.gl;
    if (stateOperation(state, name, args)) return;
    if (name === 'activeTexture') { state.activeUnit = args[0]; record(state, 'activeTexture', operation(name, args), operation(name, [gl.TEXTURE0]), true); return; }
    if (name === 'useProgram') { state.program = args[0]; record(state, name, operation(name, args), operation(name, [null]), true); return; }
    if (name === 'bindVertexArray') { state.vao = args[0]; record(state, name, operation(name, args), operation(name, [null]), true); return; }
    if (name === 'bindTexture') {
      const key = `${state.activeUnit}:${args[0]}`; state.textures.set(key, args[1]);
      record(state, `texture:${key}`, operation(name, args, [['activeTexture', [state.activeUnit]]]), operation(name, [args[0], null], [['activeTexture', [state.activeUnit]]]), true); return;
    }
    if (name === 'bindBuffer') {
      state.buffers.set(args[0], args[1]);
      const vao = args[0] === gl.ELEMENT_ARRAY_BUFFER ? state.vao : null;
      record(state, `buffer:${args[0]}:${id(vao)}`, operation(name, args, vao || args[0] === gl.ELEMENT_ARRAY_BUFFER ? [['bindVertexArray', [vao]]] : [], vao), operation(name, [args[0], null], vao ? [['bindVertexArray', [vao]]] : []), true); return;
    }
    if (name === 'bindBufferBase' || name === 'bindBufferRange') {
      state.buffers.set(args[0], args[2]);
      record(state, `indexedBuffer:${args[0]}:${args[1]}`, operation(name, args), operation('bindBufferBase', [args[0], args[1], null]), true); return;
    }
    if (name === 'bindSampler') { record(state, `sampler:${args[0]}`, operation(name, args), operation(name, [args[0], null]), true); return; }
    if (name === 'bindRenderbuffer') { state.renderbuffer = args[1]; record(state, name, operation(name, args), operation(name, [args[0], null]), true); return; }
    if (name === 'bindFramebuffer') {
      for (const target of args[0] === gl.FRAMEBUFFER ? [gl.READ_FRAMEBUFFER, gl.DRAW_FRAMEBUFFER] : [args[0]]) {
        state.framebuffers.set(target, args[1]); record(state, `framebuffer:${target}`, operation(name, [target, args[1]]), operation(name, [target, null]), true);
      }
      return;
    }
    if (name === 'bufferData' || name === 'bufferSubData') {
      const resource = state.buffers.get(args[0]), version = resourceVersion(state, resource);
      if (name === 'bufferData') {
        version.target = args[0]; version.usage = args[2];
        version.bytes = typeof args[1] === 'number' ? new Uint8Array(args[1]) : byteView(args[1], args[3] || 0, args[4])?.slice();
      } else {
        const bytes = byteView(args[2], args[3] || 0, args[4]);
        if (!version.bytes || !bytes || args[1] + bytes.byteLength > version.bytes.byteLength) return reject(state, 'bufferSubData missing/out-of-bounds bytes');
        version.bytes.set(bytes, args[1]);
      }
      if (!version.bytes) reject(state, 'bufferData unsupported source');
      metrics.uploads++; return;
    }
    if (name === 'copyBufferSubData') {
      const [readTarget, writeTarget, readOffset, writeOffset, size] = args;
      const source = state.resources.get(state.buffers.get(readTarget))?.version.bytes;
      const destination = resourceVersion(state, state.buffers.get(writeTarget));
      if (!source || !destination.bytes || readOffset < 0 || writeOffset < 0 ||
        readOffset + size > source.byteLength || writeOffset + size > destination.bytes.byteLength) {
        return reject(state, 'copyBufferSubData missing/out-of-bounds bytes');
      }
      // Copy semantics must remain correct when both targets refer to one buffer.
      destination.bytes.set(source.slice(readOffset, readOffset + size), writeOffset);
      metrics.uploads++; return;
    }
    if (name === 'texStorage2D' || name === 'texImage2D' || name === 'texSubImage2D') { uploadTexture(state, name, args); return; }
    if (name === 'texParameteri' || name === 'texParameterf' || name === 'generateMipmap') {
      const resource = boundTexture(state, args[0]), version = resourceVersion(state, resource);
      const op = operation(name, args, setupTexture(state, resource, args[0]), resource);
      if (name !== 'generateMipmap') {
        const initial = parameterDefault(args[1]);
        if (initial === undefined) reject(state, `Unknown texture parameter ${args[1]}`);
        else op.initial = operation(name, [args[0], args[1], initial], op.setup, resource);
      }
      version.operations.set(name === 'generateMipmap' ? name : `texParam:${args[1]}`, op); return;
    }
    if (name === 'samplerParameteri' || name === 'samplerParameterf') {
      const op = operation(name, args, [], args[0]), initial = parameterDefault(args[1]);
      if (initial === undefined) reject(state, `Unknown sampler parameter ${args[1]}`);
      else op.initial = operation(name, [args[0], args[1], initial], [], args[0]);
      resourceVersion(state, args[0]).operations.set(`samplerParam:${args[1]}`, op); return;
    }
    if (name === 'renderbufferStorage' || name === 'renderbufferStorageMultisample') {
      resourceVersion(state, state.renderbuffer).operations.set('storage', operation(name, args, [['bindRenderbuffer', [gl.RENDERBUFFER, state.renderbuffer]]], state.renderbuffer)); return;
    }
    if (/^uniform/.test(name)) {
      const owner = name === 'uniformBlockBinding' ? args[0] : state.program;
      const version = resourceVersion(state, owner);
      const initialArgs = args.map((value, index) => index === 0 || (name === 'uniformBlockBinding' && index === 1) ? value : typeof value === 'boolean' ? false : ArrayBuffer.isView(value) ? new value.constructor(value.length) : 0);
      const op = operation(name, args, [['useProgram', [owner]]], owner);
      op.initial = operation(name, initialArgs, [['useProgram', [owner]]], owner);
      version.operations.set(`uniform:${id(args[0])}:${name === 'uniformBlockBinding' ? args[1] : ''}`, op); return;
    }
    if (/^(enableVertexAttribArray|disableVertexAttribArray|vertexAttrib.*)$/.test(name)) {
      const owner = state.vao;
      const setup = [['bindVertexArray', [owner]]];
      if (name === 'vertexAttribPointer' || name === 'vertexAttribIPointer') setup.push(['bindBuffer', [gl.ARRAY_BUFFER, state.buffers.get(gl.ARRAY_BUFFER) || null]]);
      const kind = name.includes('VertexAttribArray') ? 'enabled' : name.includes('Pointer') ? 'pointer' : name.includes('Divisor') ? 'divisor' : 'value';
      const initial = kind === 'enabled' ? operation('disableVertexAttribArray', [args[0]], setup, owner) : kind === 'divisor' ? operation('vertexAttribDivisor', [args[0], 0], setup, owner) : null;
      record(state, `attribute:${id(owner)}:${args[0]}:${kind}`, operation(name, args, setup, owner), initial); return;
    }
    if (/^framebuffer(Renderbuffer|Texture2D|TextureLayer)$/.test(name)) {
      const target = args[0] === gl.FRAMEBUFFER ? gl.DRAW_FRAMEBUFFER : args[0], owner = state.framebuffers.get(target);
      const version = resourceVersion(state, owner);
      const op = operation(name, args, [['bindFramebuffer', [args[0], owner]]], owner);
      const empty = args.slice(); empty[name === 'framebufferTextureLayer' ? 2 : 3] = null;
      op.initial = operation(name, empty, op.setup, owner);
      version.operations.set(`attachment:${args[1]}`, op); return;
    }
    if (name === 'drawBuffers' || name === 'readBuffer') {
      const target = name === 'drawBuffers' ? gl.DRAW_FRAMEBUFFER : gl.READ_FRAMEBUFFER, owner = state.framebuffers.get(target) || null;
      record(state, `${name}:${id(owner)}`, operation(name, args, [['bindFramebuffer', [target, owner]]], owner), operation(name, name === 'drawBuffers' ? [[owner ? gl.COLOR_ATTACHMENT0 : gl.BACK]] : [owner ? gl.COLOR_ATTACHMENT0 : gl.BACK], [['bindFramebuffer', [target, owner]]], owner)); return;
    }
    if (/^(readPixels|getBufferSubData|copy|compressed|tex.*3D|begin|end|pauseTransform|resumeTransform|transformFeedback|bindTransform)/.test(name)) { reject(state, name); return; }
    if (!harmless.test(name) && !/^invalidate/.test(name)) reject(state, name);
  }

  function observe(gl) {
    if (contexts.has(gl) || !gl || typeof gl.getParameter !== 'function' || typeof gl.createShader !== 'function') return;
    if (typeof gl.createVertexArray !== 'function') throw new Error('Compact rollback renderer currently requires WebGL2');
    const state = { gl, native: new Map(), resources: new Map(), deleted: new Set(), values: new Map(), bindings: new Map(), defaults: new Map(),
      activeUnit: gl.TEXTURE0, program: null, vao: null, renderbuffer: null, textures: new Map(), buffers: new Map(), framebuffers: new Map(), pixel: new Map(), barrier: 0 };
    contexts.set(gl, state);
    const names = new Set();
    for (let proto = gl; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) for (const name of Object.getOwnPropertyNames(proto)) names.add(name);
    for (const name of names) {
      if (typeof gl[name] !== 'function') continue;
      const original = gl[name].bind(gl); state.native.set(name, original);
      const creation = creations.test(name), deletion = deletions.test(name);
      // These calls were already classified as harmless by update(): the wrapper
      // only counted them, then called the native method. Draw/clear calls are the
      // hottest path in visually complex scenes, so leave them completely native.
      // getBufferSubData is the exception: it must remain wrapped because rollback
      // explicitly rejects GPU readback crossing a checkpoint.
      if (!creation && !deletion && name !== 'getBufferSubData' && harmless.test(name)) continue;
      if (!creation && !deletion && !mutations.test(name) && name !== 'getBufferSubData') continue;
      gl[name] = (...args) => {
        if (restoring) return original(...args);
        counts.set(name, (counts.get(name) || 0) + 1);
        if (deletions.test(name)) { if (args[0]) state.deleted.add(args[0]); return; }
        const result = original(...args);
        if (creations.test(name)) {
          if (result) state.resources.set(result, { kind: name.slice(6), checkpointRefs: 0, collectMark: 0, restoreMark: 0,
            version: { generation, images: new Map(), operations: new Map(), bytes: null } });
        } else update(state, name, args);
        return result;
      };
    }
  }

  function apply(state, op) {
    if (!op) return;
    for (const [name, args] of op.setup) state.native.get(name)?.(...args);
    const method = state.native.get(op.name);
    if (!method) throw new Error(`Missing native GL operation ${op.name}`);
    method(...op.args);
    timings.nativeCalls++;
  }
  function restoreResource(state, resource, saved, previous) {
    if (saved === previous) return;
    const gl = state.gl;
    if (saved.bytes) {
      state.native.get('bindBuffer')(saved.target, resource);
      state.native.get('bufferData')(saved.target, saved.bytes, saved.usage);
      timings.restoredBytes += saved.bytes.byteLength;
      metrics.restoredUploads++;
    }
    const restoredImages = new Map(saved.images);
    for (const [key, image] of previous?.images || []) {
      if (!restoredImages.has(key) && saved.storage) {
        restoredImages.set(key, { ...image, bytes: new Uint8Array(image.bytes.byteLength) });
      }
    }
    for (const image of restoredImages.values()) {
      for (const [method, args] of setupTexture(state, resource, image.target)) state.native.get(method)(...args);
      for (const [name, value] of [['UNPACK_ALIGNMENT', 1], ['UNPACK_ROW_LENGTH', 0], ['UNPACK_SKIP_PIXELS', 0], ['UNPACK_SKIP_ROWS', 0], ['UNPACK_FLIP_Y_WEBGL', 0], ['UNPACK_PREMULTIPLY_ALPHA_WEBGL', 0]]) if (gl[name] !== undefined) state.native.get('pixelStorei')(gl[name], value);
      const Typed = image.type === gl.FLOAT ? Float32Array : image.type === gl.HALF_FLOAT || image.type === gl.UNSIGNED_SHORT ? Uint16Array : Uint8Array;
      const bytes = new Typed(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength / Typed.BYTES_PER_ELEMENT);
      if (image.immutable) state.native.get('texSubImage2D')(image.target, image.level, 0, 0, image.width, image.height, image.format, image.type, bytes);
      else state.native.get('texImage2D')(image.target, image.level, image.internalFormat, image.width, image.height, image.border, image.format, image.type, bytes);
      metrics.restoredUploads++;
      timings.restoredBytes += image.bytes.byteLength;
    }
    for (const [key, oldOp] of previous?.operations || []) if (!saved.operations.has(key)) apply(state, oldOp.initial);
    for (const op of saved.operations.values()) apply(state, op);
  }
  function collect() {
    const started = wallNow();
    collectGeneration++;
    for (const state of contexts.values()) {
      // VAOs, framebuffer attachments and current driver bindings may retain a
      // logically deleted object. Keep its native identity until those logical
      // references disappear; restoring them must never bind a deleted handle.
      function retainResource(value) {
        const info = state.resources.get(value);
        if (info) info.collectMark = collectGeneration;
      }
      function retainOperation(op) {
        for (const value of op.args) retainResource(value);
        for (const [, args] of op.setup) for (const value of args) retainResource(value);
      }
      for (const map of [state.values, state.bindings]) for (const op of map.values()) if (!state.deleted.has(op.owner)) retainOperation(op);
      for (const [resource, info] of state.resources) if (!state.deleted.has(resource)) for (const op of info.version.operations.values()) retainOperation(op);
      for (const resource of state.deleted) {
        const info = state.resources.get(resource);
        if (info && (info.checkpointRefs || info.collectMark === collectGeneration)) continue;
        if (info) state.native.get(`delete${info.kind}`)?.(resource);
        state.resources.delete(resource); state.deleted.delete(resource); metrics.deleted++;
        for (const map of [state.values, state.bindings]) for (const [key, op] of map) if (op.owner === resource) { map.delete(key); state.defaults.delete(key); }
      }
    }
    timings.collectMs += wallNow() - started;
  }
  const participant = {
    beforeTick(tick) { frame = tick.frame; },
    // Rolling checkpoints already collect on release. Without checkpoints,
    // batch deletion every four frames instead of scanning all resources at 35 Hz.
    afterTick() { if (!tokens.size && frame % 4 === 0) collect(); },
    capture() {
      const started = wallNow();
      const token = { frame, states: new Map() };
      for (const [gl, state] of contexts) {
        const resources = freeResourceTables.pop() || [];
        if (!resources.seen) { resources.seen = true; timings.resourceTableAllocations++; }
        resources.length = state.resources.size * 2;
        let resourceIndex = 0;
        for (const [resource, info] of state.resources) {
          resources[resourceIndex++] = resource; resources[resourceIndex++] = info.version; info.checkpointRefs++;
        }
        token.states.set(gl, {
        // WebGL deletion is deferred while an object remains bound or attached.
        // A checkpoint can therefore reference a logically deleted resource in
        // its bindings. Retain every still-native resource so restoring that
        // checkpoint never attempts to bind a handle collect() already deleted.
        resources,
        deleted: new Set(state.deleted), values: new Map(state.values), bindings: new Map(state.bindings), barrier: state.barrier,
        activeUnit: state.activeUnit, program: state.program, vao: state.vao, renderbuffer: state.renderbuffer,
        textures: new Map(state.textures), buffers: new Map(state.buffers), framebuffers: new Map(state.framebuffers), pixel: new Map(state.pixel),
      });
      }
      generation++; tokens.add(token); timings.captureMs += wallNow() - started; return token;
    },
    beforeRestore(token) {
      for (const [gl, saved] of token.states) if (contexts.get(gl).barrier !== saved.barrier) throw new Error(`Unsupported GPU mutation crossed rollback checkpoint: ${metrics.unsupported.join(', ')}`);
    },
    restore(token) {
      const started = wallNow();
      restoring = true;
      try {
        for (const [gl, saved] of token.states) {
          const state = contexts.get(gl), mark = ++restoreGeneration;
          for (let i = 0; i < saved.resources.length; i += 2) {
            const resource = saved.resources[i], version = saved.resources[i + 1];
            const info = state.resources.get(resource);
            if (!info) throw new Error('A GL resource was deleted while a checkpoint retained it');
            restoreResource(state, resource, version, info.version);
            info.version = version; info.restoreMark = mark;
          }
          for (const [key] of state.values) if (!saved.values.has(key)) apply(state, state.defaults.get(key));
          for (const [key] of state.bindings) if (!saved.bindings.has(key)) apply(state, state.defaults.get(key));
          for (const op of saved.values.values()) apply(state, op);
          for (const op of saved.bindings.values()) apply(state, op);
          // Prerequisite bindings above can disturb the active VAO, program,
          // texture unit, generic buffers, and read/draw framebuffers.
          state.native.get('bindVertexArray')?.(saved.vao);
          state.native.get('useProgram')?.(saved.program);
          for (const [target, buffer] of saved.buffers) if (target !== gl.ELEMENT_ARRAY_BUFFER) state.native.get('bindBuffer')?.(target, buffer);
          for (const [target, framebuffer] of saved.framebuffers) state.native.get('bindFramebuffer')?.(target, framebuffer);
          state.native.get('bindRenderbuffer')?.(gl.RENDERBUFFER, saved.renderbuffer);
          state.native.get('activeTexture')?.(saved.activeUnit);
          for (const [name, defaultValue] of [['UNPACK_ALIGNMENT', 4], ['UNPACK_ROW_LENGTH', 0], ['UNPACK_SKIP_PIXELS', 0], ['UNPACK_SKIP_ROWS', 0], ['UNPACK_FLIP_Y_WEBGL', 0], ['UNPACK_PREMULTIPLY_ALPHA_WEBGL', 0]]) if (gl[name] !== undefined) state.native.get('pixelStorei')?.(gl[name], saved.pixel.get(gl[name]) ?? defaultValue);
          for (const key of ['activeUnit', 'program', 'vao', 'renderbuffer', 'barrier']) state[key] = saved[key];
          for (const key of ['values', 'bindings', 'textures', 'buffers', 'framebuffers', 'pixel']) state[key] = new Map(saved[key]);
          state.deleted.clear();
          for (const resource of saved.deleted) state.deleted.add(resource);
          for (const [resource, info] of state.resources) if (info.restoreMark !== mark) state.deleted.add(resource);
        }
        generation++; frame = token.frame; metrics.restores++;
      } finally { restoring = false; timings.restoreMs += wallNow() - started; }
    },
    release(token) {
      if (!tokens.delete(token)) return;
      for (const [gl, saved] of token.states) {
        const state = contexts.get(gl);
        for (let i = 0; i < saved.resources.length; i += 2) {
          const info = state.resources.get(saved.resources[i]);
          if (!info || info.checkpointRefs < 1) throw new Error('Invalid GL checkpoint resource reference');
          info.checkpointRefs--;
        }
        saved.resources.length = 0; freeResourceTables.push(saved.resources);
      }
      collect();
    },
  };
  const previous = rollback.importWrapper;
  rollback.importWrapper = imports => {
    imports = previous ? previous(imports) : imports;
    for (const module of Object.values(imports)) for (const [name, original] of Object.entries(module)) if (name.startsWith('__wbg_') && typeof original === 'function') module[name] = function (...args) { observe(args[0]); return original.apply(this, args); };
    return imports;
  };
  rollback.registerParticipant('webgl', participant);
  root.RuffleRollbackGL = {
    observe,
    diagnostics() {
      let resources = 0, stateEntries = 0, bytes = 0, pendingDeletes = 0, checkpointResourceRefs = 0;
      for (const state of contexts.values()) {
        resources += state.resources.size; stateEntries += state.values.size + state.bindings.size; pendingDeletes += state.deleted.size;
        for (const info of state.resources.values()) {
          checkpointResourceRefs += info.checkpointRefs;
          bytes += info.version.bytes?.byteLength || 0;
          for (const image of info.version.images.values()) bytes += image.bytes.byteLength;
        }
      }
      return { compact: true, frame, contexts: contexts.size, tokens: tokens.size, resources, checkpointResourceRefs, stateEntries, bytes, pendingDeletes, ...metrics, timings: { ...timings }, methodCounts: Object.fromEntries(counts) };
    },
  };
})();
