/* Standalone rollback input bookkeeping; no dependency on Ruffle or transport. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GunMayhemRollback = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  class ProtocolError extends Error {
    constructor(code, message) { super(message); this.name = 'ProtocolError'; this.code = code; }
  }
  function requireValue(condition, code, message) {
    if (!condition) throw new ProtocolError(code, message);
  }
  function integer(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
  function validateOptions(options) {
    requireValue(typeof options.match === 'string' && options.match.length > 0 && options.match.length <= 128,
      'match', 'A match identifier is required');
    requireValue(integer(options.players, 2, 4), 'players', 'Expected two to four players');
  }
  function validateInput(packet, match, players) {
    requireValue(packet && packet.type === 'input', 'packet', 'Expected an input packet');
    requireValue(packet.match === match, 'match', 'Input belongs to another match');
    requireValue(integer(packet.slot, 0, players - 1), 'slot', 'Invalid player slot');
    requireValue(integer(packet.frame, 1, Number.MAX_SAFE_INTEGER), 'frame', 'Invalid input frame');
    requireValue(integer(packet.mask, 0, 63), 'mask', 'Invalid input mask');
  }

  class InputTimeline {
    constructor(options) {
      validateOptions(options);
      requireValue(integer(options.localSlot, 0, options.players - 1), 'slot', 'Invalid local slot');
      this.match = options.match;
      this.players = options.players;
      this.localSlot = options.localSlot;
      this.maxRollbackFrames = options.maxRollbackFrames ?? 24;
      this.retentionFrames = options.retentionFrames ?? this.maxRollbackFrames;
      this.maxFutureFrames = options.maxFutureFrames ?? 70;
      requireValue(integer(this.maxRollbackFrames, 1, 350), 'window', 'Invalid rollback window');
      requireValue(integer(this.retentionFrames, this.maxRollbackFrames, 350), 'window', 'Invalid retention window');
      requireValue(integer(this.maxFutureFrames, this.maxRollbackFrames, 350), 'window', 'Invalid future window');
      this.frame = 0;
      this.confirmedFrame = 0;
      this.retainedFrame = 0;
      this.earliestMismatch = null;
      this.stopped = false;
      this.actual = new Map();
      this.used = new Map([[0, { masks: Array(this.players).fill(0), predicted: [] }]]);
    }

    receive(packet) {
      validateInput(packet, this.match, this.players);
      if (this.stopped) return { status: 'stopped' };
      const { frame, slot, mask } = packet;
      if (frame <= this.retainedFrame) return { status: 'stale' };
      requireValue(frame <= this.frame + this.maxFutureFrames, 'future', 'Input is too far ahead');
      let row = this.actual.get(frame);
      if (!row) { row = Array(this.players).fill(undefined); this.actual.set(frame, row); }
      if (row[slot] !== undefined) {
        requireValue(row[slot] === mask, 'conflict', 'A player changed an already submitted input');
        return { status: 'duplicate' };
      }
      row[slot] = mask;
      const used = this.used.get(frame);
      if (used && used.masks[slot] !== mask) {
        requireValue(this.frame - frame < this.maxRollbackFrames, 'expired', 'Input predates rollback history');
        this.earliestMismatch = Math.min(this.earliestMismatch ?? frame, frame);
      }
      while (this.actual.get(this.confirmedFrame + 1)?.every(value => value !== undefined)) this.confirmedFrame++;
      return { status: 'accepted', earliestMismatch: this.earliestMismatch, confirmedFrame: this.confirmedFrame };
    }

    get canAdvance() {
      return !this.stopped && this.earliestMismatch === null && this.frame - this.confirmedFrame < this.maxRollbackFrames;
    }

    // Queue a local input for the next frame by default. Multiplayer runtimes may
    // intentionally submit a few frames ahead so remote peers receive that input
    // before simulating the frame. The input still becomes effective only at its
    // numbered frame; this is ordinary input delay, not extra prediction. Replays
    // reuse the already recorded local packets and never recapture user input.
    captureLocal(mask, leadFrames = 0) {
      requireValue(this.canAdvance, 'paused', 'Correct or confirm previous frames before advancing');
      requireValue(integer(leadFrames, 0, this.maxFutureFrames - 1), 'lead', 'Invalid local input lead');
      const packet = { type: 'input', match: this.match, slot: this.localSlot, frame: this.frame + 1 + leadFrames, mask };
      this.receive(packet);
      return packet;
    }

    advance() {
      requireValue(this.canAdvance, 'paused', 'Correct or confirm previous frames before advancing');
      const frame = this.frame + 1;
      const row = this.actual.get(frame) || Array(this.players).fill(undefined);
      requireValue(row[this.localSlot] !== undefined, 'local-input', 'Capture local input before a new frame');
      const previous = this.used.get(this.frame);
      const masks = row.map((value, slot) => value ?? previous.masks[slot]);
      const predicted = row.flatMap((value, slot) => value === undefined ? [slot] : []);
      this.used.set(frame, { masks, predicted });
      this.frame = frame;
      this.prune();
      // The SWF expects four masks even in a two-player match.
      return { frame, masks: [...masks, ...Array(4 - this.players).fill(0)], predicted };
    }

    beginRollback() {
      if (this.earliestMismatch === null) return null;
      const fromFrame = this.earliestMismatch;
      const throughFrame = this.frame;
      const restoreFrame = fromFrame - 1;
      requireValue(restoreFrame >= this.retainedFrame, 'expired', 'Required checkpoint has been discarded');
      for (const frame of this.used.keys()) if (frame >= fromFrame) this.used.delete(frame);
      this.frame = restoreFrame;
      this.earliestMismatch = null;
      return { restoreFrame, fromFrame, throughFrame };
    }

    canHash(frame) {
      return integer(frame, this.retainedFrame, Math.min(this.frame, this.confirmedFrame)) &&
        this.used.has(frame) && (this.earliestMismatch === null || frame < this.earliestMismatch);
    }

    prune() {
      // Sparse checkpoints may precede the first corrected input. Retain that
      // replay history without permitting a larger prediction window.
      const before = Math.min(this.confirmedFrame, this.frame - this.retentionFrames);
      if (before <= this.retainedFrame) return;
      for (const frame of this.actual.keys()) if (frame <= before) this.actual.delete(frame);
      for (const frame of this.used.keys()) if (frame < before) this.used.delete(frame);
      this.retainedFrame = before;
    }

    disconnect() { this.stopped = true; }
  }

  // A room owns one relay. Slot is supplied by the authenticated room member,
  // never chosen by the untrusted packet. The relay does not run the game.
  class InputRelay {
    constructor(options) {
      validateOptions(options);
      this.match = options.match;
      this.players = options.players;
      this.fps = options.fps ?? 35;
      this.startAt = options.startAt ?? 0;
      this.futureSlackFrames = options.futureSlackFrames ?? 8;
      this.maxGapFrames = options.maxGapFrames ?? 70;
      this.retentionFrames = options.retentionFrames ?? 70;
      this.inputTimeoutMs = options.inputTimeoutMs ?? 20000;
      this.hashInterval = options.hashInterval ?? 35;
      this.contiguous = Array(this.players).fill(0);
      this.lastInputAt = Array(this.players).fill(this.startAt);
      this.inputs = Array.from({ length: this.players }, () => new Map());
      this.hashes = new Map();
      this.confirmedFrame = 0;
      this.retainedFrame = 0;
      this.stopped = false;
    }

    receiveInput(slot, packet, now) {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      validateInput(packet, this.match, this.players);
      requireValue(slot === packet.slot, 'slot', 'Cannot submit another player\'s input');
      requireValue(Number.isFinite(now) && now >= this.startAt, 'time', 'Match has not started');
      const wallFrame = Math.floor((now - this.startAt) * this.fps / 1000);
      requireValue(packet.frame <= wallFrame + this.futureSlackFrames, 'future', 'Input exceeds the server clock');
      if (packet.frame <= this.retainedFrame) return { status: 'stale' };
      requireValue(packet.frame <= this.contiguous[slot] + this.maxGapFrames, 'gap', 'Input gap exceeds the allowed window');
      const inputs = this.inputs[slot];
      if (inputs.has(packet.frame)) {
        requireValue(inputs.get(packet.frame) === packet.mask, 'conflict', 'Cannot change a submitted input');
        return { status: 'duplicate' };
      }
      inputs.set(packet.frame, packet.mask);
      this.lastInputAt[slot] = now;
      while (inputs.has(this.contiguous[slot] + 1)) this.contiguous[slot]++;
      this.confirmedFrame = Math.min(...this.contiguous);
      this.prune();
      return {
        status: 'accepted',
        message: { type: 'input', match: this.match, slot, frame: packet.frame, mask: packet.mask },
        confirmedFrame: this.confirmedFrame,
        hashResults: this.settleHashes(),
      };
    }

    receiveHash(slot, packet) {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      requireValue(integer(slot, 0, this.players - 1), 'slot', 'Invalid player slot');
      requireValue(packet?.type === 'hash' && packet.match === this.match, 'match', 'Hash belongs to another match');
      requireValue(integer(packet.frame, 1, this.confirmedFrame + this.maxGapFrames) && packet.frame % this.hashInterval === 0,
        'unconfirmed-hash', 'Hash frame exceeds the checkpoint window');
      requireValue(typeof packet.hash === 'string' && /^[0-9a-f]{8,64}$/.test(packet.hash), 'hash', 'Invalid state hash');
      if (packet.frame <= this.retainedFrame) return { status: 'stale' };
      let row = this.hashes.get(packet.frame);
      if (!row) { row = { values: Array(this.players).fill(undefined), reported: false }; this.hashes.set(packet.frame, row); }
      requireValue(row.values[slot] === undefined || row.values[slot] === packet.hash, 'conflict', 'Cannot change a submitted hash');
      row.values[slot] = packet.hash;
      return this.checkHash(packet.frame, row);
    }

    checkHash(frame, row) {
      // With an unordered transport a valid hash can overtake its sender's own
      // input. Hold it until those inputs arrive; never compare speculative data.
      if (frame > this.confirmedFrame) return { status: 'waiting-inputs' };
      if (row.values.some(value => value === undefined)) return { status: 'waiting' };
      row.reported = true;
      if (row.values.some(value => value !== row.values[0])) {
        this.stopped = true;
        return { status: 'desync', frame };
      }
      return { status: 'verified', frame, hash: row.values[0] };
    }

    settleHashes() {
      const results = [];
      for (const [frame, row] of this.hashes) {
        if (row.reported) continue;
        const result = this.checkHash(frame, row);
        if (result.status === 'verified' || result.status === 'desync') results.push(result);
      }
      return results;
    }

    timedOutSlots(now) {
      return this.lastInputAt.flatMap((time, slot) => now - time > this.inputTimeoutMs ? [slot] : []);
    }

    prune() {
      const before = this.confirmedFrame - this.retentionFrames;
      if (before <= this.retainedFrame) return;
      for (const inputs of this.inputs) for (const frame of inputs.keys()) if (frame <= before) inputs.delete(frame);
      for (const frame of this.hashes.keys()) if (frame <= before) this.hashes.delete(frame);
      this.retainedFrame = before;
    }

    disconnect() { this.stopped = true; }
  }


  // Delayed-input lockstep bookkeeping. Frames are finalized by the server once,
  // then every browser simulates the exact same authoritative mask row exactly
  // once. Missing inputs are replaced with neutral input by the server deadline;
  // late packets for an already-finalized frame are stale and never trigger a
  // rollback.
  class LockstepTimeline {
    constructor(options) {
      validateOptions(options);
      requireValue(integer(options.localSlot, 0, options.players - 1), 'slot', 'Invalid local slot');
      this.match = options.match;
      this.players = options.players;
      this.localSlot = options.localSlot;
      this.frame = 0;
      this.highestReceivedFrame = 0;
      this.frames = new Map();
      this.stopped = false;
    }

    makeLocalInput(frame, mask) {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      requireValue(integer(frame, 1, Number.MAX_SAFE_INTEGER), 'frame', 'Invalid input frame');
      requireValue(integer(mask, 0, 63), 'mask', 'Invalid input mask');
      return { type: 'input', match: this.match, slot: this.localSlot, frame, mask };
    }

    receiveFrame(packet) {
      requireValue(packet && packet.type === 'frame', 'packet', 'Expected a finalized frame packet');
      requireValue(packet.match === this.match, 'match', 'Frame belongs to another match');
      requireValue(integer(packet.frame, 1, Number.MAX_SAFE_INTEGER), 'frame', 'Invalid finalized frame');
      requireValue(Array.isArray(packet.masks) && packet.masks.length === this.players &&
        packet.masks.every(mask => integer(mask, 0, 63)), 'mask', 'Invalid finalized input row');
      requireValue(!packet.fallbackSlots || Array.isArray(packet.fallbackSlots) &&
        packet.fallbackSlots.every(slot => integer(slot, 0, this.players - 1)), 'slot', 'Invalid fallback slot list');
      if (this.stopped) return { status: 'stopped' };
      if (packet.frame <= this.frame) return { status: 'stale' };
      const existing = this.frames.get(packet.frame);
      if (existing) {
        requireValue(existing.masks.every((mask, i) => mask === packet.masks[i]), 'conflict', 'Finalized frame changed');
        return { status: 'duplicate' };
      }
      this.frames.set(packet.frame, {
        frame: packet.frame,
        masks: [...packet.masks, ...Array(4 - this.players).fill(0)],
        fallbackSlots: packet.fallbackSlots ? [...packet.fallbackSlots] : [],
      });
      this.highestReceivedFrame = Math.max(this.highestReceivedFrame, packet.frame);
      return { status: 'accepted' };
    }

    get bufferedFrames() {
      return Math.max(0, this.highestReceivedFrame - this.frame);
    }

    get hasNext() {
      return this.frames.has(this.frame + 1);
    }

    advance() {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      const next = this.frames.get(this.frame + 1);
      requireValue(next, 'missing-frame', 'The next finalized frame has not arrived');
      this.frames.delete(next.frame);
      this.frame = next.frame;
      return next;
    }

    canHash(frame) {
      return integer(frame, 1, this.frame);
    }

    disconnect() { this.stopped = true; }
  }

  class LockstepRelay {
    constructor(options) {
      validateOptions(options);
      this.match = options.match;
      this.players = options.players;
      this.maxFutureFrames = options.maxFutureFrames ?? 32;
      this.retentionFrames = options.retentionFrames ?? 140;
      this.hashInterval = options.hashInterval ?? 35;
      requireValue(integer(this.maxFutureFrames, 4, 350), 'window', 'Invalid future input window');
      requireValue(integer(this.retentionFrames, 35, 700), 'window', 'Invalid retention window');
      this.inputs = new Map();
      this.hashes = new Map();
      this.confirmedFrame = 0;
      this.retainedFrame = 0;
      this.stopped = false;
      this.lastInputAt = Array(this.players).fill(0);
      this.missingStreak = Array(this.players).fill(0);
      this.stats = { finalizedFrames: 0, fallbackFrames: 0, fallbackInputs: 0, lateInputs: 0, inputUpdates: 0 };
    }

    receiveInput(slot, packet, now = 0) {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      validateInput(packet, this.match, this.players);
      requireValue(slot === packet.slot, 'slot', 'Cannot submit another player\'s input');
      if (packet.frame <= this.confirmedFrame) {
        this.stats.lateInputs++;
        return { status: 'stale', confirmedFrame: this.confirmedFrame };
      }
      requireValue(packet.frame <= this.confirmedFrame + this.maxFutureFrames, 'future', 'Input is too far ahead');
      let row = this.inputs.get(packet.frame);
      if (!row) { row = Array(this.players).fill(undefined); this.inputs.set(packet.frame, row); }
      if (row[slot] !== undefined) {
        if (row[slot] === packet.mask) return { status: 'duplicate', confirmedFrame: this.confirmedFrame };
        // Delayed-input clients pre-submit future rows. A key edge may arrive
        // before that row is finalized, so let the owner revise its own pending
        // value. Once confirmed, the stale check above makes history immutable.
        row[slot] = packet.mask;
        this.lastInputAt[slot] = now;
        this.missingStreak[slot] = 0;
        this.stats.inputUpdates++;
        return {
          status: 'updated',
          message: { type: 'input', match: this.match, slot, frame: packet.frame, mask: packet.mask },
          confirmedFrame: this.confirmedFrame,
        };
      }
      row[slot] = packet.mask;
      this.lastInputAt[slot] = now;
      this.missingStreak[slot] = 0;
      return {
        status: 'accepted',
        message: { type: 'input', match: this.match, slot, frame: packet.frame, mask: packet.mask },
        confirmedFrame: this.confirmedFrame,
      };
    }

    missingSlots(frame = this.confirmedFrame + 1) {
      const row = this.inputs.get(frame);
      const missing = [];
      for (let slot = 0; slot < this.players; slot++) if (!row || row[slot] === undefined) missing.push(slot);
      return missing;
    }

    isComplete(frame = this.confirmedFrame + 1) {
      return this.missingSlots(frame).length === 0;
    }

    shouldGrace(frame, now, graceRecentMs = 500, maxMissingStreak = 1) {
      return this.missingSlots(frame).some(slot =>
        this.missingStreak[slot] <= maxMissingStreak && now - this.lastInputAt[slot] <= graceRecentMs);
    }

    finalizeNext() {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      const frame = this.confirmedFrame + 1;
      const row = this.inputs.get(frame) || Array(this.players).fill(undefined);
      const fallbackSlots = [];
      const masks = row.map((value, slot) => {
        if (value !== undefined) { this.missingStreak[slot] = 0; return value; }
        fallbackSlots.push(slot);
        this.missingStreak[slot]++;
        return 0;
      });
      this.inputs.delete(frame);
      this.confirmedFrame = frame;
      this.stats.finalizedFrames++;
      if (fallbackSlots.length) {
        this.stats.fallbackFrames++;
        this.stats.fallbackInputs += fallbackSlots.length;
      }
      this.prune();
      return { type: 'frame', match: this.match, frame, masks, fallbackSlots };
    }

    receiveHash(slot, packet) {
      requireValue(!this.stopped, 'stopped', 'Match is stopped');
      requireValue(integer(slot, 0, this.players - 1), 'slot', 'Invalid player slot');
      requireValue(packet?.type === 'hash' && packet.match === this.match, 'match', 'Hash belongs to another match');
      requireValue(integer(packet.frame, 1, this.confirmedFrame) && packet.frame % this.hashInterval === 0,
        'unconfirmed-hash', 'Hash frame exceeds the finalized frame window');
      requireValue(typeof packet.hash === 'string' && /^[0-9a-f]{8,64}$/.test(packet.hash), 'hash', 'Invalid state hash');
      if (packet.frame <= this.retainedFrame) return { status: 'stale' };
      let row = this.hashes.get(packet.frame);
      if (!row) { row = { values: Array(this.players).fill(undefined), reported: false }; this.hashes.set(packet.frame, row); }
      requireValue(row.values[slot] === undefined || row.values[slot] === packet.hash, 'conflict', 'Cannot change a submitted hash');
      row.values[slot] = packet.hash;
      return this.checkHash(packet.frame, row);
    }

    checkHash(frame, row) {
      if (row.values.some(value => value === undefined)) return { status: 'waiting' };
      row.reported = true;
      if (row.values.some(value => value !== row.values[0])) {
        this.stopped = true;
        return { status: 'desync', frame };
      }
      return { status: 'verified', frame, hash: row.values[0] };
    }

    prune() {
      const before = this.confirmedFrame - this.retentionFrames;
      if (before <= this.retainedFrame) return;
      for (const frame of this.inputs.keys()) if (frame <= before) this.inputs.delete(frame);
      for (const frame of this.hashes.keys()) if (frame <= before) this.hashes.delete(frame);
      this.retainedFrame = before;
    }

    disconnect() { this.stopped = true; }
  }

  const BOT_INPUT_MASK = Object.freeze({ jump: 1, left: 2, down: 4, right: 8, fire: 16, grenade: 32 });

  function normalizeBotMode(value) {
    const mode = String(value ?? '').toLowerCase();
    return /^(?:1|2|3|4|stress)$/.test(mode) ? mode : '';
  }

  // Deterministic input generator used only by browser stress tests. It emits
  // the same 6-bit mask as a real keyboard, so packets still travel through the
  // normal lockstep input path and exercise the real relay/simulation code.
  function botInputMask(frame, mode, slot = 0) {
    requireValue(integer(frame, 1, Number.MAX_SAFE_INTEGER), 'frame', 'Invalid bot frame');
    const normalized = normalizeBotMode(mode);
    if (!normalized) return 0;
    requireValue(integer(slot, 0, 3), 'slot', 'Invalid bot slot');
    const profile = normalized === 'stress' ? slot + 1 : Number(normalized);
    const phase = frame + profile * 47;
    let mask = 0;

    // Long alternating runs force movement/collision work without pressing
    // left and right together. Profiles are phase-shifted so bots spread out.
    const runPhase = Math.floor(phase / (62 + profile * 7)) % 4;
    mask |= (runPhase === 0 || runPhase === 3) ? BOT_INPUT_MASK.right : BOT_INPUT_MASK.left;

    // Jump for two frames at deterministic intervals.
    const jumpPeriod = normalized === 'stress' ? 31 + profile * 2 : 47 + profile * 5;
    if (phase % jumpPeriod < 2) mask |= BOT_INPUT_MASK.jump;

    // Fire in bursts. Stress mode intentionally spends most frames firing to
    // create bullets, particles, collisions, audio and renderer load.
    const firePeriod = normalized === 'stress' ? 9 + profile : 17 + profile * 3;
    const fireWidth = normalized === 'stress' ? firePeriod - 3 : 4 + (profile & 1);
    if (phase % firePeriod < fireWidth) mask |= BOT_INPUT_MASK.fire;

    // Hold grenade for several frames and then release it naturally, matching
    // the real K-key behavior that throws on release.
    const grenadePeriod = 139 + profile * 11;
    const grenadePhase = phase % grenadePeriod;
    if (grenadePhase >= grenadePeriod - 9 && grenadePhase < grenadePeriod - 3) mask |= BOT_INPUT_MASK.grenade;

    return mask;
  }

  return { InputTimeline, InputRelay, LockstepTimeline, LockstepRelay, ProtocolError, BOT_INPUT_MASK, normalizeBotMode, botInputMask };
});
