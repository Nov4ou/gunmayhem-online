# Contributing

## Setup

Use Node.js 22 or newer:

```bash
npm ci
npm run build
npm test
```

Edit canonical source files rather than files under `rollback-research/build/`. The build directory is recreated and ignored by Git.

## Required validation

Run `npm test` for every protocol or runtime change. Changes to browser scheduling should also be tested with at least two and three independent browser clients. Confirm that all clients reach identical sampled states and review neutral fallback, buffered-frame, long-frame, input-latency, and audio-lateness metrics.

Changes to the SWF bridge require `npm run build:swf`. That command needs a JDK, JPEXS FFDec 26.2.1, and the original `gunmayhem.swf`. It fails if stage metadata or any non-script resource differs from the original.

Do not commit `rollback-research/build/`, test reports, screenshots, browser profiles, decompiler output, or local tool installations.

## Pull requests

Describe the player-visible behavior, the player counts tested, simulated or measured network conditions, and any effect on input delay or neutral fallback. Include diagnostic JSON only when it helps explain a performance or synchronization result; remove room codes, IP addresses, and unrelated browser data.
