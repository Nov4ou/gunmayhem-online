/* Research adapter for the pinned Ruffle 0.6.0 externref build. Load after
 * state/snapshot.js and before Ruffle. Keeps the original Rust PCM mixer.
 * Browser audio callbacks NEVER enter a snapshotted WASM instance.
 */
(() => {
  'use strict';
  const root = typeof window === 'undefined' ? globalThis : window;
  const rollback = root.RuffleRollback;
  if (!rollback) throw new Error('Load RuffleRollback before rollback audio');
  const contexts = new Map();
  let now = 0, frame = 0, serial = 0, replay = false, audible = false;
  let pumping = false;
  let sources = new Map();
  let queue = [];
  let buffers = new Set();
  // Keep real device playback roughly one PCM chunk behind simulation. At 35 FPS
  // the deterministic mixer callback can be serviced up to one frame after an exact
  // PCM boundary; the old 12 ms lead was smaller than that jitter budget.
  const initialLeadFloor = 0.060, initialLeadCeiling = 0.080, lateStartLead = 0.001;
  const stats = { mixed: 0, submitted: 0, suppressed: 0, replaced: 0, callbacks: 0,
    lateSubmissions: 0, rebases: 0, lateTrimmed: 0, lateDropped: 0, trimmedMs: 0,
    lateLt5Ms: 0, late5To20Ms: 0, late20To50Ms: 0, late50To100Ms: 0, lateGte100Ms: 0,
    worstLateMs: 0, minScheduledLeadMs: Infinity };

  function contextState(context) {
    let state = contexts.get(context);
    if (!state) {
      state = { context, epoch: null, output: new Map(), discontinuity: false };
      contexts.set(context, state);
    }
    return state;
  }

  function copyBuffer(buffer) {
    return Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
      buffer.getChannelData(channel).slice());
  }

  function submit(source) {
    stats.mixed++;
    if (!audible || !source.buffer) return;
    const state = contextState(source.context);
    const key = `${Math.round(source.when * source.context.sampleRate)}:${source.buffer.length}`;
    const previous = state.output.get(key);
    const realTime = source.context.currentTime;
    // Already audible samples cannot be undone. Never play them twice.
    if (previous && previous.when <= realTime + 0.004) {
      stats.suppressed++;
      return;
    }
    if (previous) {
      previous.node.stop();
      previous.node.disconnect();
      try { previous.gain?.disconnect(); } catch (_) {}
      stats.replaced++;
    }
    // Playback time belongs to the device and is deliberately NOT rolled back.
    // Keep one PCM chunk of presentation lead. Ruffle refills its two 2,048-sample
    // buffers from completion callbacks, while simulation advances only at 35 FPS;
    // a 12 ms device lead could therefore run dry on a heavy render/snapshot tick.
    const startupLead = Math.max(initialLeadFloor, Math.min(initialLeadCeiling, source.buffer.duration));
    if (state.epoch === null) state.epoch = realTime + startupLead - source.when;
    const nominalWhen = state.epoch + source.when;
    let when = nominalWhen, offset = 0;
    const rawLead = nominalWhen - realTime;
    stats.minScheduledLeadMs = Math.min(stats.minScheduledLeadMs, rawLead * 1000);
    if (nominalWhen < realTime) {
      const lateness = realTime - nominalWhen;
      stats.lateSubmissions++;
      const lateMs = lateness * 1000;
      if (lateMs < 5) stats.lateLt5Ms++;
      else if (lateMs < 20) stats.late5To20Ms++;
      else if (lateMs < 50) stats.late20To50Ms++;
      else if (lateMs < 100) stats.late50To100Ms++;
      else stats.lateGte100Ms++;
      stats.worstLateMs = Math.max(stats.worstLateMs, lateMs);
      if (replay) {
        stats.suppressed++;
        return;
      }
      // Only trim audio that is genuinely in the past. V4 also trimmed blocks that
      // were still a few milliseconds in the future, creating needless waveform
      // discontinuities several times per second. Keep the original A/V timeline
      // and recover only the samples whose real presentation deadline has passed.
      const catchUpWhen = realTime + lateStartLead;
      offset = catchUpWhen - nominalWhen;
      if (offset >= source.buffer.duration - 0.001) {
        stats.lateDropped++;
        stats.suppressed++;
        state.discontinuity = true;
        return;
      }
      when = catchUpWhen;
      stats.lateTrimmed++;
      stats.trimmedMs += offset * 1000;
    }
    // Ruffle reuses its two JS AudioBuffers. Real output gets an immutable copy.
    const outBuffer = source.context.createBuffer(source.buffer.numberOfChannels,
      source.buffer.length, source.buffer.sampleRate);
    for (let channel = 0; channel < source.buffer.numberOfChannels; channel++) {
      outBuffer.copyToChannel(source.buffer.getChannelData(channel), channel);
    }
    const out = source.context.createBufferSource();
    out.buffer = outBuffer;
    const remaining = Math.max(0, outBuffer.duration - offset);
    const needsFadeIn = offset > 0 || state.discontinuity;
    let gain = null;
    if (needsFadeIn && typeof source.context.createGain === 'function') {
      // Starting a trimmed PCM block at an arbitrary sample can produce a hard
      // waveform step (the audible "zzzt" in v4). Ramp in over a few ms so a
      // recovery/drop sounds like a tiny gap instead of a sharp click.
      gain = source.context.createGain();
      out.connect(gain);
      gain.connect(source.context.destination);
      const fade = Math.min(0.004, Math.max(0.001, remaining * 0.25));
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + fade);
    } else {
      out.connect(source.context.destination);
    }
    // No onended callback enters WASM. Browser-owned samples are presentation only.
    out.start(when, offset);
    state.discontinuity = false;
    state.output.set(key, { node: out, gain, when, end: when + remaining, frame });
    stats.submitted++;
    for (const [oldKey, value] of state.output) {
      // Keep a bounded dedup history (far longer than the rollback window).
      if (value.end < realTime - 10) state.output.delete(oldKey);
    }
  }

  function createSource(context) {
    contextState(context);
    const source = {
      id: ++serial, context, buffer: null, onended: null, when: null,
      connect() { return undefined; }, disconnect() {},
      start(when = 0) {
        if (this.when !== null) throw new Error('Audio source already started');
        this.when = when;
        if (!this.buffer) throw new Error('Ruffle started an empty PCM buffer');
        buffers.add(this.buffer);
        queue.push({ source: this, end: when + this.buffer.duration });
        queue.sort((a, b) => a.end - b.end || a.source.id - b.source.id);
        submit(this);
      },
    };
    sources.set(source.id, source);
    return source;
  }

  function pump(until) {
    if (pumping) throw new Error('Reentrant rollback audio pump');
    pumping = true;
    try {
      let limit = 1024;
      while (queue.length && queue[0].end <= until + 1e-9) {
        if (!--limit) throw new Error('Audio callback scheduling did not progress');
        const next = queue.shift();
        // Exact buffer boundary avoids wall-clock-dependent adaptive buffering.
        now = next.end;
        const callback = next.source.onended;
        next.source.onended = null;
        sources.delete(next.source.id);
        if (callback) { stats.callbacks++; callback(); }
      }
      now = until;
    } finally { pumping = false; }
  }

  const participant = {
    beforeTick(tick) { frame = tick.frame; replay = !!tick.replay; },
    afterTick(tick) { pump(tick.timestamp / 1000); },
    capture() {
      return {
        now, frame, serial,
        queue: queue.map(item => ({ ...item })),
        sources: Array.from(sources, ([id, source]) => [id, source, {
          buffer: source.buffer, onended: source.onended, when: source.when,
        }]),
        buffers: Array.from(buffers, buffer => [buffer, copyBuffer(buffer)]),
      };
    },
    restore(state) {
      now = state.now; frame = state.frame; serial = state.serial;
      queue = state.queue.map(item => ({ ...item }));
      sources = new Map();
      for (const [id, source, fields] of state.sources) {
        Object.assign(source, fields); sources.set(id, source);
      }
      buffers = new Set();
      for (const [buffer, channels] of state.buffers) {
        buffers.add(buffer);
        channels.forEach((samples, channel) => buffer.copyToChannel(samples, channel));
      }
    },
  };

  const previousWrapper = rollback.importWrapper;
  rollback.importWrapper = imports => {
    imports = previousWrapper ? previousWrapper(imports) : imports;
    for (const module of Object.values(imports)) {
      for (const [name, original] of Object.entries(module)) {
        if (/^__wbg_createBufferSource_/.test(name)) {
          module[name] = context => createSource(context);
        } else if (/^__wbg_currentTime_/.test(name)) {
          module[name] = context => {
            if (contexts.has(context) || typeof context.createBufferSource === 'function') {
              contextState(context);
              return now;
            }
            return original(context);
          };
        }
      }
    }
    return imports;
  };
  rollback.registerParticipant('audio', participant);
  root.RuffleRollbackAudio = {
    unlock() {
      for (const state of contexts.values()) {
        if (state.context.state === 'suspended' && typeof state.context.resume === 'function') {
          try { state.context.resume().catch?.(() => {}); } catch (_) {}
        }
      }
    },
    setAudible(value) {
      audible = !!value;
      for (const state of contexts.values()) {
        for (const output of state.output.values()) {
          if (output.end > state.context.currentTime) {
            try { output.node.stop(); output.node.disconnect(); output.gain?.disconnect(); } catch (_) {}
          }
        }
        state.output.clear(); state.epoch = null; state.discontinuity = false;
      }
    },
    diagnostics() {
      return { now, frame, replay, audible, queued: queue.length, sources: sources.size,
        buffers: buffers.size, contexts: contexts.size, ...stats,
        minScheduledLeadMs: Number.isFinite(stats.minScheduledLeadMs) ? stats.minScheduledLeadMs : null,
        initialLeadMs: initialLeadFloor * 1000, recoveryLeadMs: lateStartLead * 1000 };
    },
  };
})();
