# T4 verification — observed results and limits

**Builds, 73 tests, both npm audits, 10 Docker acceptance groups and production Chromium checks pass.** Independent T4 verification and a separate post-correction independent spotcheck both passed. The latter reran `npm test`, `npm run verify:compose`, the cache-disabled production browser smoke, before/after container status and the final defaults snapshot. All three container IDs stayed unchanged during that final run; the corrected Focus bounds, fonts, keyboard access, reduced motion and mobile containment passed with zero unexpected browser errors. These functional results are not native code-review approval.

## Reproduce against the running lab

Use the existing host dependencies and Playwright/Chromium installation; no installation was performed during this correction. Run scenario writers sequentially because they reset ephemeral lab data.

```sh
npm run build
npm test
npm audit --json
npm audit --omit=dev --json
docker compose ps --format json
npm run verify:compose
node apps/frontend/verify/browser-smoke.mjs /home/joaquinbianciotto/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright --docker
docker compose ps --format json
```

On another machine, pass its existing Playwright module path. The API harness uses Node built-ins only (`node scripts/verify-compose.mjs`); Docker-only startup does not require host Node/npm/Playwright. Initial startup is documented in the [README](../README.md).

For an explicitly authorized **frontend-only deployment** into an already healthy stack, the correction used:

```sh
docker compose up --build -d --wait --no-deps frontend
```

Do not substitute the same command without `--no-deps`: selecting `frontend` alone also processes its dependencies.

## Independent T4 evidence before correction

The independent verifier reported the following observed results, retained separately from the writer's later reruns:

| Check | Independent result |
| --- | --- |
| `npm run build` | All four workspace builds passed. |
| `npm test` | 70/70 Vitest tests in 7 files plus 3/3 Node helper tests passed. |
| Full / production npm audits | Zero findings in each report. |
| Compose topology | Exactly three healthy services; only `127.0.0.1:3000` exposed. |
| Container continuity during that verification | Frontend `2ec51919b809`, backend `e22bb4d26ba8`, upstream `207ea7a95f40` unchanged; no restart during that run. |
| `npm run verify:compose` | All 10 acceptance groups passed. |
| Production Chromium | Zero unexpected console/page errors; four concurrent requests had distinct request and attempt IDs. |
| Visual checks | Focus fit at 1920×1080 and 1366×768; reduced-motion HTTP marker static at (800,300) for 100 ms with zero trails; 390 px mobile containment passed. |
| Final lab state | CLOSED, idle, zero metrics, all policy defaults and upstream normal/0 ms restored. |

That check found a readability defect despite viewport fit: Focus at 1366×768 rendered major labels around 12.6 px, annotations around 10.4 px and controls at 11–12 px. At 1920×1080 the original labels were already around 19.8/16.3 px.

## Bounded correction and writer-owned reruns

The change affects presentation and verification only: a Focus-only `40 110 1060 530` SVG viewBox removes duplicate instrument titles and nonessential stage-history spacing while retaining contacts, timeout dial/readouts, HTTP attempts, WAIT/return, success/failure/reject/probe, recovery and threshold meter. Circuit coordinates, engine/contracts/API/control semantics and the premium non-Focus plate/titles are unchanged.

| Exact check | Observed result after correction |
| --- | --- |
| `npm run build` | All four workspace builds passed. |
| `npm test` | 70/70 Vitest tests in 7 files plus 3/3 Node tests passed. |
| `npm audit --json` | Zero findings, exit 0. |
| `npm audit --omit=dev --json` | Zero production findings, exit 0. |
| `docker compose up --build -d --wait --no-deps frontend` | Only frontend rebuilt/recreated; backend `2922f3d91843` and upstream `768bb496055d` unchanged before/after. |
| `npm run verify:compose` | Fresh 10/10 acceptance groups passed after final deployment; all three container IDs unchanged across the harness. |
| `node apps/frontend/verify/browser-smoke.mjs /home/joaquinbianciotto/.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright --docker` | Full production regression passed; zero unexpected console/page errors and zero intentional-disconnect console diagnostics. |

