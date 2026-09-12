# Gun Mayhem Online

Browser-based multiplayer for the original **Gun Mayhem** Flash game. Each player runs the game locally through a pinned Ruffle build while a small Node.js server coordinates a deterministic Last Man Standing match for two to four players.

[Live demo](https://gunmayhem.nov4ou.top/)

## Features

- Two to four players on computers, phones, or tablets
- Original graphics, animation, audio, maps, weapons, and 35 FPS simulation
- Twelve Last Man Standing maps and configurable lives
- Authoritative input lockstep with deterministic random state
- One-frame input scheduling for two- and three-player matches; three frames for four players
- Live WebSocket RTT and measured input-to-presentation latency
- State verification, reconnect handling, room ownership, and private invitation links
- Built-in performance spike recorder for field diagnostics
- Multi-touch controls and a landscape fullscreen layout for mobile devices
- Modern and scalar WebAssembly runtime paths for current and older Safari versions

The VPS does not render the game or transmit video. It orders compact input messages into authoritative frame rows. Every browser advances its own copy of the SWF with the same frame, input, and random state.

## Quick start

Requirements:

- Node.js 22 or newer
- npm

```bash
npm ci
npm start
```

Open `http://127.0.0.1:3003/`. `npm start` creates a clean runtime build in `rollback-research/build/` before starting the server. Set `HOST` and `PORT` to use a different interface or port.

## Controls

| Action | Keys |
| --- | --- |
| Move and jump | `W A S D` or arrow keys |
| Fire | `J` |
| Charge and throw grenade | Hold and release `K` |

Click the game before playing so the browser can focus the controls and enable audio.

On a phone or tablet, the same actions appear as on-screen controls when a match begins. Multiple controls can be held at once, including moving while firing or charging a grenade. Landscape orientation and fullscreen mode provide the clearest view. If a mobile browser does not support element fullscreen, the interface automatically uses an equivalent viewport-filling layout.

## How synchronization works

The production runtime uses server-finalized input lockstep. Clients send six-bit input masks for future simulation frames. The server accepts revisions while a frame remains pending, then broadcasts one immutable row containing every player's input. A missing input becomes neutral after a short grace period, so a backgrounded or stalled browser cannot pause the entire room.

Two- and three-player matches schedule input one frame ahead. Four-player matches use three frames to absorb the additional network and browser scheduling variance. A local key edge can revise its pending future input before finalization, reducing the delay that would otherwise be added by polling at the game's 35 Hz frame rate.

The SWF bridge supplies synchronized input and a deterministic random source. It also exposes lightweight state values used to detect divergence. The original game simulation remains inside the SWF; the networking layer does not reimplement physics, weapons, collision, rendering, or audio.

See [Architecture](docs/ARCHITECTURE.md) for protocol and runtime details.

## Development

```bash
npm run build
npm test
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run build` | Generate the deployable server, client, patched Ruffle runtime, and assets |
| `npm test` | Run server, lockstep, memory, audio, and WebGL tests |
| `npm run test:mobile` | Run the two-client mobile layout and multi-touch input smoke test |
| `npm run test:mobile:fallback` | Run the mobile test through Ruffle's scalar WebAssembly fallback |
| `npm run test:network` | Run a multi-browser synchronization test against a local server |
| `npm run build:swf` | Rebuild the network-enabled SWF with JPEXS FFDec 26.2.1 and a JDK |

The normal JavaScript build uses the checked-in network-enabled SWF. Rebuilding that SWF requires a legally obtained original `gunmayhem.swf`; set `FFDEC_JAR` to the JPEXS FFDec 26.2.1 JAR. The build verifies every non-script SWF tag byte for byte.

The browser tests require Playwright Chromium. Install it with `npx playwright install chromium`, start `npm run start:prepared` in one terminal, and run `npm run test:mobile`, `npm run test:mobile:fallback`, or `npm run test:network` in another. Set `GM_BROWSER_ENGINE=webkit` for the mobile smoke test when Playwright WebKit is installed. `GM_NETWORK_CLIENTS`, `GM_NETWORK_DELAYS`, and `GM_NETWORK_SECONDS` configure the network test's player count, per-client one-way delay, and duration.

See [Contributing](CONTRIBUTING.md) for the validation workflow and [Deployment](docs/DEPLOYMENT.md) for a systemd/Caddy setup.

## Repository layout

| Path | Contents |
| --- | --- |
| `public/` | Web UI templates and the canonical network-enabled SWF |
| `rollback-research/netcode/` | Production lockstep relay, browser timeline, and protocol tests |
| `rollback-research/state/` | Ruffle state hooks, deterministic clock, and SWF build extension |
| `rollback-research/effects/` | Audio and WebGL state handling developed for rollback experiments |
| `rollback-research/runtime.js` | Browser-side game scheduler, diagnostics, and spike recorder |
| `scripts/patches/` | ActionScript bridge and deterministic SWF patch tooling |
| `deploy/` | Generic deployment script and example service/proxy configuration |

`rollback-research/build/`, browser screenshots, test reports, decompiler output, and local copies of development tools are generated artifacts and are intentionally ignored.

## Diagnostics

During a match, run these in the outer page console:

```js
gunmayhemDiagnostics()
gunmayhemSpikeReport()
gunmayhemSpikeDownload()
```

The first call reports lockstep backlog, neutral fallback frames, input latency, audio timing, and renderer information. The spike recorder retains a short window around long frames and exposes a downloadable JSON report.

## Legal status

This repository does not grant rights to the Gun Mayhem name, SWF, artwork, audio, or other original game assets. Ruffle is distributed under its own MIT and Apache-2.0 licenses. See [NOTICE.md](NOTICE.md) before publishing or redistributing a fork.

No license has been selected for the original source code in this repository. Under GitHub's default copyright rules, others may view and fork the repository but do not receive broad permission to reuse the code until the repository owner adds a license.
