'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { InputTimeline, InputRelay, botInputMask, normalizeBotMode } = require('./rollback-inputs.js');

const packet = (slot, frame, mask = 0, match = 'test') => ({ type: 'input', match, slot, frame, mask });
const makeTimeline = options => new InputTimeline({ match: 'test', players: 2, localSlot: 0, ...options });
function tick(timeline, mask = 0) { timeline.captureLocal(mask); return timeline.advance(); }

test('local controls affect the next frame before a server response', () => {
  const timeline = makeTimeline();
  assert.deepEqual(tick(timeline, 8), { frame: 1, masks: [8, 0, 0, 0], predicted: [1] });
  assert.equal(timeline.confirmedFrame, 0);
  assert.equal(timeline.canHash(1), false);
  timeline.receive(packet(1, 1));
  assert.equal(timeline.confirmedFrame, 1);
  assert.equal(timeline.canHash(1), true);
});

test('bot stress inputs are deterministic, valid and exercise movement/fire/jump/grenade', () => {
  assert.equal(normalizeBotMode('STRESS'), 'stress');
  assert.equal(normalizeBotMode('nope'), '');
  const first = Array.from({length:500}, (_,i)=>botInputMask(i+1,'stress',2));
  const second = Array.from({length:500}, (_,i)=>botInputMask(i+1,'stress',2));
  assert.deepEqual(first, second);
  assert.ok(first.every(mask=>Number.isInteger(mask)&&mask>=0&&mask<=63));
  assert.ok(first.some(mask=>mask&1), 'bot should jump');
  assert.ok(first.some(mask=>mask&2), 'bot should move left');
  assert.ok(first.some(mask=>mask&8), 'bot should move right');
  assert.ok(first.some(mask=>mask&16), 'bot should fire');
  assert.ok(first.some(mask=>mask&32), 'bot should hold grenades');
  for (const mask of first) assert.equal(Boolean(mask&2)&&Boolean(mask&8), false, 'bot must not press left and right together');
});

test('local inputs may be queued ahead without changing their simulation frame', () => {
  const timeline = new InputTimeline({ match: 'test', players: 3, localSlot: 0 });
  assert.equal(timeline.captureLocal(0, 0).frame, 1);
  assert.equal(timeline.captureLocal(0, 1).frame, 2);
  assert.equal(timeline.captureLocal(8, 2).frame, 3);
  assert.deepEqual(timeline.advance(), { frame: 1, masks: [0, 0, 0, 0], predicted: [1, 2] });
  assert.deepEqual(timeline.advance(), { frame: 2, masks: [0, 0, 0, 0], predicted: [1, 2] });
  assert.deepEqual(timeline.advance(), { frame: 3, masks: [8, 0, 0, 0], predicted: [1, 2] });
  assert.throws(() => timeline.captureLocal(0, 70), { code: 'lead' });
});

test('late input restores the earliest incorrect prediction and reuses recorded local inputs', () => {
  const timeline = makeTimeline();
  for (let frame = 1; frame <= 5; frame++) tick(timeline, frame);
  timeline.receive(packet(1, 4, 16));
  timeline.receive(packet(1, 2, 8));
  assert.equal(timeline.earliestMismatch, 2);
  assert.equal(timeline.canAdvance, false);
  const plan = timeline.beginRollback();
  assert.deepEqual(plan, { restoreFrame: 1, fromFrame: 2, throughFrame: 5 });
  assert.deepEqual(timeline.advance().masks, [2, 8, 0, 0]);
  assert.deepEqual(timeline.advance().masks, [3, 8, 0, 0]);
  assert.deepEqual(timeline.advance().masks, [4, 16, 0, 0]);
  assert.deepEqual(timeline.advance().masks, [5, 16, 0, 0]);
  assert.equal(timeline.confirmedFrame, 0);
});

test('confirmation is contiguous and cannot authorize a speculative hash', () => {
  const timeline = makeTimeline();
  tick(timeline); tick(timeline);
  timeline.receive(packet(1, 2, 8));
  assert.equal(timeline.confirmedFrame, 0);
  timeline.receive(packet(1, 1, 0));
  assert.equal(timeline.confirmedFrame, 2);
  assert.equal(timeline.canHash(1), true);
  assert.equal(timeline.canHash(2), false);
  timeline.beginRollback(); timeline.advance();
  assert.equal(timeline.canHash(2), true);
});

