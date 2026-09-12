# Ruffle whole-instance checkpoint experiment

This directory is an isolated prototype for the exact `@ruffle-rs/ruffle@0.6.0`
modern bundle used by this project. It does not rewrite AVM1 gameplay and does
not approximate state with player positions.

## Files and entry points

- `patch.cjs`: a server-side transform of the pinned modern core JS and WASM.
  Exports `patchCore`, `patchWasm`, `CORE_FILE`, `WASM_FILE`. Source-marker counts
  fail closed if the bundle changes. The npm installation remains unmodified.
- `snapshot.js`: load before Ruffle and before the replacement clock. It defines
  `RuffleRollback.capture()`, `restore(token)`, `release(token)`, `inspect()`,
  `inspectExternrefs()`, and `reserveMemory(megabytes)`.
- `clock.js`: replaces the production deterministic clock only in the experiment.
  `GunMayhemClock.setReplay(true)` tells participants that the next ticks are
  re-executing an earlier interval; the simulation time is still the original
  virtual time. `setReplay(false)` resumes ordinary output.

`registerParticipant(name, hooks)` adds browser-side state. Hooks are `capture`,
`beforeRestore`, `restore`, `release`, `beforeTick(info)`, `afterTick(info)`.
`info` contains `frame`, `timestamp`, `replay`. Capture/restore hooks must not
invoke a new simulation tick. `importWrapper(imports)` can be assigned to wrap
the wasm-bindgen imports before instantiation.

`GunMayhemClock.advance({render: false})` skips the entire native rendering block
for one hidden replay frame; pass `{render: true}` for the final visible frame.
The option restores the flag afterward even on a trap. Alternatively use
`RuffleRollback.setRenderSkipped(boolean)` explicitly. The default is ordinary
rendering. Rendering control is host policy and is not part of saved game state.

An optional `RuffleRollback.memoryStore = {capture(memory), restore(memory, token),
release(token)}` replaces full-copy storage; `memory` is the `WebAssembly.Memory`
instance. Each snapshot retains its original store so subsequent release uses
the matching implementation. `memoryBytes` remains independently checked.

## Actual checkpoint boundary

1. All linear memory, including the Rust allocator, player structs, AVM1 and
   AVM2 heaps, GC allocation lists and collection progress, random generator,
   frame accumulator, timers, ActionScript variables, native movie clips,
   display lists, audio mixer, render backend caches, and Rust closure payloads.
2. All three WASM globals. The distributed bundle only exports two; the hidden
   third global is exported by the binary patch. Snapshotting only memory would
   not generally cover mutable globals.
3. Both tables: the indirect function table and the externref table. The modern
   build has no JavaScript `heap_next`/heap free list: externref allocation state
   is in linear memory. Its JS referents are retained by snapshots. The indirect
   function table is retained once and shared: complete LLVM disassembly shows
   182 `table.set 1` sites and one `table.grow 1` site, with no writes, growth, fill,
   copy, or initialization instructions affecting table 0 after the module's
   active element initialization. The original glue cannot access table 0.
4. wasm-bindgen JavaScript closure bookkeeping (`a`, `b`, `cnt`) and callback
   validity. A closure created on a discarded branch becomes a no-op so that
   a queued event cannot enter a recycled Rust allocation.
5. The virtual clock, requestAnimationFrame callback queue, callback IDs, and
   timestamp. Merely rewinding the SWF while advancing RAF timestamps would
   execute extra frames and timers.
6. Browser resources and asynchronous effects, handled by registered participants
   in the separate `effects` experiment. Table snapshots retain JS references;
   they do not clone the mutable state of AudioContexts, AudioBuffers, WebGL
   textures, canvases, DOM nodes, or arbitrary JS objects.

Snapshots are only legal between completed ticks, after the SWF and static
assets have loaded, in a dedicated realm with one Ruffle instance. The prototype
rejects the MVP build because it uses a different JS-heap boundary.

## Allocator, GC, and external lifetimes

Restoring all memory also restores pointers and the memory they reference, so
no GC object relocation is needed. This is materially simpler than serializing
`GcArena` alone: `Player` also holds the RNG, input manager, frame accumulator,
backend trait objects, self references, and asynchronous resource handles outside
the arena (`research-net/ruffle-source/core/src/player.rs`, `Player`, `GcRootData`).
Copying just the arena would omit those and would require graph-aware cloning of
interior native pointers, `Rc`/`Arc` allocations, callbacks, and backend handles.

