# Original movie netplay bridge

Build from `gunmayhem.swf` with `npm run build:swf`. This requires a JDK and the [official JPEXS FFDec 26.2.1 distribution](https://github.com/jindrapetrik/jpexs-decompiler/releases/tag/version26.2.1). Set `FFDEC_JAR` to its `ffdec.jar`; a local ignored copy at `research/ffdec/ffdec.jar` is also detected. The canonical output is `public/gunmayhem-net.swf`.

The original movie is Flash 10 / AVM1 (ActionScript 2), with 35 movie frames per second. All game simulation, characters, collision geometry, weapons, projectiles, visual effects, audio, animation timelines, camera movement, countdowns, deaths and result screen remain the original SWF implementation.

## Changes to scripts

- Replace the 142 native `RandomNumber` opcodes in 53 original scripts with a call to the shared seeded random source. FFDec relocates jumps and updates function lengths; the original scripts are not decompiled and recompiled.
- Append `net-bootstrap.as` after the original frame 2 setup and stop at that frame to wait for the room. Override `Key.isDown` to read synchronized input and override `Math.random` to read the same seeded source. Ruffle marks both methods read-only, so their read-only flag is cleared before assigning them.
- Append `net-frame10.as` after the original game initialization. Its wrapper counts the original root `onEnterFrame` calls and immediately calls the original handler with the original receiver. It does not change the simulation update order.
- The bridge starts Last Man Standing (original mode 1) or Gun Game (original mode 4) through the original root frame 10. It first performs the original frame 3 music object setup, supplies the original default player customization settings, and supplies an identical in-memory copy of the original first-run crate weapon unlock table. Browser-local Flash saves therefore cannot produce different game rules among participants.
- Human spawn and respawn initialization sets the game's existing shield timer to 140 frames. This uses the original shield behavior and visuals while preventing immediate spawn kills in network matches.
- The original 35 FPS simulation is advanced by the browser clock wrapper, outside this SWF patch. Network packets supply six input bits per player: up, left, down, right, fire, grenade (bits 0–5). A player's remote input has exactly the original pressed/held/released behavior, including grenade charging/release. Native pause and debug keys are outside this six-action network interface.

The deterministic PRNG is Park–Miller, state `seed = seed * 16807 mod 2147483647`. `Math.random()` returns `(seed - 1) / 2147483646`; `random(n)` returns its integer-scaled floor. Initial seeds range from 1 to 2147483646. Random spawn positions, bullet spread, crates, effects and random sound variants use this same sequence.

## JavaScript interface

`netReady()` is called in the containing page when root frame 2 is initialized and stopped. `netStart(config)` returns true once per movie instance; repeat matches must load a fresh instance. The configuration has `seed`, `mode` (`last-man-standing` or `gun-game`), `map` (1–12), `lives` (1–99), `players` (2–4), and optional `profiles` with `name`, `color`, `shirt`, `hat`, `gun`, `perk` for each player. The numbers in `native-options.json` are the actual selectable original player options, rather than all resource frames (which also contain NPC and locked appearances).

`netInput(frame, masks)` installs all players' inputs before advancing a movie frame. `netTickState()` returns the installed frame number, actual root game update count, and root timeline frame; it is suitable for checking every update. `netState()` additionally returns the PRNG state, native timer, game mode/result flags, player scalar state and a deterministic checksum over the root and its child movie clips, including their animation frames and scalar properties. This checksum is diagnostic, not a save-state or rollback snapshot. It includes presentation state and is intentionally not stripped of timer or loading fields. `netDebugInput()` reports installed masks, native `Key.isDown` results and whether `Math.random` is bound to the seeded source.

The full checksum is relatively expensive and should be sampled periodically (for example, once per second), not on every movie update.

## Original defaults and end-of-match behavior

Original first-run options are 10 lives; player colors `[2, 5, 8, 10]`; shirt, hat and pistol 1; perk 7 (`+33% More Ammo`); sound and music on. Gun Game uses the original fixed 16-level weapon progression, unlimited respawns, and disables grenades, crates, and power-ups; the lives configuration is ignored by that mode. The original `def_quality = 2` is **MEDIUM** in the game, as selected by its untouched root frame 10 script. This is not a quality reduction introduced by netplay.

Selectable ranges are colors 1–10, shirts 1–15, hats 1–24, starting pistols 1–6, perks 1–9 and maps 1–12. Perks 3, 6 and 9 are locked in a fresh original campaign save; the bridge can represent them but the default is the original unlocked perk 7. Shirt/hat resources contain additional frames for NPCs; those are not exposed by the original selector. Map 13 is the original tutorial/test map; it is not included in the 12 normal custom-game maps.

After a winner is detected, the untouched game counts 100 update frames, attaches its fade animation, and at fade frame 10 cleans up the players, map and HUD, deletes the root `onEnterFrame`, and goes to root frame 6 (the original results screen). Frame 6 sets `gamewin` false. Thus the native update counter correctly stops on entering the results screen; the root timeline value is the reliable completion signal. Reload the movie for a new room match so no old objects, inputs, audio state or seed remain.

## Verification

Every build generates `resource-proof.json`. It rejects any change in the stage dimensions, movie frame rate/count, or non-script resources. The current verification compares **13,757 non-script/timeline tags containing 6,094,673 bytes** byte-for-byte against the supplied original SWF. Only script tags differ.

`research/verify-input.cjs` loads the built movie in Ruffle and calls the bridge directly, independent of keyboard focus. It asserts right/left movement, jump consumption and upward velocity, shooting ammunition consumption, grenade charge/release and ammunition consumption, and the seeded Math binding. Its recorded state is `research/verify-input-results.json`.

`research/map-thumbnails/DefineSprite_1230/1.png` through `12.png` are the original SWF's map-select previews rendered by FFDec, with map order and native option names in `native-options.json`.
