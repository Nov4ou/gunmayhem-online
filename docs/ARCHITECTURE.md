# Architecture

## Runtime model

Gun Mayhem runs independently in every player's browser through the same pinned Ruffle runtime and the same network-enabled SWF. The Node.js service manages rooms and establishes the order of inputs. It does not run the Flash simulation, render frames, mix audio, or stream media.

The original movie advances at 35 frames per second. Before advancing frame `N`, each client must receive the same authoritative input row for frame `N`. The row contains one six-bit mask per seat:

| Bit | Input |
| ---: | --- |
| 0 | Up / jump |
| 1 | Left |
| 2 | Down |
| 3 | Right |
| 4 | Fire |
| 5 | Grenade |

Keyboard and multi-touch controls both produce this same mask. Touch input therefore uses the existing lockstep path and does not add a separate mobile simulation or protocol.

The ActionScript bridge overrides the input lookup used by the game and supplies a seeded Park-Miller random stream. This gives every client the same input and random value at the same simulation point.

## Authoritative lockstep

The server's `LockstepRelay` owns the next frame number. Clients may queue input within a bounded future window. While a row remains pending, its owner may revise that input; after finalization the row is immutable and late messages are discarded.

The server normally waits a short grace period for an active peer. If an input is still missing, it finalizes that seat as neutral. This prevents one backgrounded tab or overloaded browser from stopping the room. Each broadcast row includes the neutralized seat numbers so clients can report fallback behavior.

Input is scheduled ahead of the server frame:

- Two players: one frame
- Three players: one frame
- Four players: three frames

A browser key edge immediately revises the pending horizon row. This avoids waiting for the next 35 Hz input sampling point when the target row has not yet finalized.

## Client scheduler

The browser buffers authoritative rows and simulates each row exactly once. When it falls behind, it processes queued rows without presenting every intermediate frame or submitting every intermediate audio block. The final current frame is rendered and audio scheduling returns to real time.

The production scheduler does not predict remote input and does not rewind completed frames. The state, page, audio, and WebGL checkpoint modules remain in the repository because they document and test the earlier rollback design and are still useful for future experiments.

Ruffle selects between its modern WebAssembly build and a scalar compatibility build at startup. Both files are packaged. The modern build retains render-skip instrumentation; the scalar build omits that optional optimization and renders catch-up frames normally. Production lockstep does not capture or restore memory, so Safari can safely skip the SIMD checkpoint helper when that instruction set is unavailable.

## Consistency checks

Once per second, clients report a lightweight state containing the network frame, original update count, and root timeline position. The server compares reports only for a common finalized frame. A mismatch terminates the match instead of allowing visibly divergent simulations to continue.

The SWF build process separately verifies that stage metadata and all non-script tags match the supplied original movie. Only ActionScript bridge code changes.

## Diagnostics

`gunmayhemDiagnostics()` combines outer-page connection metrics with runtime metrics. The most useful fields are:

- WebSocket RTT and software keydown-to-presentation latency
- Buffered and catch-up frames
- Neutral fallback frames and inputs
- Frame arrival gaps and long simulation frames
- Audio lateness and dropped blocks
- WebGL resource and timing counters

The spike recorder keeps a fixed pre-trigger ring buffer, records a short post-trigger window, and freezes the result. It can trigger on long simulation work, backlog, repeated fallback, or late audio.