Non-fatal npm warnings about the host's obsolete global `python` setting did not prevent builds/tests/audits. No dependencies were changed or installed during this correction. Audits are advisory-registry evidence, not image/OS scans, security approval or proof of safety.

### Focus RED → GREEN

The durable browser regression measures computed SVG font size multiplied by the screen transformation, not unscaled CSS font declarations. It checks the idle Focus labels against the instrument and viewport bounds, label-to-label overlaps and major component bounds (dial, contacts, HTTP winding, WAIT capacitor, meter, shunt and sockets). The timer's own millisecond readout is intentionally inside its dial.

- **RED:** Original 1366 Focus failed the ≥16 px major-label assertion: 12.59 px majors, 10.37 px annotations, 11 px controls.
- **Intermediate failure:** Compact geometry reached the typography targets but clipped `exhausted / non-retryable`; widening only the right crop margin fixed that failure.
- **GREEN:** Both corrected viewports meet the font floors, fit the viewport and have zero checked label clipping, label collisions or label/component collisions.

| Viewport | Minimum major label | Minimum core annotation/readout | Minimum control | Instrument bounds (screen px) |
| --- | --- | --- | --- | --- |
| 1366×768 | **16.94 px** | **13.95 px** | **13 px** | x=155–1211, y=99.5–627.5 |
| 1920×1080 | **26.94 px** | **22.19 px** | **13 px** | x=120–1800, y=99.5–939.5 |

Escape exits Focus and returns keyboard focus to its toggle; keyboard inspection still works. Reduced motion disables animation/trails and keeps the observed HTTP marker at (800,300) for 100 ms. Mobile page containment is checked at 390×844; the full non-Focus circuit remains horizontally scrollable on narrow screens. Reused Chromium profiles have cache disabled through CDP so the regression measures deployed bytes, not stale entry HTML. No mock routing or fabricated outcomes are used.

Documentation has no meaningful behavioral RED; its provenance and claims were checked by structural readback.

## Actual Docker scenario coverage

Every application call goes through frontend nginx at port 3000, not host backend/upstream ports. Read-only Docker introspection verifies service count, health, loopback publication, nonroot Node runtimes, Node 22.22.2, ESM contract resolution and absence of build tools in Node runtime images.

| Boundary | Observed assertion |
| --- | --- |
| Normal | One successful logical operation / one attempt; real upstream IDs match history and live SSE events. |
| Slow | Fast policy: 100 ms timeout, 2 retries, 15/30 ms waits, 500 ms deadline; three timeouts and actual upstream cancellations within the operation budget. |
| 503 / 422 | 503 gives exactly three attempts and two waits; 422 gives one attempt without retry. |
| Intermittent | Two attempts under one request ID, one completed logical success. |
| Inclusive threshold | Two failures plus two successes open at exactly four completed samples / 50%. |
| OPEN | Rejection creates zero attempts and no upstream receipt increment. |
| Recovery / probe | Actual recovery deadline; concurrent batch admits one single-attempt HALF_OPEN probe without retries and rejects others. Success closes; failure reopens. |
| SSE / replay | Correlated execution, unbuffered frames, Last-Event-ID precedence through nginx, strictly-after replay with no duplicates then live delivery. |
| Replay bounds / generation | Expired bounded cursor and reset generation yield replacement snapshots, not incomplete replay. |
| Heartbeat | Real comment heartbeat through nginx has no data or event ID. |

Production browser checks additionally exercise actual WAIT parking and retry-return coordinates, quarter-speed playback without changing backend timeout budgets, paused historical CLOSED versus live OPEN, rejection/no HTTP, exclusive probe recovery, Auto Demo, policy/upstream PATCH, one-attempt 422, hover/no HTTP, offline control gating and reconnect/reset generation replacement.