test('duplicate, changed, wrong-match, malformed and future packets', () => {
  const timeline = makeTimeline();
  assert.equal(timeline.receive(packet(1, 2, 8)).status, 'accepted');
  assert.equal(timeline.receive(packet(1, 2, 8)).status, 'duplicate');
  assert.throws(() => timeline.receive(packet(1, 2, 16)), { code: 'conflict' });
  assert.throws(() => timeline.receive(packet(1, 2, 8, 'old-match')), { code: 'match' });
  assert.throws(() => timeline.receive(packet(2, 1)), { code: 'slot' });
  assert.throws(() => timeline.receive(packet(1, 1, 64)), { code: 'mask' });
  assert.throws(() => timeline.receive(packet(1, 71)), { code: 'future' });
});

test('a missing player pauses at the rollback window and recovers when inputs arrive', () => {
  const timeline = makeTimeline({ maxRollbackFrames: 3 });
  tick(timeline); tick(timeline); tick(timeline);
  assert.equal(timeline.canAdvance, false);
  assert.throws(() => tick(timeline), { code: 'paused' });
  timeline.receive(packet(1, 1, 8));
  timeline.receive(packet(1, 2, 8));
  timeline.receive(packet(1, 3, 8));
  const plan = timeline.beginRollback();
  assert.equal(plan.restoreFrame, 0);
  for (let frame = 1; frame <= 3; frame++) timeline.advance();
  assert.equal(timeline.canAdvance, true);
  assert.equal(timeline.confirmedFrame, 3);
  timeline.disconnect();
  assert.equal(timeline.canAdvance, false);
  assert.equal(timeline.receive(packet(1, 4)).status, 'stopped');
});

test('history stays bounded while retaining a usable checkpoint boundary', () => {
  const timeline = makeTimeline({ maxRollbackFrames: 3 });
  for (let frame = 1; frame <= 100; frame++) {
    timeline.receive(packet(1, frame, 8));
    tick(timeline, 16);
  }
  assert.equal(timeline.retainedFrame, 97);
  assert.equal(timeline.used.size, 4);
  assert.equal(timeline.actual.size, 3);
  assert.equal(timeline.receive(packet(1, 1)).status, 'stale');
  assert.equal(timeline.canHash(97), true);
  assert.equal(timeline.canHash(96), false);
});

test('retains replay inputs behind a sparse checkpoint without expanding prediction', () => {
  const timeline = makeTimeline({ maxRollbackFrames: 36, retentionFrames: 48 });
  for (let frame = 1; frame <= 211; frame++) {
    timeline.receive(packet(1, frame));
    tick(timeline);
  }
  assert.equal(timeline.retainedFrame, 163);
  // The runtime can move a mismatch back to the closest sparse checkpoint.
  timeline.earliestMismatch = 175;
  assert.deepEqual(timeline.beginRollback(), {
    restoreFrame: 174, fromFrame: 175, throughFrame: 211,
  });
});

test('relay authenticates slots and enforces wall-clock/gap bounds', () => {
  const relay = new InputRelay({ match: 'test', players: 2, startAt: 1000 });
  assert.throws(() => relay.receiveInput(0, packet(1, 1), 1100), { code: 'slot' });
  assert.throws(() => relay.receiveInput(0, packet(0, 1), 900), { code: 'time' });
  assert.throws(() => relay.receiveInput(0, packet(0, 20), 1100), { code: 'future' });
  assert.throws(() => relay.receiveInput(0, packet(0, 71), 10000), { code: 'gap' });
  assert.equal(relay.receiveInput(0, packet(0, 2, 8), 1100).status, 'accepted');
  assert.equal(relay.contiguous[0], 0);
  relay.receiveInput(0, packet(0, 1, 8), 1100);
  assert.equal(relay.contiguous[0], 2);
  assert.equal(relay.receiveInput(0, packet(0, 1, 8), 1100).status, 'duplicate');
  assert.throws(() => relay.receiveInput(0, packet(0, 1, 16), 1100), { code: 'conflict' });
  assert.equal(relay.confirmedFrame, 0);
  relay.receiveInput(1, packet(1, 1), 1100);
  assert.equal(relay.confirmedFrame, 1);
  assert.deepEqual(relay.timedOutSlots(21101), [0, 1]);
});

