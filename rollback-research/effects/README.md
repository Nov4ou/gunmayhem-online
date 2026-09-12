# Ruffle 0.6.0 rollback effects experiment

These adapters run with the modern externref build patched by `../state/patch.cjs`.
They preserve the original SWF and original Rust audio mixer. No production
file or installed Ruffle package is modified by these experiments.

Load `state/snapshot.js`, `state/clock.js`, `effects/audio.js`,
`effects/webgl-compact.js`, then patched Ruffle. `compact.js` is a convenience
loader for the isolated probe. Do not load `webgl.js` and `webgl-compact.js`
together: both register the `webgl` participant.

## Audio

Pinned Ruffle uses two PCM buffers, initially 2,048 stereo samples each, and
refills them from its Rust `AudioMixer` in JavaScript `onended` callbacks.
It does not create one WebAudio source per gunshot. Consequently retaining
externref objects and muting replay alone would restore mixer state while
leaving real device time and already queued callbacks on the discarded branch.

`audio.js` substitutes snapshot-aware virtual sources. Only simulation ticks
invoke their completion callbacks, at exact PCM sample boundaries. Real audio
sources have no callback into WASM. PCM buffers, virtual source properties,
completion queues, and simulation audio time participate in snapshots. The
original Rust mixer and original sample data are retained.

Call `RuffleRollbackAudio.setAudible(true)` when a real-time match starts. Fast
boot is inaudible. Device playback has a separate timeline that is never rolled
back. Recomputed chunks replace scheduled, not-yet-playing chunks; already
played chunks are suppressed to prevent duplication.

**Limit:** this deduplicates mixed PCM chunks, not individual gameplay sounds.
A newly corrected remote sound in an already audible chunk cannot be emitted
in isolation, and an already heard incorrect predicted sound cannot be undone.
Individual sound-event deduplication needs a hook before the Rust mixer, not a
WebAudio source filter. Do not claim exact audio-event reconciliation.

## WebGL

`webgl-compact.js` targets actual `wgpu-webgl` / WebGL2. It keeps the latest
driver state, immutable checkpoint versions of CPU buffer mirrors and packed
2D texture pixels, program uniforms, sampler parameters, VAO attributes, and
framebuffer attachment state. Buffer sub-data and GPU-to-GPU buffer copies
update the corresponding CPU mirrors. Only changed resources are uploaded on
restore. GL bindings are restored after resource uploads and uniform changes.

Native GL deletion is deferred while older checkpoints or active GL bindings
retain a resource. Checkpoints created after a logical deletion do not keep
retaining that object forever. Abandoned future resources are reclaimed after
the last referencing checkpoint is released. Without checkpoints, collection
is batched every four simulation frames; checkpoint release also collects.

There is no per-frame command history. Current mirrors are approximately 30 MB
for the tested Gun Mayhem map, mainly original meshes and textures. Checkpoints
share unchanged versions; changed buffers and textures use copy-on-write.

`webgl.js` is an earlier reference implementation that replays complete state
command history. It should only be used as a short correctness baseline: its
retained history and native resources grow over time.

**Boundaries:** render-target pixels are reconstructed by the next complete
Ruffle clear/render pass. Pixel readback into game logic, 3D/compressed texture
mutations, transform feedback, and unsupported pixel formats that cross a
checkpoint cause an explicit restore error. These are not silently skipped.
This adapter is not a general-purpose WebGL context serializer. The tested
Gun Mayhem rendering path reports no unsupported mutations.

## Verification

Run:

```
node rollback-research/effects/audio.test.cjs
node rollback-research/effects/webgl.test.cjs
node rollback-research/effects/webgl-compact.test.cjs
GM_GPU=1 GM_ROLLBACK_FRAMES=14 GM_ROLLBACK_EFFECTS=compact.js \
  GM_ROLLBACK_LABEL=effects-compact-timing node rollback-research/probe.cjs
```

Mock tests cover audio clock independence, mutable PCM restoration, prevention
of real callbacks entering WASM, replacement/deduplication, overlapping GPU
checkpoints, driver binding/uniform restoration, buffer copies, texture patch
merging, deferred deletion, future cleanup, and constant storage across 100
repeated rollback cycles.

The real WebGL runs report `wgpu-webgl`, no unsupported mutations, and matching
complete game state after deliberately wrong prediction followed by correction.
Rendering every replay frame produces byte-identical final PNGs. Production skips
hidden intermediate rendering for latency; in the 70-frame repeated seven-frame
rollback test this leaves 382 of 540,000 pixels with small RGB differences on an
explosion's antialiased transparent edge (maximum channel delta 31, unchanged
alpha). Assets, layout, simulation, collisions and results remain identical.

Inspect `RuffleRollbackGL.diagnostics()` for resource counts, retained bytes,
unsupported operations, and `timings`. `RuffleRollbackAudio.diagnostics()`
reports virtual queue size, mixed chunks, device submissions and suppression.

Pinned sources inspected:

- `https://raw.githubusercontent.com/ruffle-rs/ruffle/v0.6.0/web/src/audio.rs`
- `https://raw.githubusercontent.com/ruffle-rs/ruffle/v0.6.0/render/webgl/src/lib.rs`
- Local extracted modern wasm-bindgen glue under `research-net/bundle-source/`.

The audio/graphics adapters must be paired with closure-state snapshots from
the state experiment. Merely copying WASM memory and the externref table leaves
JavaScript closure `{a,b,cnt}` mutations and finalizer effects unrestored.