Polling uses bounded deadlines and waits for actual receipt/cancellation/idle observations. API calls have 15 s deadlines; SSE connections have a 120 s ceiling and are closed explicitly. The API harness finalizer restores defaults; the browser regression explicitly verifies CLOSED/idle, all-zero engine/upstream counters, empty histories/events/logs, every default policy field and upstream normal/0 ms configuration before exit.

## Deployment incident and final services

The earlier authorized `docker compose up --build -d --wait frontend` unexpectedly rebuilt/recreated **all three lab services**, including unchanged cached backend/upstream builds. In-memory lab state was replaced. Therefore the original independent no-restart evidence applies only to its earlier run, not across that deployment. No claim is made that these services never restarted or were never recreated.

After explicit approval, the isolated `--no-deps` deployment preserved backend/upstream IDs and replaced frontend `fd686139a0ce` with `0c4b270e1261`. Fresh scenario acceptance then retained all three IDs; no restart was used during those scenarios. All final lab services are running/healthy:

| Container | Final ID | Published host binding |
| --- | --- | --- |
| `resilience-lab-frontend-1` | `0c4b270e1261` | `127.0.0.1:3000→80/tcp` |
| `resilience-lab-backend-1` | `2922f3d91843` | None |
| `resilience-lab-external-api-1` | `768bb496055d` | None |

No stop/down operation or unrelated-container operation was performed by this writer. Independent final observation found KUBO running, but did not establish a before/after ID comparison for it.

## Refreshed screenshots

Ignored local files under `apps/frontend/.verification/`:

| File | Viewport / purpose |
| --- | --- |
| `docker-desktop.png` | 1440×1100, full-page normal success / full instrument and dock |
| `docker-projector-1366.png` | 1366×768, corrected Focus; viewport-only capture |
| `docker-projector-1920.png` | 1920×1080, corrected Focus; viewport-only capture |
| `docker-focus.png` | 1920×1080, corrected Focus |
| `docker-reduced-motion.png` | 1920×1080, static real HTTP marker / zero trails |
| `docker-mobile.png` | 390×844, full-page reflow / horizontally scrollable circuit |

Both corrected projector captures were opened for writer visual inspection. Full-page screenshots can exceed viewport height; only the projector captures are viewport-only artifacts. These are browser observations, not a physical projector trial or comprehensive accessibility assessment.

## Provenance, native review and remaining limits

Verified Anatomy primary citations are **already attached** in [architecture: real time versus visual playback](architecture.md#real-time-versus-visual-playback): README, craft guide, motion guide and actual dial-indicator example. The former claim that their primary URLs were unavailable is obsolete; no Anatomy artwork or code is imported.

Native code-review **was not completed**. The first ordinary START returned expired host consent with no invocation, lineage or mutation. After the Focus correction, a fresh inspection and START stopped during preflight with `lens_context_budget_exceeded`: the complete candidate evidence is too large for the native reviewer budget, and no review authority was created. Repeating the same candidate cannot succeed. A future native review needs smaller, coherent review slices and the applicable fresh consent; creating commits still requires the user's authorization. ASSESS returned unassessable/unavailable, so the high-risk fallback required writer self-verification plus an independent verifier; both were observed. **No native receipt or approval is claimed.** No review reset, recovery or switch change was performed.

Coverage limits: Chromium only; no physical projector, broad browser/device matrix, full accessibility audit or image/OS security scan. Full-body 200/422 stalled-response cancellation and deadline behavior passed against real **local HTTP** in [engine.test.ts lines 107–167](../apps/backend/test/engine.test.ts#L107-L167); there was no separate Docker stalled-body experiment. Post-correction independent evidence remains distinct from the correction writer's passing checks. The controller visually inspected the corrected 1366×768 projector capture.

The bounded correction writer changed only `Machine.tsx`, `App.tsx`, `styles.css`, the existing browser smoke script, this document and README; the controller subsequently recorded the final verification/review outcomes here. Engine/contracts/API/control semantics were unchanged by the correction. No staging, commits or push were performed.
