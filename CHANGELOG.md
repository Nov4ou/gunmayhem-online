# Changelog

## Unreleased

- Reuse memory checkpoint page tables and restore-index buffers in the experimental rollback implementation.
- Replace per-checkpoint WebGL resource maps and repeated retained-resource scans with pooled flat tables, checkpoint reference counts, and reusable marks.
- Make the generated runtime build reproducible and remove deployment-specific values from repository examples.

## 0.23.1

- Raise the complete original customization display hierarchy above its static overlays so the lobby character preview has no vertical obstruction.

## 0.23.0

- Added a live lobby preview built from the original character artwork, animation, outfits, and headwear.
- Added Chinese display-name rendering to the in-game name tags, HUD player cards, and elimination feed.
- Release the lobby preview runtime when a match begins so it does not consume resources during play.
- Added browser tests for character preview accuracy, synchronized appearance profiles, and multilingual names.

## 0.18.1

- Reduced two-player input scheduling from two frames to one. Two- and three-player matches now use one frame; four-player matches use three.

## 0.18.0

- Allowed immediate revision of a player's pending future input when a human key edge occurs.
- Added server-side accounting for valid pending input updates.
- Reduced three-player scheduling to one frame while retaining authoritative lockstep.

## 0.17.1

- Corrected the input-latency clock to use the native monotonic wall clock outside the deterministic simulation clock.

## 0.17.0

- Added median and 95th-percentile software keydown-to-presentation latency to the match header and diagnostics.

## 0.16.0

- Replaced the expensive recursive display-tree state check with the lightweight network frame, tick, and timeline check.

## 0.15.0

- Added the in-game performance spike recorder and downloadable diagnostic report.

## 0.13.0

- Replaced prediction and runtime rollback with server-finalized delayed-input lockstep.
- Added deterministic browser-side bot profiles for repeatable load tests.

## 0.11.0

- Added short input scheduling and correction coalescing to reduce three-player rollback load in the earlier prediction-based runtime.
