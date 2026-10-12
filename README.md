# Resilience Lab

Run a real HTTP Circuit Breaker / Timeout / Retry experiment, illustrated as an electrical instrument.

```sh
docker compose up --build
```

Open **http://localhost:3000**. Only **Docker with Docker Compose** is required; builds install the locked dependencies inside containers. No host Node/npm, environment file, database or account is needed. Wait for the three services to become healthy. For detached startup: `docker compose up --build -d --wait`.

Choose **Normal Response → Send Request**, or **Start Auto Demo** for the guided real sequence. [Four projector-ready walkthroughs](docs/scenarios.md) explain exactly what to click and count.

## What runs

| Service | Production runtime | Access |
| --- | --- | --- |
| `frontend` | React/TypeScript/Vite/Tailwind build served by nginx | Only published port: `127.0.0.1:3000:80` |
| `backend` | Compiled NestJS + Opossum, Node 22.22.2 | Docker network only, port 3001 |
| `external-api` | Compiled Fastify, Node 22.22.2 | Docker network only, port 3002 |

The browser uses same-origin `/api`, including unbuffered SSE through nginx. Backend `EXTERNAL_API_URL` is `http://external-api:3002`. Every attempt sends real HTTP to that upstream, with request/attempt IDs and actual receipt/cancellation metrics. **Three network services are not three illustrated breakers:** one breaker wraps one logical operation containing all of its bounded attempts.

## Defaults and meaning

| Protection policy | Default |
| --- | --- |
| Attempt timeout, including response body | 800 ms |
| Additional retries | 2 (up to 3 attempts) |
| Retry waits | 200 ms, then 400 ms |
| Total operation deadline | 3000 ms, including waits/overhead |
| Opening threshold | Inclusive ≥50% completed logical failures |
| Minimum completed volume | 4 |
| Rolling window | 20 s |
| OPEN recovery wait | 7 s |

Upstream starts **normal**, latency **0 ms**, error status **503**, failure rate **0.5**, intermittent strategy **alternating**. The visible presets set latency to normal **260 ms**, slow **1500 ms**, fail **220 ms** and intermittent **240 ms**. Probability is used only by the seeded probability strategy; alternating fails its first call after reset and succeeds its second.

- Retry 5xx, network failure and timeout; ordinary 4xx never retry.
- OPEN rejects without HTTP. HALF_OPEN admits exactly one single-attempt probe; concurrent arrivals reject. Recover Service changes upstream only, not breaker state.
- Always-live visualization gives every new request a minimum visible REQUEST IN → HTTP → observed terminal journey, including zero-latency and ten-request batches. Rejections bypass HTTP; retries never repeat admission. No pause/speed/jump controls or visual rolling-ledger widget remain; backend timers, metrics and protection stay unchanged.
- Reset Simulation restores engine/upstream defaults, counters and replay generation. Policy Apply closes the gate and clears the rolling baseline but retains lifetime history. Management conflicts return 409 while work is active.

## Stop and safety

Press Ctrl-C for foreground Compose. To stop/remove this project's containers and network:

```sh
docker compose down
```

No volumes are used; state is ephemeral and is lost with process/container replacement. This is an **unauthenticated, in-memory local teaching lab**, not a production gateway. Keep the loopback binding; do not expose it on a public/shared network. An upstream port already used on the host does not conflict: backend/upstream have no published host ports. Do not stop unrelated containers to run this lab.

## Development (optional host toolchain)

Use Node **22.20+ within 22** (verified 22.22.2) and npm. Stop the Compose frontend before using development port 3000; ensure 3001/3002 are free. Development processes bind all interfaces, unlike the Compose loopback publication.

```sh
npm ci
npm run build
npm test
# Three separate terminals, after building:
npm run dev:external
npm run dev:backend
npm run dev:frontend
```

The Node dev commands run compiled service entrypoints; rebuild after service changes. Vite supplies frontend development reload and proxies `/api` to localhost:3001. Contracts build first because the CJS services load that ESM workspace using Node 22 require(ESM).

## Verification

With the Compose stack running and no concurrent scenario writer:

```sh
npm run verify:compose
# Equivalent built-in-only command (no npm install required):
node scripts/verify-compose.mjs
node --test scripts/compose-output.test.mjs
```

The acceptance script checks the three healthy containers, loopback-only exposure, real scenarios/probes, SSE replay/snapshots/heartbeats and timestamp budgets through port 3000. It resets **lab data**, uses small fast policies, restores defaults at completion and never restarts containers.

An optional production browser check requires an **existing** Playwright module and installed Chromium; it downloads/installs nothing:

```sh
node apps/frontend/verify/browser-smoke.mjs /absolute/path/to/existing/playwright --docker
```

It checks actual controls/outcomes, offline/online reconnect, Focus effective-font floors and clipping/collisions at 1366×768 and 1920×1080, keyboard/Escape, reduced motion and mobile containment. It writes ignored screenshots to `apps/frontend/.verification/docker-*.png`, including `docker-projector-1366.png` and `docker-projector-1920.png`. Omit `--docker` only for the separate owned-local-process smoke test on ports 3100/3101/3102.

Audit read-only with `npm audit --json` and `npm audit --omit=dev --json`. Current full and production reports have **zero findings** after a targeted compatible esbuild 0.28.2 lock refresh; Vitest is patched 5.0.3. Audit is advisory-registry evidence, **not** an image/OS scan, security review or proof of safety. No force fixes or dependency overrides were used.

## Review map

- [Architecture and source decisions](docs/architecture.md)
- [Scenario walkthroughs](docs/scenarios.md)
- [Engine API, statistics and stream contract](docs/engine.md)
- [UI operation and real versus visual time](docs/ui.md)
- [Observed verification, screenshots and coverage limits](docs/verification.md)

Independent T4 verification passed all four builds, 70 Vitest + 3 Node tests, both audits (zero findings), 10 Docker acceptance groups and Chromium checks (zero unexpected errors). The bounded Focus correction also passes writer-owned checks: at 1366×768, measured minima are 16.94 px for major labels, 13.95 px for core annotations and 13 px for controls, with zero checked clipping/collisions.

An earlier frontend rebuild recreated all three lab services; the approved `--no-deps` frontend-only deployment preserved backend/upstream, and fresh scenario acceptance retained all three final IDs. See the verification record for run boundaries and the remaining independent correction spotcheck.

No physical projector, image/OS scan or broad browser matrix is claimed. Native code-review was not completed and grants no approval; fresh consent is required separately. No push or PR was performed.
