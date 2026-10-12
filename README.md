# Resilience Lab

Operate a real HTTP Circuit Breaker / Timeout / Retry experiment through an accessible electrical instrument. The final Focus layout and event playback illustrate observed HTTP/SSE behavior, never synthetic outcomes.

## Quick path

Use Node 22.20+ within Node 22 (verified 22.22.2) and npm. Ensure native ports 3000/3001/3002 are free.

```sh
npm ci
npm run build
npm test
# Three separate terminals, after building:
npm run dev:external
npm run dev:backend
npm run dev:frontend
```

Open http://localhost:3000, choose Normal Response and Send Request, or Start Auto Demo. Stop your processes with Ctrl-C; rebuild service changes. Native processes bind all interfaces: use only a trusted local machine/network. This unauthenticated, memory-only teaching lab is not a production gateway. No containers or deployment acceptance helpers are included in this unit.

## Read and verify

The LIVE GATE and recorder remain authoritative while playback is slowed or paused. Focus/Escape, keyboard inspection, reduced motion and responsive controls retain real request behavior. Policy changes clear the rolling baseline; reset restores defaults and a fresh replay generation.

- [Engine API and statistics](docs/engine.md)
- [UI controls, playback and local browser check](docs/ui.md)

Builds cover all four workspaces. The existing suite contains 76 Vitest tests (60 core + 16 frontend). Optional native Chromium smoke uses an already installed Playwright module, exclusively owns ports 3100/3101/3102, and cleans up its processes/browser. It downloads nothing.

```sh
node apps/frontend/verify/browser-smoke.mjs /absolute/path/to/existing/playwright
npm audit --json
npm audit --omit=dev --json
```

Vitest 5.0.3 and compatible esbuild 0.28.2 remain locked. Audit is registry evidence, not security approval. No push or PR was performed; native review approval is not claimed.
