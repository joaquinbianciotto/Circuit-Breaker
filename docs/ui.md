# Operate the resilience instrument

The frontend is a real React / TypeScript / Vite / Tailwind application. Its electrical schematic replays observed engine events; it never simulates HTTP results or changes real timers to make an animation look convincing. **T3 assembles the production three-container stack and records real proxy/browser self-checks; independent T4 review remains pending.**

## Quick path

With Docker Compose installed (no host Node/npm required):

```sh
docker compose up --build
```

See the [README](../README.md#development-optional-host-toolchain) for optional native development commands.

Open **http://localhost:3000**, select **Normal Response**, then **Send Request**. This sets a real 260 ms upstream latency so the attempt is visible. Requests and attempts retain their actual IDs in the schematic, event recorder, expandable histories and upstream logs.

For a guided sequence, start **Auto Demo** from an idle engine. It performs real sequential management calls and requests: normal response, slow timeout/retries, reset baseline, four completed failures, OPEN rejection, wait for the actual HALF_OPEN event, recover upstream, send the exclusive probe, and exercise alternating failure/retry. **Stop** prevents subsequent actions; already admitted work is not cancelled.

## Read the machine

| Component | Meaning |
| --- | --- |
| Inlet and one contact gate | CLOSED contacts touch; OPEN contacts separate. This is one breaker, not three sequential services. |
| Amber HALF_OPEN connection | A controlled single probe, with no retries. Other arrivals reject. |
| HTTP winding and timeout dial | Real backend `fetch('/work')` attempts. Active time comes from actual attempt start, policy limit and operation deadline. Completed readouts show actual elapsed time. |
| WAIT capacitor and feedback conductor | A failed attempt returns directly to HTTP inside the **same** logical operation. The signal parks until observed `RETRY_STARTED`. |
| Green / red terminals | Observed logical success or exhausted/non-retryable failure. |
| Inlet rejection shunt | Rejection without an upstream HTTP attempt. |
| Failure meter | A **live backend snapshot observation** of completed logical failures / completed operations. Never per-attempt error percentage. The source timestamp is below the figure. |
| Recovery annotation | `recoveryAt` minus virtual time, or the actual opening timestamp plus policy. At zero it waits for `CIRCUIT_HALF_OPEN`; it cannot open a probe by itself. |

Hover, click or keyboard-focus a component to inspect its purpose. Inspection never sends a request. Select a recorder request ID to trace that request; clear the selection to restore all events. Histories show correlated attempt IDs, actual durations and outcomes. The recorder is live even when the illustration is historical.

### Playback is not engine time

- **1× / 0.5× / 0.25×** affects only the visual clock. An 800 ms backend timeout remains 800 ms at every playback speed.
- **Pause** holds the diagram's contacts, stages and timers. The labeled **LIVE GATE** and backend failure meter continue reflecting authoritative observations.
- **PLAYBACK / HISTORICAL** and lag distinguish delayed illustration state from live state. A live CLOSED gate never replaces historical OPEN contacts just to look current.
- **Live catch-up** explicitly returns the figure to the newest authoritative snapshot and drops its queued visual delay.
- Travel is an educational replay of an **already observed stage**. It is not a claim that a particular packet occupied a particular physical point at that instant. Fast outcomes remain readable at their terminal and in the stage rail.
- Policy observations join the visual clock at their snapshot timestamp rather than rewriting earlier playback. Active policy changes are prohibited by the backend. The contracts do not expose historical per-attempt policy revisions; completed attempts therefore use their actual elapsed readout, not an invented old timeout budget.

### Projection, mobile and reduced motion

**Focus View** removes the dock, history and explanatory text, expands the plate and retains Send / Batch / Playback / Exit controls. Escape exits and returns keyboard focus to the toggle. On narrow mobile screens, the schematic scrolls horizontally to retain readable component labels; controls and records reflow below it without overflowing the page.

System/local fonts require no CDN. CSS and JavaScript both honor `prefers-reduced-motion`: no traveling pulse or timeout flash, but static stage markers, outcomes, readouts and controls remain functional. One polite status region announces connection/gate/control changes, never animation frames.

## Change the actual engine

The dock exposes all eight policy fields with the contract validator's exact integer bounds. Applying policy performs a real `PATCH /api/config`, closes the gate and resets its rolling baseline while preserving lifetime history. The derived retry waits are base backoff and twice base backoff.

Custom upstream configuration edits mode, latency, error status, failure probability and intermittent strategy via real `PATCH /api/external`. Alternating ignores the probability slider; seeded probability uses its actual value. **Recover Service** changes upstream behavior only—it does not force the breaker closed.

Management controls are held while admitted work is active. The server remains the final authority: a concurrent management conflict displays **409 / engine busy**. Pending mutations and errors are visible. Reset restores real engine and upstream defaults and accepts the new-generation authoritative snapshot.

## Integration and review boundaries

| File | Review responsibility |
| --- | --- |
| `apps/frontend/src/model.ts` | Pure event ingestion, ordering, epoch retirement, deduplication, bounded history, snapshot race fences and virtual playback. |
| `apps/frontend/src/useLab.ts` | Same-origin native EventSource, named `engine` / `snapshot`, event-driven REST refresh, connection/offline handling and one shared capped RAF clock. |
| `apps/frontend/src/topology.ts` / `Machine.tsx` | Painted conductors also sampled by `getPointAtLength`; one mechanical gate, retry WAIT/return, timeout/recovery readouts and inspectable SVG. |
| `apps/frontend/src/App.tsx` / `Dock.tsx` / `demo.ts` | Real REST controls, full configuration editors and deterministic sequential demo. |
| `apps/frontend/src/Timeline.tsx` | Bounded live event inspection and expandable logical histories. |
| `apps/frontend/src/styles.css` / `vite.config.ts` | Real Tailwind v4 Vite integration, graphite instrument styling, responsiveness and accessibility. |

Vite proxies `/api` to **localhost:3001** by default. `LAB_API_PROXY` can select another local development backend; the native smoke check uses isolated ports 3100/3101/3102. The production [nginx configuration](../apps/frontend/nginx.conf) supplies same-origin `/api` with unbuffered, uncached, uncompressed SSE and HTTP/1.1 upstream keepalive, rather than exposing a browser connection directly to an internal service. The ESM `@resilience/contracts` workspace must be built before Vite imports it.

Native EventSource retains Last-Event-ID across its own reconnections. The frontend never reconstructs it manually or launches endless polling. It pulls snapshots at bootstrap, after mutations, on event gaps/completions/transitions and once on browser reconnect. Older sequence, older same-cursor timestamp, retired generation and stale fetch-ticket responses cannot replace newer state. Fresh snapshot metrics/config do not skip a slow visual queue. An incomplete tail or buffer overflow visibly announces resynchronization rather than silently inventing missing transitions.

Bounds: 1000 events / playback entries / pending events, 200 completed histories and up to 100 active histories. The recorder presents the latest 100 events and 50 histories. Bootstrap and generation replacement hydrate snapshots without fabricating `REQUEST_STARTED` events. Moving SVG refs and readouts update on the single clock; React rerenders on observed event/control boundaries, not every RAF frame. Moving DOM work pauses offscreen and in hidden documents; capped delta avoids giant resume jumps.

## Verify

```sh
npm run test:frontend
npm run build
npm test
npm audit --json
npm audit --omit=dev --json
```

Frontend model tests cover ordering, gaps, duplicate events, reset/retired epochs, stale snapshots, delayed snapshot refresh, logical/attempt identity, actual timestamp timeout clamping, real retry waits, HALF_OPEN exclusivity, OPEN rejection, policy playback boundaries and pause/quarter-speed isolation. Demo tests cover exact sequential actions, stop-after-admission and management conflict handling.

An optional native Chromium check uses an **already installed** Playwright module, launches only its own processes on isolated ports, refuses occupied ports and closes all launched processes/browser contexts:

```sh
# Build first. If @playwright/cli is already installed globally:
node apps/frontend/verify/browser-smoke.mjs "$(npm root -g)/@playwright/cli/node_modules/playwright"
# Otherwise pass the absolute path of an existing Playwright module; do not download one implicitly.
```

To check the **existing production Docker stack** instead, append `--docker` to the same command. This mode uses http://localhost:3000, resets lab data, checks browser offline/online and generation replacement **without restarting containers**. Node `npm run verify:compose` separately checks Last-Event-ID replay through nginx. Production mode captures desktop, 1920×1080-viewport focus, reduced-motion and 390 px mobile screenshots as `docker-*.png`, then restores defaults and leaves containers running.

Artifacts stay in ignored `apps/frontend/.verification/`. The check uses no mocked outcomes. It verifies real success, timeout/upstream cancellation, identified WAIT and feedback-path coordinates, four completed failures/OPEN, rejection without HTTP, paused-vs-live gate state, exclusive concurrent recovery probe, full Auto Demo, real policy PATCH, no-request hover, browser offline controls, native Last-Event-ID reconnect after an owned backend restart, generation replacement, focus/Escape, keyboard inspection, reduced motion and 390 px page containment.

### Evidence and remaining checks

- Initial reducer RED: 10 intended failures against inert scaffold exports. GREEN: all initial 11 tests passed after implementation.
- Additional observed RED/GREEN: policy playback boundary and stale same-cursor snapshot rollback regressions. Expanded browser RED/GREEN caught browser offline leaving SSE apparently open; explicit offline/one-shot online verification fixes the misleading connected controls.
- All workspace builds pass. Focused frontend validation passes **16 tests**; the full technical/frontend suite passes **70 tests**, including the original 54 core tests. The final native browser script exits successfully and leaves no listeners on its isolated ports.
- Vitest upgraded from 3.2.7 to exact **5.0.3**, removing the confirmed tinypool/mocker advisories without overrides. Vite is pinned at patched **7.3.7**.
- T3 removed the remaining low Windows dev-only esbuild advisory **GHSA-g7r4-m6w7-qqqr** with a targeted compatible lock refresh to **0.28.2** (already permitted by Vite 7.3.7). Full and production-only audits now have zero findings. No force fix, overrides or major framework upgrade was used; npm audit is not an image/OS scan or security approval.
- T3 production self-checks pass Docker build/health, real HTTP/SSE through nginx and native Chromium controls/routes/reconnect/focus/reduced-motion/mobile. See [exact evidence and screenshots](verification.md).
- **Pending T4:** independent full-flow verification/review, broader projector/device assessment and any bounded corrective work. T3 self-checks are not independent review approval; native-only historical evidence remains distinct from production Docker evidence.
