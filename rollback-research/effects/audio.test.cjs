'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Buffer {
  constructor(channels, length, rate) {
    this.numberOfChannels = channels; this.length = length; this.sampleRate = rate;
    this.duration = length / rate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(length));
  }
  getChannelData(channel) { return this.channels[channel]; }
  copyToChannel(samples, channel) { this.channels[channel].set(samples); }
}

function fixture() {
  const participants = new Map();
  const calls = [];
  const audioContext = {
    currentTime: 12, sampleRate: 44100, destination: {}, state: 'suspended', resumed: 0,
    resume() { this.state = 'running'; this.resumed++; return Promise.resolve(); },
    createBuffer(channels, length, rate) { return new Buffer(channels, length, rate); },
    createBufferSource() {
      const output = { stopped: false, connect() {}, disconnect() {},
        stop() { this.stopped = true; }, start(when) { this.when = when; calls.push(this); } };
      return output;
    },
  };
  const env = {
    RuffleRollback: { registerParticipant(name, participant) { participants.set(name, participant); } },
  };
  env.window = env;
  vm.runInNewContext(fs.readFileSync(`${__dirname}/audio.js`, 'utf8'), env);
  const imports = env.RuffleRollback.importWrapper({ test: {
    __wbg_createBufferSource_pinned(context) { return context.createBufferSource(); },
    __wbg_currentTime_pinned(context) { return context.currentTime; },
  } }).test;
  const effects = participants.get('audio');
  let mixerSamples = 0;
  let audioTime = 0;
  function refill(buffer) {
    // Stand-in for the Rust mix side effect; snapshot code owns mixerSamples/audioTime.
    buffer.getChannelData(0).fill(mixerSamples);
    mixerSamples += buffer.length;
    const source = imports.__wbg_createBufferSource_pinned(audioContext);
    source.buffer = buffer;
    source.onended = () => refill(buffer);
    source.start(audioTime);
    audioTime += buffer.duration;
  }
  const buffers = [new Buffer(2, 2048, 44100), new Buffer(2, 2048, 44100)];
  buffers.forEach(refill);
  function tick(frame, replay = false) {
    const event = { frame, timestamp: frame * (1000 / 35) + 0.001, replay };
    effects.beforeTick(event); effects.afterTick(event);
  }
  return { env, imports, effects, audioContext, calls, buffers, tick,
    save() { return { effects: effects.capture(), mixerSamples, audioTime }; },
    restore(state) { mixerSamples = state.mixerSamples; audioTime = state.audioTime; effects.restore(state.effects); },
    state() { return { mixerSamples, audioTime, buffer: Array.from(buffers[0].getChannelData(0)),
      diagnostics: env.RuffleRollbackAudio.diagnostics() }; },
  };
}

{
  const f = fixture();
  assert.equal(f.imports.__wbg_currentTime_pinned(f.audioContext), 0,
    'WASM audio clock must not read wall time');
  for (let i = 1; i <= 35; i++) f.tick(i);
  const saved = f.save();
  const snapshotPCM = f.buffers[0].getChannelData(0)[0];
  for (let i = 36; i <= 70; i++) f.tick(i);
  const first = f.state();
  f.restore(saved);
  assert.equal(f.buffers[0].getChannelData(0)[0], snapshotPCM, 'Mutable AudioBuffer restored');
  f.audioContext.currentTime += 100;
  for (let i = 36; i <= 70; i++) f.tick(i, true);
  const second = f.state();
  assert.equal(second.mixerSamples, first.mixerSamples);
  assert.equal(second.audioTime, first.audioTime);
  assert.deepEqual(second.buffer, first.buffer);
  assert.equal(second.diagnostics.queued, 2);
  assert.equal(second.diagnostics.sources, 2);
  assert.equal(f.calls.length, 0, 'Fast boot creates no real output sources');
}

{
  const f = fixture();
  f.env.RuffleRollbackAudio.unlock();
  assert.equal(f.audioContext.resumed, 1, 'A player gesture resumes the browser audio context');
  f.env.RuffleRollbackAudio.setAudible(true);
  for (let i = 1; i <= 7; i++) f.tick(i);
  const saved = f.save();
  for (let i = 8; i <= 14; i++) f.tick(i);
  const count = f.calls.length;
  f.restore(saved);
  for (let i = 8; i <= 14; i++) f.tick(i, true);
  assert(f.env.RuffleRollbackAudio.diagnostics().replaced > 0,
    'Replay replaces future, unplayed PCM sources');
  assert(f.calls.slice(0, count).some(source => source.stopped));
  assert(f.calls.every(source => source.onended === undefined), 'Real output never calls WASM');
  f.audioContext.currentTime = 20;
  const before = f.calls.length;
  f.restore(saved);
  for (let i = 8; i <= 14; i++) f.tick(i, true);
  assert.equal(f.calls.length, before, 'Already played PCM is never submitted twice');
  assert(f.env.RuffleRollbackAudio.diagnostics().suppressed > 0);
}

process.stdout.write('PASS: deterministic PCM scheduling, buffer restoration, callback isolation, future replacement, played-output dedup\n');
