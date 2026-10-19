# Operate the resilience instrument

The frontend is a real React / TypeScript / Vite / Tailwind application. Its electrical schematic stays live while giving every newly observed request a readable inlet, HTTP (when admitted) and observed terminal journey. It never simulates HTTP results or changes real timers for animation. **T3 assembles the production three-container stack and records real proxy/browser self-checks; independent T4 review remains pending.**

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
| Recovery annotation | `recoveryAt` minus live observation time, or the actual opening timestamp plus policy. At zero it waits for `CIRCUIT_HALF_OPEN`; it cannot open a probe by itself. |

Hover, click or keyboard-focus a component to inspect its purpose. Inspection never sends a request. Select a recorder request ID to trace that request; clear the selection to restore all events. Histories show correlated attempt IDs, actual durations and outcomes. Gate, timers, recorder and backend metrics remain authoritative throughout visible journeys.

### Always live, with minimum visible stages

Choose **Visual speed** 1× (default), 0.5× or 0.25× to follow the request route more slowly. The native selector and its visual-only helper stay available in normal and Focus View. Changes preserve current journey progress, identity and queued stages; they do not restart the event stream. The choice lasts only for the mounted app, with no persistence. There are no pause, replay or manual catch-up controls. Backend observations update immediately; each request has a separate visual journey. Even zero-latency success starts at **REQUEST IN**, then HTTP, then its observed terminal. A rejection travels inlet → shunt without HTTP. Retries retain the logical ID and return directly to HTTP without another admission.

At 1×, minimum visible dwell is 320 ms at inlet, 360 ms per HTTP stage, 180 ms at WAIT, 220 ms for retry return and 600 ms at a terminal. At 0.5× these durations double; at 0.25× they quadruple. These are presentation durations, **not HTTP latency, backoff or timeout measurements**. No elapsed visual time invents an outcome. The timeout dial uses actual attempt timestamps; completed readouts show actual elapsed time.