Memory cannot shrink. The prototype rejects a restore if its linear-memory size
changed after capture. `reserveMemory` allocates and frees through exported Rust
malloc/free before creating snapshots, leaving capacity visible to dlmalloc.
Direct `memory.grow()` is insufficient because it bypasses the allocator's free
lists. The reserved amount must cover the observed match peak plus headroom.

wasm-bindgen finalization registries are disabled in the patched bundle: a GC
finalizer scheduled in a discarded future must never free a restored allocation.
Explicit Rust drops still run and are rewound with memory. Snapshot release
drops retained table entries and retired closure tracking, but this experiment
does not yet establish a general-purpose lifecycle for arbitrary SWF loaders.
Mutable wrapper `__wbg_ptr` values are reported by `inspectExternrefs()` for an
explicit audit; these wrappers must remain stable after bootstrap or be covered
by a participant.

WebGL `delete*`, GPU buffer/texture mutation, WebAudio completion callbacks, pending
promises, and sound output are not reversible merely by restoring externrefs.
They require deferred deletion, restoration/reconstruction, or deterministic
virtualization. In particular, callbacks from the audio device must not advance
the restored mixer unpredictably. A passing ActionScript checksum alone cannot
prove correct audio or rendered pixels.

## Cost and validation

The first implementation copies full memory and the mutable externref table,
while sharing the proven immutable indirect function table.
It reports aggregate capture/restore timings and actual memory size. A 192 MiB
memory would consume 1.5 GiB for eight full snapshots before other browser memory;
a bounded confirmed-state anchor with reused buffers is preferable to such a ring.
Dirty-page storage is a later optimization, not a substitute for completing the
state boundary.

The parent experiment `../probe.cjs` compares a normal client against a client
that repeatedly executes deliberately incorrect inputs, restores the earlier
whole-instance checkpoint, and re-executes correct inputs. Validation must also
cover sustained GC, lazy resource registration, map changes, death/respawn,
grenades, pickups, results, render output, and audible replay behavior. This
directory by itself is not a production-ready rollback runtime.

## Native render-block patch evidence

The original modern WASM SHA-256 is
`e4ba64aa1dc9f7f2368602dd0fc2c51046f3e35baba8116d6cf3ae930a63aa02`.
Its name section identifies function 1138 as
`<ruffle_web[bad5df5bc9df1ea3]::RuffleHandle>::tick` and function 1119 as
`<ruffle_core[6c9b6b5de288a4bf]::player::Player>::tick`. `Player::render` is
inlined into the former. LLVM's WASM disassembler reports this boundary:

```text
224393: block                 ; outer block also used to skip all rendering
224395: block                 ; choose resize/ordinary tick path
        ... viewport resize path ...
2243d7: call 1119             ; original Player::tick
2243da: br 1                  ; join before rendering after inner block
2243dc: end                  ; viewport resize if
2243dd: local.get 9
2243df: local.get 40
2243e1: call 1119             ; ordinary original Player::tick
2243e4: local.get 19
2243e6: i32.load8_u 490       ; Player::needs_render
2243ea: i32.const 1
2243ec: i32.ne
2243ed: br_if 1              ; original skip-render condition
2243ef: end                  ; end inner block, both tick paths converge
         <insert global.get skip_render; br_if 0>
2243f0: i32.const 0          ; start full inlined render implementation
2243f2: local.set 23
2243f4: global.get 0
2243f6: i32.const 400
2243f9: i32.sub              ; allocate render-only stack frame
        ... full render and its original cleanup ...
225f02: end                  ; end outer block
225f03: local.get 19
225f05: i32.const 0
225f07: i32.store8 8         ; original mutex release and Rc cleanup continue
```

The transformation inserts four bytes at this boundary with no added nesting,
so existing relative branch depths and call indices stay intact. Section/body
sizes are re-encoded. The unique 32-byte marker includes the original simulation
call, `needs_render` branch, and render stack prologue; mismatch fails closed.
The resulting module is validated by `new WebAssembly.Module` in the probe.

This skips render-event broadcasting as part of the original render method.
It is scoped to the tested Gun Mayhem AVM1 movie; it is not a claim that arbitrary
SWFs with rendering-driven scripts can use the same shortcut. Skipping only
`submit_frame` without dropping owned command lists would leak allocations and
was deliberately not used.