test('relay compares hashes only after all inputs exist at the same checkpoint', () => {
  const relay = new InputRelay({ match: 'test', players: 2, hashInterval: 1 });
  const hash = { type: 'hash', match: 'test', frame: 1, hash: '00000001' };
  assert.equal(relay.receiveHash(0, hash).status, 'waiting-inputs');
  assert.throws(() => relay.receiveHash(0, { ...hash, frame: 71 }), { code: 'unconfirmed-hash' });
  relay.receiveInput(0, packet(0, 1), 100);
  relay.receiveInput(1, packet(1, 1), 100);
  assert.equal(relay.receiveHash(0, hash).status, 'waiting');
  assert.equal(relay.receiveHash(1, hash).status, 'verified');
  assert.throws(() => relay.receiveHash(1, { ...hash, hash: '00000002' }), { code: 'conflict' });
  relay.receiveInput(0, packet(0, 2), 100);
  relay.receiveInput(1, packet(1, 2), 100);
  relay.receiveHash(0, { ...hash, frame: 2 });
  assert.equal(relay.receiveHash(1, { ...hash, frame: 2, hash: '00000002' }).status, 'desync');
  assert.equal(relay.stopped, true);
});

function inputAt(slot, frame) {
  let mask = ((Math.floor((frame + slot * 11) / 13) % 3) === 0) ? 2 : 8;
  if ((frame + slot * 17) % 29 < 3) mask |= 1;
  if ((frame + slot * 3) % 11 < 5) mask |= 16;
  if ((frame + slot * 5) % 79 === 0) mask |= 32;
  return mask;
}

// A stateful deterministic fixture: motion, RNG, spawns, damage and removals.
// This validates rollback orchestration, not Ruffle's state restoration.
function createModel(players) {
  return { rng: 1234567, frame: 0, actors: Array.from({ length: players }, (_, slot) => ({ x: slot * 41, v: 0, hp: 100 })), shots: [] };
}
function step(model, masks) {
  model.frame++;
  model.actors.forEach((actor, slot) => {
    const mask = masks[slot];
    actor.v = Math.max(-4, Math.min(4, actor.v + ((mask & 8) ? 1 : 0) - ((mask & 2) ? 1 : 0)));
    actor.x = (actor.x + actor.v + ((mask & 1) ? 2 : 0) + 256) % 256;
    if (mask & 16) {
      model.rng = model.rng * 16807 % 2147483647;
      model.shots.push({ owner: slot, x: actor.x, power: 1 + model.rng % 7, life: 9 });
    }
    if (mask & 32) actor.hp = Math.min(100, actor.hp + 2);
  });
  for (const shot of model.shots) {
    shot.x = (shot.x + 7) % 256;
    shot.life--;
    model.actors.forEach((actor, slot) => {
      if (slot !== shot.owner && Math.abs(actor.x - shot.x) < 8) {
        actor.hp -= shot.power;
        if (actor.hp <= 0) { actor.hp = 100; actor.x = slot * 41; actor.v = 0; }
        shot.life = 0;
      }
    });
  }
  model.shots = model.shots.filter(shot => shot.life > 0);
}
const copy = value => JSON.parse(JSON.stringify(value));
function hash(value) {
  let result = 2166136261;
  for (const char of JSON.stringify(value)) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return (result >>> 0).toString(16).padStart(8, '0');
}