All unplayed journeys survive completion, REST refresh and reconnect catch-up. Only after their terminal dwell may completed markers be trimmed to the latest four. Bootstrap shows existing snapshot stages without manufacturing engine events; reset/epoch replacement clears old-generation journeys. There is no separate rolling-ledger widget. Backend protection uses native Opossum calls and strict thresholds; see the [native statistics guide](engine.md#native-opossum-statistics).

### Projection, mobile and reduced motion

**Focus View** removes the dock, history and explanatory text, expands the plate and retains Send / Batch / Exit and Visual speed controls with the visual-only helper. Escape exits and returns keyboard focus to the toggle. On narrow mobile screens, the schematic scrolls horizontally to retain readable component labels; controls and records reflow below it without overflowing the page.

System/local fonts require no CDN. CSS and JavaScript both honor `prefers-reduced-motion`: no traveling pulse or timeout flash, but static stage markers, outcomes, readouts and controls remain functional. One polite status region announces connection/gate/control changes, never animation frames.

## Change the actual engine

The dock exposes all eight policy fields with the contract validator's exact integer bounds. Applying policy performs a real `PATCH /api/config`, closes the gate and resets its rolling baseline while preserving lifetime history. The derived retry waits are base backoff and twice base backoff.

Custom upstream configuration edits mode, latency, error status, failure probability and intermittent strategy via real `PATCH /api/external`. Alternating ignores the probability slider; seeded probability uses its actual value. **Recover Service** changes upstream behavior only—it does not force the breaker closed.

Management controls are held while admitted work is active. The server remains the final authority: a concurrent management conflict displays **409 / engine busy**. Pending mutations and errors are visible. Reset restores real engine and upstream defaults and accepts the new-generation authoritative snapshot.

## Integration and review boundaries

| File | Review responsibility |
| --- | --- |
| `apps/frontend/src/model.ts` | Pure authoritative ingestion, ordering, epoch retirement, deduplication, snapshot race fences and independent visible journeys. |
| `apps/frontend/src/useLab.ts` | Same-origin native EventSource, named `engine` / `snapshot`, event-driven REST refresh, connection/offline handling and one shared capped RAF clock. |
| `apps/frontend/src/topology.ts` / `Machine.tsx` | Painted conductors also sampled by `getPointAtLength`; one mechanical gate, retry WAIT/return, timeout/recovery readouts and inspectable SVG. |
| `apps/frontend/src/App.tsx` / `Dock.tsx` / `demo.ts` | Real REST controls, full configuration editors and deterministic sequential demo. |
| `apps/frontend/src/Timeline.tsx` | Bounded live event inspection and expandable logical histories. |
| `apps/frontend/src/styles.css` / `vite.config.ts` | Real Tailwind v4 Vite integration, graphite instrument styling, responsiveness and accessibility. |

Vite proxies `/api` to **localhost:3001** by default. `LAB_API_PROXY` can select another local development backend; the native smoke check uses isolated ports 3100/3101/3102. The production [nginx configuration](../apps/frontend/nginx.conf) supplies same-origin `/api` with unbuffered, uncached, uncompressed SSE and HTTP/1.1 upstream keepalive, rather than exposing a browser connection directly to an internal service. The ESM `@resilience/contracts` workspace must be built before Vite imports it.

Native EventSource retains Last-Event-ID across its own reconnections. The frontend never reconstructs it manually or launches endless polling. It pulls snapshots at bootstrap, after mutations, on event gaps/completions/transitions and once on browser reconnect. Older sequence, older same-cursor timestamp, retired generation and stale fetch-ticket responses cannot replace newer state. Snapshot metrics/config do not erase unpainted journeys. An incomplete event tail announces authoritative restoration and retains known journeys; missing stages are recovered only from observed snapshot histories.

Bounds: 1000 authoritative/pending events, 200 completed histories and up to 100 active histories. The recorder presents the latest 100 events and 50 histories. Unplayed journeys retain their own histories independently of those caps; sustained ingress while hidden can accumulate visual work. Moving SVG refs/readouts use one clock, with React commits at observed-event or visual-stage boundaries, not every frame. Journey time freezes offscreen or in hidden documents; capped delta and at most one stage transition per frame prevent resume skips.

## Verify

```sh
npm run test:frontend
npm run build
npm test
npm audit --json
npm audit --omit=dev --json
```

Frontend model/topology tests cover ordering, gaps, duplicates, reset/retired epochs, stale snapshots, same-timestamp zero-latency success, ten-request journeys, refresh/catch-up retention, retry identity, rejection without HTTP and authoritative timeout/recovery clamping. Deterministic visual-speed tests cover default/unsupported-rate fallback, half/quarter-speed duration, continuous rate changes, unchanged authoritative clocks/outcomes, zero-delta freezing and no invented completion. Demo tests cover exact sequential actions, stop-after-admission and management conflict handling.

An optional native Chromium check uses an **already installed** Playwright module, launches only its own processes on isolated ports, refuses occupied ports and closes all launched processes/browser contexts:

```sh
# Build first. If @playwright/cli is already installed globally:
node apps/frontend/verify/browser-smoke.mjs "$(npm root -g)/@playwright/cli/node_modules/playwright"
# Otherwise pass the absolute path of an existing Playwright module; do not download one implicitly.
```

To check the **existing production Docker stack** instead, append `--docker` to the same command. This mode uses http://localhost:3000, resets lab data, checks browser offline/online and generation replacement **without restarting containers**. Node `npm run verify:compose` separately checks Last-Event-ID replay through nginx. Production mode captures desktop, 1920×1080-viewport focus, reduced-motion and 390 px mobile screenshots as `docker-*.png`, then restores defaults and leaves containers running.

Artifacts stay in ignored `apps/frontend/.verification/`. The check uses no mocked outcomes. Visual-speed assertions check native options/default, quarter-speed inlet timing from collected coordinates, unchanged SSE lifecycle and retained history, plus the selector/helper and quarter-speed journeys in Focus. These checks pass in the isolated native T2 run below. It also verifies real success, timeout/upstream cancellation, identified WAIT and feedback-path coordinates, zero-latency single and ten-request coordinate journeys, four completed failures/OPEN, inlet/shunt rejection without HTTP, always-live gate state, exclusive concurrent recovery probe, full Auto Demo, real policy PATCH, no-request hover, browser offline controls, native Last-Event-ID reconnect after an owned backend restart, generation replacement, focus/Escape, keyboard inspection, reduced motion and 390 px page containment.

### Visual-speed T2 native verification

`npm run test:frontend` passes **33 tests**; `npm run build -w @resilience/frontend -- --emptyOutDir false` passes without deleting existing output. The full native Chromium smoke passes using the existing Playwright module and owned services on ports **3100–3102**, confirmed free before and after. It covers quarter-speed journeys in normal/Focus views, unchanged HTTP/SSE behavior, Focus at 1366×768 and 1920×1080, Escape/focus restoration, reduced motion, keyboard inspection, 390 px mobile containment and **zero unexpected console/page errors**. Screenshots are in `apps/frontend/.verification/`.

Observed browser RED: the two-line visual-speed readout raised the Focus toolbar from **43.5 px to 49 px**. After the reconnect notice, the absolutely positioned `.sr-only` live-status region ended at **y=769.5**, making the page **770 px** tall at 1366×768. Temporarily restoring the pre-speed toolbar layout made the same page fit, confirming a candidate-caused regression. The bounded fix keeps the helper inline in Focus, with wrapping available; it does not hide overflow or change the circuit scale. GREEN: page dimensions are **1366×768 / 1920×1080**, with no clipped labels, components/label collisions or clipped toolbar content. Minimum major-label sizes remain **16.94 / 26.94 px**, annotations **13.95 / 22.19 px**, and controls **13 px**; all existing thresholds are unchanged.

One corrected-layout run reached the final console check but failed on a 500; the Vite log recorded `/api/snapshot` ECONNRESET during the owned backend restart. The unchanged assertion passed on the subsequent full run. No production/Docker access, existing lab-data reset, installation, deployment or physical-projector assessment was performed. This native verification is not production or review approval.

### Always-live writer validation

Observed model RED: same-timestamp success, ten-request retention and authoritative/visual separation failed against the previous playback model. Additional RED cases caught duplicate rejection stages and bootstrap terminal placement. GREEN: **19 frontend tests**, all four workspace builds and **79 Vitest + 3 Node tests** pass.

The owned-local-process Chromium smoke passes per-ID coordinates collected before sends: normal and zero-latency success, all ten batch IDs, rejection, retry identity, Focus and reduced motion. It also passes real timeout/cancellation, probe exclusivity, reconnect/reset, keyboard and mobile checks, with zero unexpected browser errors. This run did **not** touch or verify Docker. These are writer checks, not independent review approval.

### Historical evidence and remaining checks

- Initial reducer RED: 10 intended failures against inert scaffold exports. GREEN: all initial 11 tests passed after implementation.
- Additional observed RED/GREEN: policy playback boundary and stale same-cursor snapshot rollback regressions. Expanded browser RED/GREEN caught browser offline leaving SSE apparently open; explicit offline/one-shot online verification fixes the misleading connected controls.
- All workspace builds pass. Focused frontend validation passes **16 tests**; the full technical/frontend suite passes **70 tests**, including the original 54 core tests. The final native browser script exits successfully and leaves no listeners on its isolated ports.
- Vitest upgraded from 3.2.7 to exact **5.0.3**, removing the confirmed tinypool/mocker advisories without overrides. Vite is pinned at patched **7.3.7**.
- T3 removed the remaining low Windows dev-only esbuild advisory **GHSA-g7r4-m6w7-qqqr** with a targeted compatible lock refresh to **0.28.2** (already permitted by Vite 7.3.7). Full and production-only audits now have zero findings. No force fix, overrides or major framework upgrade was used; npm audit is not an image/OS scan or security approval.
- T3 production self-checks pass Docker build/health, real HTTP/SSE through nginx and native Chromium controls/routes/reconnect/focus/reduced-motion/mobile. See [exact evidence and screenshots](verification.md).
- **Pending T4:** independent full-flow verification/review, broader projector/device assessment and any bounded corrective work. T3 self-checks are not independent review approval; native-only historical evidence remains distinct from production Docker evidence.
