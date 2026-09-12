# Rollback input protocol

This directory contains the deployed input prediction, confirmation, correction and
server relay. The complete Ruffle checkpoint implementation is in `../state/`, the
browser integration is in `../runtime.js`, and audio/WebGL restoration is in
`../effects/`. The isolated tests and the two-browser original-SWF tests cover the
complete boundary.

`rollback-inputs.js` exports `{ InputTimeline, InputRelay, ProtocolError }` through
CommonJS, or `globalThis.GunMayhemRollback` when loaded as a browser script. It has no
transport, DOM, Ruffle or Node dependency.

Run the tests from the project directory:

```sh
node --test rollback-research/netcode/rollback-inputs.test.cjs
```

## Wire protocol

Keep the existing room creation, join, settings, load and host-control messages.
For a rollback match, replace the server's 35 Hz sampled-mask `tick` broadcast with:

```js
// Player -> server, once for every simulated new frame, even when unchanged.
{ type: 'input', match: 'opaque-match-id', slot: 0, frame: 1, mask: 8 }

// Server -> every player, including the sender: the exact accepted input.
{ type: 'input', match: 'opaque-match-id', slot: 0, frame: 1, mask: 8 }

// Player -> server, once per chosen confirmed checkpoint, e.g. every 35 frames.
{ type: 'hash', match: 'opaque-match-id', frame: 35, hash: '12345678' }
```

The server passes the slot from its authenticated room membership to
`relay.receiveInput(client.slot, message, performance.now())`. A client's packet
cannot choose a different player's slot. Broadcast only `result.message` when
`result.status === 'accepted'`. Treat a conflicting repeated input as a protocol
error and abort that match; never overwrite history.

`InputRelay` rejects another match, invalid masks/slots/frames, excessive future
frames, and gaps exceeding its bound. It accepts out-of-order frames and matching
duplicates. Pruned confirmed inputs return `stale` without changing state. The
default allowed future lead is eight frames relative to the server's match clock;
the default per-player gap bound is 70 frames. These are abuse bounds, not added
input delays.

Only the client predicts inputs. The server neither predicts nor simulates. An
unchanged mask must still be sent for every frame so that absent packets cannot be
mistaken for confirmed held keys.

## Client integration

Run local frames using a real-time clock at the game's original 35 fps. Do not
wait for any server echo before applying a local input. The frame rate still means
a newly pressed key is sampled within approximately 28.6 ms; there is no added
network round trip before the local response.

Initialization:

```js
const inputs = new GunMayhemRollback.InputTimeline({
  match, players, localSlot,
  maxRollbackFrames: 24, // Must fit measured checkpoint memory and replay cost.
});
// Checkpoint 0 is after identical netStart setup and before input frame 1.
const checkpoints = new Map([[0, runtime.checkpoint()]]);
```

On a network input, call `inputs.receive(message)` and schedule processing. It
records the earliest mismatching frame. Several packets should be coalesced before
one correction, rather than replaying once for each packet.

Before the next real-time simulation tick:

```js
const correction = inputs.beginRollback();
if (correction) {
  runtime.restore(checkpoints.get(correction.restoreFrame));
  runtime.beginReplay();
  for (let frame = correction.fromFrame; frame <= correction.throughFrame; frame++) {
    const input = inputs.advance();
    runtime.step(input.frame, input.masks);
    checkpoints.set(input.frame, runtime.checkpoint());
  }
  runtime.endReplay();
}

if (inputs.canAdvance && realClockSaysNextFrameIsDue()) {
  const message = inputs.captureLocal(currentKeyboardMask());
  socket.send(JSON.stringify(message));
  const input = inputs.advance();
  runtime.step(input.frame, input.masks);
  checkpoints.set(input.frame, runtime.checkpoint());
}

for (const frame of checkpoints.keys()) {
  if (frame < inputs.retainedFrame) checkpoints.delete(frame);
}
```

The runtime methods in this example describe the boundary implemented by the pinned,
patched Ruffle build. `step` runs the identical original SWF frame,
including deterministic timers and RNG. `checkpoint`/`restore` must cover the
complete state. `beginReplay`/`endReplay` must handle renderer and sound side
effects correctly. New network packets arriving during an asynchronous restore or
replay should be queued until that correction completes.