function simulate(players, maxFrames, mode) {
  let random = 194733;
  const rand = () => (random = random * 16807 % 2147483647) / 2147483647;
  const latency = () => 50 + rand() * 150;
  const events = [];
  const schedule = (at, fn) => { events.push({ at, fn }); };
  const relay = new InputRelay({ match: 'test', players });
  const clients = Array.from({ length: players }, (_, localSlot) => ({
    timeline: new InputTimeline({ match: 'test', players, localSlot, maxRollbackFrames: 24 }),
    model: createModel(players), snapshots: new Map([[0, createModel(players)]]),
    rollbacks: 0, replayed: 0, maxDepth: 0, pauses: 0, lastHash: 0,
  }));
  const verified = new Set();
  let now = 0;
  function emitHash(client) {
    const timeline = client.timeline;
    const eligible = Math.floor(Math.min(timeline.frame, timeline.confirmedFrame) / 35) * 35;
    for (let frame = client.lastHash + 35; frame <= eligible; frame += 35) {
      if (!timeline.canHash(frame)) continue;
      const message = { type: 'hash', match: 'test', frame, hash: hash(client.snapshots.get(frame)) };
      schedule(now + latency(), () => {
        const result = relay.receiveHash(timeline.localSlot, message);
        assert.notEqual(result.status, 'desync', `hash diverged at frame ${frame}`);
        if (result.status === 'verified') verified.add(frame);
      });
      client.lastHash = frame;
    }
  }
  function apply(client) {
    const input = client.timeline.advance();
    step(client.model, input.masks);
    client.snapshots.set(input.frame, copy(client.model));
    for (const frame of client.snapshots.keys()) if (frame < client.timeline.retainedFrame) client.snapshots.delete(frame);
    return input;
  }
  function receive(client, message) {
    client.timeline.receive(message);
    const plan = client.timeline.beginRollback();
    if (plan) {
      client.rollbacks++;
      client.maxDepth = Math.max(client.maxDepth, plan.throughFrame - plan.restoreFrame);
      client.model = copy(client.snapshots.get(plan.restoreFrame));
      for (let frame = plan.fromFrame; frame <= plan.throughFrame; frame++) { apply(client); client.replayed++; }
    }
    emitHash(client);
  }
  function send(client, message) {
    let delay = latency();
    if (mode === 'outage' && message.slot === 1 && message.frame >= 350 && message.frame <= 380) delay += 1100;
    schedule(now + delay, () => {
      const result = relay.receiveInput(client.timeline.localSlot, message, now);
      if (result.status !== 'accepted') return;
      for (const resultHash of result.hashResults) {
        assert.notEqual(resultHash.status, 'desync', `delayed hash diverged at frame ${resultHash.frame}`);
        if (resultHash.status === 'verified') verified.add(resultHash.frame);
      }
      for (const recipient of clients) {
        schedule(now + latency(), () => receive(recipient, result.message));
        if (rand() < 0.07) schedule(now + latency(), () => receive(recipient, result.message));
      }
    });
  }
  function tickClient(client) {
    if (client.timeline.frame >= maxFrames) return;
    if (client.timeline.canAdvance) {
      const mask = inputAt(client.timeline.localSlot, client.timeline.frame + 1);
      send(client, client.timeline.captureLocal(mask));
      const input = apply(client);
      assert.equal(input.masks[client.timeline.localSlot], mask, 'local input waited for the server');
      emitHash(client);
    } else client.pauses++;
    schedule(now + 1000 / 35, () => tickClient(client));
  }
  for (const client of clients) schedule(1000 / 35 + rand() * 8, () => tickClient(client));
  while (events.length) {
    events.sort((a, b) => b.at - a.at);
    const event = events.pop();
    now = event.at;
    assert.ok(now < (maxFrames + 1000) * 1000 / 35, 'simulation stalled');
    event.fn();
  }
  const baseline = createModel(players);
  for (let frame = 1; frame <= maxFrames; frame++) step(baseline, Array.from({ length: players }, (_, slot) => inputAt(slot, frame)));
  for (const client of clients) {
    assert.equal(client.timeline.confirmedFrame, maxFrames);
    assert.deepEqual(client.model, baseline);
    assert.ok(client.rollbacks > 100);
    assert.ok(client.maxDepth <= 24);
    assert.ok(client.timeline.actual.size <= 24);
  }
  assert.equal(verified.size, Math.floor(maxFrames / 35));
  if (mode === 'outage') assert.ok(clients.some(client => client.pauses > 0));
  else assert.ok(clients.every(client => client.pauses === 0));
  return clients.map(({ rollbacks, replayed, maxDepth, pauses }) => ({ rollbacks, replayed, maxDepth, pauses }));
}

for (const players of [2, 4]) test(`${players} players converge with 50–200 ms per-link jitter, out-of-order packets and duplicates`, t => {
  t.diagnostic(JSON.stringify(simulate(players, 1050, 'jitter')));
});
test('a 1.1 second interruption pauses bounded prediction then recovers without divergence', t => {
  t.diagnostic(JSON.stringify(simulate(4, 700, 'outage')));
});

test('lockstep relay finalizes one authoritative row and turns missing input neutral', () => {
  const { LockstepRelay } = require('./rollback-inputs.js');
  const relay = new LockstepRelay({ match: 'lock', players: 3, maxFutureFrames: 12 });
  assert.equal(relay.receiveInput(0, packet(0, 1, 8, 'lock'), 10).status, 'accepted');
  assert.equal(relay.receiveInput(0, packet(0, 1, 8, 'lock'), 11).status, 'duplicate');
  assert.equal(relay.receiveInput(0, packet(0, 1, 10, 'lock'), 12).status, 'updated');
  assert.equal(relay.stats.inputUpdates, 1);
  assert.equal(relay.receiveInput(1, packet(1, 1, 16, 'lock'), 10).status, 'accepted');
  const frame = relay.finalizeNext();
  assert.deepEqual(frame, { type: 'frame', match: 'lock', frame: 1, masks: [10, 16, 0], fallbackSlots: [2] });
  assert.equal(relay.confirmedFrame, 1);
  assert.equal(relay.stats.fallbackFrames, 1);
  assert.equal(relay.stats.fallbackInputs, 1);
  assert.equal(relay.receiveInput(2, packet(2, 1, 32, 'lock'), 20).status, 'stale');
  assert.equal(relay.stats.lateInputs, 1);
});

