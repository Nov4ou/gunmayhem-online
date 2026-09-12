# Original SWF multiplayer clock research

The production clock is `../public/ruffle-clock.js`. It must execute inside the
game iframe before the pinned `@ruffle-rs/ruffle` **0.6.0** bundle is loaded.
It never schedules a real animation frame. `GunMayhemClock.advance()` releases
the queued Ruffle animation callback at exactly the next 35 FPS timestamp.
The callback continues through Ruffle's normal complete movie frame processing,
including native display lists, timeline animations, actions, and rendering.

The frame rate **35 FPS** comes from the SWF header. Do not change it to 30 FPS.

## Interfaces

- `advance()`: exactly one fixed time increment; call once after applying each
  ordered server input. Throws if Ruffle has no queued callback.
- `flush()`: runs pending callbacks without advancing time; only for bootstrap
  and painting, never used as a game tick.
- `snapshot()`: `{frame,timestamp,queued,lastCallbackCount}` diagnostics.
- `realNow()`: the original browser clock for diagnostic deadlines.

`performance.now()` and no-argument `Date` are simulated, so AS2 `getTimer()` and
the original FPS display do not depend on frame arrival time. Explicit Date
arguments remain unchanged. The lobby runs in the parent window and keeps its
ordinary clock.

A capture listener suppresses `visibilitychange` in this isolated iframe. This
is necessary because Ruffle 0.6.0 otherwise switches to an independent Worker
timer when the document is hidden, or suspends the player. Neither behavior is
valid for server-controlled input lockstep.

## Actual validation

`node research-net/test-clock.cjs` serves a minimal generated AS2 SWF to two
independent headless Chromium/Ruffle instances. Each receives 2,100 fixed ticks;
the second instance receives them in separate batches with a real wall-clock
delay. The complete per-frame trace streams (counter and `getTimer`) are
identical. There are exactly 2,099 `onEnterFrame` callbacks after the first
initialization frame, and the final game timer is 60,000 milliseconds.

`make-probe.py` builds that tiny test movie without third-party Flash authoring
tools. `clock-probe.html` is the test page. These are research fixtures, not
production site assets.

The test initially exposed that setting `traceObserver` before `load()` is
ineffective: set it after `await load()` because the actual runtime instance is
created during loading.

## Why no public single-frame API

The official versioned player API only offers suspend/resume, not frame stepping
or random seed control. The 0.6.0 Wasm glue does contain internal
`enable_background_tick_mode()` and `tick_for_background(timestamp)` methods,
but the owning runtime is hidden in a WeakMap. Intercepting the iframe's RAF
entry point avoids patching that private JavaScript structure.

Ruffle's web tick obtains `dt` by subtracting the previous RAF timestamp and then
calls the core tick. The core accumulates `dt`, runs full movie frames, updates
timers and audio, and renders. A 0.001 ms positive remainder is added once to the
first nonzero timestamp to avoid boundary rounding below a full frame; it is
not added per frame.

## Limits requiring game-level validation

- This is input lockstep, not rollback. All clients must start from the same
  movie frame, seed, map, profiles, and persistent settings.
- Native random opcodes and `Math.random` require the game patch's shared seeded
  generator. Merely overriding browser `Math.random` cannot control AVM1 random.
- Asynchronous audio callbacks or external resource loads could change gameplay
  if the movie used them. The game patch must audit their presence.
- Ruffle may adjust its frame accumulator to synchronize streaming timeline
  audio. A recursive scan of this SWF found 61 DefineSound and 61 StartSound tags,
  and **zero SoundStreamBlock tags**. Thus this movie uses event sounds rather
  than a streamed timeline track, avoiding that known source of frame skew.
- Real audio playback is intentionally preserved. Late network input delays the
  game; large catch-up batches may produce closely spaced sound events.
- Client state checksums and real movie frame counts must be checked during
  multiplayer tests, especially across different browsers and under throttling.
- Pin the bundle version. Re-run the probe and game determinism tests before
  upgrading Ruffle.

## Primary sources inspected

- [Ruffle public PlayerV1 API](https://ruffle.rs/js-docs/master/interfaces/Player.PlayerV1.html)
- [Official web tick and background mode](https://github.com/ruffle-rs/ruffle/blob/master/web/src/lib.rs)
- [Core frame accumulator and full movie frame execution](https://github.com/ruffle-rs/ruffle/blob/master/core/src/player.rs)
- [Audio stream skew calculation](https://github.com/ruffle-rs/ruffle/blob/master/core/src/backend/audio.rs)
- [AVM1 getTimer implementation](https://github.com/ruffle-rs/ruffle/blob/master/core/src/avm1/activation.rs)
- [AVM random generator](https://github.com/ruffle-rs/ruffle/blob/master/core/src/avm_rng.rs)
- The locally installed 0.6.0 bundle and its published source maps, extracted into
  `bundle-source/`, confirming the background methods and visibility handler
  actually present in the deployed version rather than relying only on master.