Replays do not call `captureLocal`, resample the keyboard, or send old local inputs
again. They reuse each frame's originally recorded local input. Remote inputs use
their actual value when present, otherwise the previous simulated frame's value.

Only present the corrected final frame; intermediate replay frames are internal.
If no correction is necessary, arriving network input does not cause an extra
render. This separates visual pacing from network packet bursts.

## Confirmation and state hashes

`confirmedFrame` means every slot has an actual input for every frame up to that
number. A later actual frame does not fill an earlier missing frame. Confirmation
alone does not mean the currently stored runtime state has incorporated the new
inputs: a pending correction can still make it stale.

Use `inputs.canHash(frame)` before hashing the checkpoint for that **exact** frame.
It requires confirmed inputs, an existing retained frame, and no uncorrected
mismatch at or before that checkpoint. The hash must describe the restored/replayed
state at that frame; hashing the current live state and labeling it with an older
confirmed number is incorrect.

`relay.receiveHash(client.slot, message)` compares only matching checkpoint
numbers. On an unordered transport, a valid hash may overtake the sender's own
input. The relay bounds and holds such hashes with `waiting-inputs`; it does not
compare them before confirmation. `receiveInput` returns `hashResults` when newly
confirmed input lets a pending hash be verified. Both that list and the direct
`receiveHash` result must be checked for `desync`. A desync stops the relay and
should stop the room with a diagnostic, rather than continuing divergent games.

WebSocket already orders packets on each connection, but handling reordering here
also makes the state machine usable with another reliable delivery layer later.

## Start time, stalls and disconnects

Existing `begin` receipt times differ between players. Prefer a future shared
server start time, after all clients finish loading, plus several small clock
offset probes. Use the parent's captured real `performance.now()`, not Ruffle's
virtual simulation clock. Server `startAt` must use the same monotonic time basis
as its calls to `receiveInput`.

Once started, local wall time determines frame pacing. Avoid unbounded catch-up
loops after a hidden tab or long stall. If `canAdvance` is false because predicted
history reached the rollback window, freeze at the last retained simulation frame
while receiving and correcting inputs. Do not expand the window or silently drop
the missing frames. Continue once the inputs are available, using a bounded
catch-up budget. Input scheduling and replay/render performance must be measured
with the actual runtime before choosing that budget.

On WebSocket close or player departure, call `disconnect()` and use the current
room-abort behavior. Slots remain fixed for the lifetime of a match. Reconnection
starts a new match; do not inject a returning client halfway into a running game.
The relay exposes `timedOutSlots(now)` with a default 20-second input timeout. A
server housekeeping timer can stop abandoned matches. Existing WebSocket
heartbeat, connection/rate limits, room and match identity checks still apply.

Do not finish a match on a speculative winner/result frame. First correct all
input up to that result and confirm the relevant checkpoint; then use the
existing original result-screen flow. A wrongly predicted attack can otherwise
end the match before its rollback arrives.

## Verification results

Eleven tests pass, including local input before any server response, earliest
correction, contiguous confirmation, hash gating, duplicate/conflicting/stale
packets, future/gap bounds, retained history, bounded stalls, disconnects, and
server-side hash checks.

The deterministic simulation fixture includes motion, RNG-dependent projectile
spawns, collisions, damage, respawning and object removal. Its final complete
state and every 35-frame confirmed hash match a no-network baseline:

| Scenario | Frames per client | Maximum correction | Paused ticks |
| --- | ---: | ---: | ---: |
| 2 players, 50–200 ms delay on each network leg | 1,050 | 14 frames | 0 |
| 4 players, 50–200 ms delay on each network leg | 1,050 | 14 frames | 0 |
| 4 players, same jitter plus 1.1 s input interruption | 700 | 24 frames | 17–27 |

The two relay legs produce 100–400 ms of remote-input delay. Packets are also
delivered out of order and sometimes duplicated. The interruption test pauses at
the window bound and then converges. All local inputs affect the intended frame
without waiting for the server.

This is a functional protocol test, not a browser benchmark. The fixture
deliberately corrects on every packet to stress restore/replay bookkeeping. The
four-player jitter case performs about eleven replayed fixture frames per new
frame; coalescing packets is therefore important. Actual Ruffle CPU, checkpoint
memory, audio correctness and visual smoothness remain separate acceptance tests.