test('lockstep client simulates finalized frames exactly once and buffers out-of-order arrivals', () => {
  const { LockstepTimeline } = require('./rollback-inputs.js');
  const timeline = new LockstepTimeline({ match: 'lock', players: 3, localSlot: 1 });
  assert.deepEqual(timeline.makeLocalInput(4, 8), { type: 'input', match: 'lock', slot: 1, frame: 4, mask: 8 });
  assert.equal(timeline.receiveFrame({ type: 'frame', match: 'lock', frame: 2, masks: [1, 2, 3], fallbackSlots: [] }).status, 'accepted');
  assert.equal(timeline.hasNext, false);
  assert.equal(timeline.receiveFrame({ type: 'frame', match: 'lock', frame: 1, masks: [4, 5, 6], fallbackSlots: [2] }).status, 'accepted');
  assert.equal(timeline.bufferedFrames, 2);
  assert.deepEqual(timeline.advance(), { frame: 1, masks: [4, 5, 6, 0], fallbackSlots: [2] });
  assert.deepEqual(timeline.advance(), { frame: 2, masks: [1, 2, 3, 0], fallbackSlots: [] });
  assert.equal(timeline.receiveFrame({ type: 'frame', match: 'lock', frame: 2, masks: [1, 2, 3], fallbackSlots: [] }).status, 'stale');
});

test('lockstep grace stops waiting after a player repeatedly misses deadlines', () => {
  const { LockstepRelay } = require('./rollback-inputs.js');
  const relay = new LockstepRelay({ match: 'lock', players: 2, maxFutureFrames: 12 });
  relay.receiveInput(0, packet(0, 1, 8, 'lock'), 100);
  relay.receiveInput(1, packet(1, 1, 0, 'lock'), 100);
  relay.finalizeNext();
  relay.receiveInput(0, packet(0, 2, 8, 'lock'), 120);
  assert.equal(relay.shouldGrace(2, 130, 500, 1), true);
  assert.deepEqual(relay.finalizeNext().fallbackSlots, [1]);
  relay.receiveInput(0, packet(0, 3, 8, 'lock'), 140);
  assert.equal(relay.shouldGrace(3, 150, 500, 1), true);
  relay.finalizeNext();
  relay.receiveInput(0, packet(0, 4, 8, 'lock'), 160);
  assert.equal(relay.shouldGrace(4, 170, 500, 1), false);
});

test('three lockstep clients stay identical through missing and late inputs without replay', () => {
  const { LockstepRelay, LockstepTimeline } = require('./rollback-inputs.js');
  const relay = new LockstepRelay({ match: 'lock', players: 3, maxFutureFrames: 70 });
  const clients = Array.from({ length: 3 }, (_, localSlot) => new LockstepTimeline({ match: 'lock', players: 3, localSlot }));
  let late = 0;
  for (let frame = 1; frame <= 500; frame++) {
    for (let slot = 0; slot < 3; slot++) {
      if ((frame + slot * 11) % 47 === 0) continue; // deterministic packet miss
      relay.receiveInput(slot, packet(slot, frame, (frame * 3 + slot * 7) & 63, 'lock'), frame * 10);
    }
    const authoritative = relay.finalizeNext();
    for (const client of clients) {
      assert.equal(client.receiveFrame(authoritative).status, 'accepted');
      assert.deepEqual(client.advance().masks.slice(0, 3), authoritative.masks);
    }
    // A packet that arrives after finalization is discarded rather than replayed.
    if (authoritative.fallbackSlots.length) {
      for (const slot of authoritative.fallbackSlots) {
        assert.equal(relay.receiveInput(slot, packet(slot, frame, 63, 'lock'), frame * 10 + 9).status, 'stale');
        late++;
      }
    }
  }
  assert.equal(clients.every(client => client.frame === 500), true);
  assert.equal(relay.stats.lateInputs, late);
  assert(relay.stats.fallbackFrames > 0);
});
