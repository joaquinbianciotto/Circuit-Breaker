# Resilience engine

The memory-only technical core runs with the event-driven frontend in exactly three Compose containers. [Docker quickstart](../README.md), [architecture](architecture.md) and [observed verification](verification.md) describe the assembled lab. The native-statistics replacement is checked against an isolated Compose project; the running presentation stack is not restarted and no native code-review approval is claimed.

## Workshop reading path

Start with [`engine.ts`](../apps/backend/src/engine.ts), especially its constructor and `run()`:

1. The constructor protects `requests.perform(context)` with a circuit breaker.
2. `run()` starts one logical request and calls `breaker.fire(context)` exactly once. OPEN rejects it without HTTP; HALF_OPEN admits one probe.
3. `requests.finish()` records the logical result and publishes the events used by the simulator. Individual retry failures do not become separate breaker samples.

The teaching entrypoint is shorter because unrelated responsibilities are separated, **not because functionality was removed**:

| Module | Read it when explaining |
| --- | --- |
| [`engine.ts`](../apps/backend/src/engine.ts) | Protected operation, admission and public simulator orchestration |
| [`circuit-breaker.ts`](../apps/backend/src/circuit-breaker.ts) | Native Opossum thresholds/statistics, admission/recovery and late-completion isolation |
| [`requests.ts`](../apps/backend/src/requests.ts) | HTTP attempts, retries, deadlines, cancellation, request histories and counters |
| [`external-api.ts`](../apps/backend/src/external-api.ts) | Upstream configuration, reset and observed metrics |
| [`events.ts`](../apps/backend/src/events.ts) | SSE replay, cursors, retention and heartbeat cleanup |

`CircuitBreaker` delegates statistical opening to Opossum 8.5.0: there is no custom ledger or manual statistical `open()`. Default numeric policy values, HTTP controls and SSE transport stay intact; snapshot metrics now expose native calls as well as completed outcomes. Recovery isolation remains simulator-specific. Continue below for the native sampling semantics.

## Run the technical core

Use Node **22.20+ within the Node 22 line** (verified on 22.22.2).

```sh
npm ci
npm run build
npm test
# Separate terminals, after building:
npm run dev:external
npm run dev:backend
```

The upstream binds `0.0.0.0:3002`; Nest binds `0.0.0.0:3001`. Each process accepts its own `PORT` override. Backend `EXTERNAL_API_URL` defaults to `http://localhost:3002`; it is deployment configuration, not an API/UI input. No environment-file loader is needed.

`@resilience/contracts` is an actual npm workspace package, not a TypeScript path alias. It exports ESM JavaScript plus declarations. Vite can import that ESM directly; the CommonJS Nest/Fastify builds use Node 22's synchronous ESM `require()` support. Contracts must be built first. The root build does this in order. Direct dependencies are exact versions; transitive versions are locked.

This unauthenticated lab is not a production gateway. Compose publishes only frontend `127.0.0.1:3000`; backend/upstream bind all interfaces **inside the Docker network** without host publication. Native development processes bind all host interfaces: keep them on a trusted development machine/network. Vitest **5.0.3** patched the original dev-only critical/moderate findings. A low Windows development-server esbuild advisory, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), was then removed by a compatible lock-only refresh to **esbuild 0.28.2** under Vite 7.3.7. Current full and production-only npm audits both report **zero findings**; no force fix or overrides were used. Audit does not evaluate container OS/image vulnerabilities, lab authentication or production readiness.

## What one request means

One **logical operation** goes through real Opossum `fire()`. Its protected action contains all attempts and waits; retries are not independent breaker calls.

| Default policy | Value |
| --- | --- |
| Per-attempt timeout | 800 ms |
| Additional retries | 2 maximum |
| Retry waits | 200 ms, then 400 ms |
| Whole-operation deadline | 3000 ms |
| Opening error percentage | **greater than** 50% |
| Minimum calls to `fire()` | 4 |
| Rolling window | 20000 ms |
| OPEN recovery wait | 7000 ms |

- Each attempt is real `fetch('/work')`, with fresh `AbortController`, `x-request-id` and `x-attempt-id`. Its timeout remains live until the **whole response body** finishes, not just headers. Timers are cleared on settlement. Response bodies are drained without accumulation, capped at 64 KiB.
- Retry only HTTP 5xx, network/body transport failure or timeout. Known 4xx fails once, including 429 and a 4xx response whose body later times out; it still counts as one logical breaker failure. Oversized bodies fail without retry.
- Use a monotonic clock for the operation budget; each attempt timeout is clamped to the remaining budget. A retry requires the **full configured backoff** to finish with positive budget left. If the backoff equals or exceeds the budget, wait only to the actual deadline and finish with `operation-deadline`, without another HTTP attempt. Recheck the monotonic target after every timer wake: an early wake cannot shorten either wait. `RETRY_SCHEDULED.backoffMs` describes the bounded wait; `RETRY_STARTED` appears only after an eligible completed wait. Shutdown cancels the wait without retry. No attempt starts after expiration. The default 3000 ms is `3 × 800 + 200 + 400`; overhead consumes that same budget, so the final attempt can have less than 800 ms.
- OPEN arrivals are rejected by Opossum without HTTP. HALF_OPEN's real `pendingClose` gate synchronously admits exactly one probe. That probe has **one attempt and no retry**. Other arrivals reject even while the probe is pending. Success closes; failure or timeout reopens.
- Batches launch 1–10 logical operations concurrently and return every expected outcome. They do not turn breaker rejection/failure into an HTTP 500. Global admission is capped at 100 executing operations; excess arrivals reject without HTTP.

### Native Opossum statistics

The configured threshold is passed directly to Opossum; automatic statistical opening is enabled.

1. [`fail()` evaluates `failures / fires * 100 > errorThresholdPercentage`](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L978-L997) once minimum **call** volume is met. Successful completions do not evaluate statistical opening.
2. [`call()` emits `fire` before admission](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L643-L727): pending actions and Opossum OPEN rejections are included. Retry attempts inside one action are not additional calls. Engine maintenance/capacity rejections occur before `fire()` and are not native calls.
3. Exactly two failures followed by two successes remain CLOSED at 50%. A subsequent failure produces 3/5 = 60% and opens. A configured 100% threshold does not open at exactly 100% either.

The snapshot reports the active Opossum instance's counters:

| Metric | Native source |
| --- | --- |
| `rollingCalls` | `stats.fires`, including pending actions and native rejections |
| `rollingCompleted` | `stats.successes + stats.failures` |
| `rollingFailed` | `stats.failures` |
| `errorPercentage` | `stats.failures / stats.fires * 100`, or 0 when there are no calls |

Lifetime `completed`, `succeeded`, `failed`, `rejected` and `active` still describe real logical operations independently of that window. Native statistics use one periodically rotating bucket: samples expire together, and a call and its later outcome can land in different buckets. There is no exact per-completion timestamp ledger.

### Concurrency fence: an old success is not a probe

The installed source's [`success` listener closes any HALF_OPEN breaker](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L348-L353), without checking whether the success belongs to its probe. An action admitted while CLOSED can finish after OPEN → HALF_OPEN; on the same instance it would incorrectly close the gate. A late old failure can likewise reopen it via `fail()`'s HALF_OPEN branch.

Every opening therefore shuts down/detaches that instance and immediately opens a fresh **real Opossum** instance. Already-admitted actions settle through their old promises; shutdown removes their listeners and old recovery/statistics timers. Only the fresh instance's controlled probe can affect its recovery state. Its real reset timer starts on opening. Tests place both a late old success and a late old failure inside another operation's pending probe and verify that neither changes the gate.

Lifetime counters keep all admitted outcomes, including old actions that settle late. Native counters belong only to the active instance: they start fresh on the isolation replacement at OPEN and on policy replacement. Detached old actions cannot update the new instance's counters. A successful probe adds a native success, but Opossum `close()` does **not** reset its statistics; OPEN rejections already recorded in that instance remain in its denominator until bucket rotation. Use lifetime history, not the post-opening native window, to inspect what originally tripped the circuit.

## Backend API

In Compose, all paths below use the same-origin frontend at **http://localhost:3000**; port 3001 is not published. Native development can use `http://localhost:3001`. JSON types/validators live in `packages/contracts/src/index.ts`.

| Method and path | Meaning / response |
| --- | --- |
| `GET /api/health` | `{ok, state}` |
| `GET /api/config` | `Policy` |
| `PATCH /api/config` or `POST /api/config` | Strict partial policy → resulting `Policy` |
| `POST /api/requests` | `{count: 1..10}` → `BatchResponse {results: LogicalResult[]}` |
| `GET /api/snapshot` | Authoritative `Snapshot`, including active histories and observed upstream config/metrics |
| `GET /api/events` | SSE: named `engine`/`snapshot` messages and heartbeat comments |
| `GET /api/external` | Real proxy read → `ExternalConfig` |
| `PATCH /api/external` | Validated real upstream config mutation → `ExternalConfig` |
| `POST /api/reset` | Reset upstream then engine → new-generation `Snapshot` |

GET/PATCH success is 200; Nest POST success is 201. Validation errors are 400, active-work/management conflicts 409, unavailable/failed upstream management calls 502. Expected work failures appear inside `results`, with outcome `failure` or `rejected`, attempts, elapsed duration, reason and request ID.

Policy patches reject unknown keys, numeric strings, non-finite values, fractions and out-of-range integers. Bounds: timeout 10–30000 ms; retries 0–2; base backoff 0–5000 ms; deadline 10–90000 ms; threshold 1–100%; minimum volume 1–10000; rolling window 100–300000 ms; recovery 20–60000 ms. Deadline smaller than attempt timeout is intentional and supported.

Policy, upstream-config mutation and reset reject with 409 while engine work/management is active. Management holds a lock across real upstream calls; arrivals during that interval return a maintenance rejection. Each proxied HTTP call has a 1000 ms timeout through JSON body consumption. Upstream reset also rejects if independently initiated upstream work remains active.

**Policy replacement:** preserve lifetime counters, history, events and SSE epoch; shut down the old breaker/timers, clear rolling samples, establish CLOSED, emit a global `CIRCUIT_CLOSED` with reason `policy-replaced`. The mutation response supplies the new policy.

**Reset choice:** restore default policy, CLOSED, empty lifetime/rolling metrics, histories/events, and upstream default settings/counters/logs/seed. Successful reset creates a new UUID generation and broadcasts a snapshot to connected clients. If upstream reset fails, engine state/history/generation is not cleared. This is memory-only, not durable cross-service transaction storage.

Example retry demonstration:

```sh
curl -X PATCH http://localhost:3000/api/external \
  -H 'content-type: application/json' -d '{"mode":"intermittent"}'
curl -X POST http://localhost:3000/api/requests \
  -H 'content-type: application/json' -d '{"count":1}'
```

## SSE and frontend handoff

`EngineEvent` contains `id`, increasing `sequence`, UUID `epoch`, epoch-ms `timestamp`, current circuit `state`, and `requestId`. Only timer/global transitions have a null request ID. Attempt events include `attemptId` and one-based `index`; applicable events carry status, duration, reason, backoff, operation deadline and probe flag. Timeout has its own terminal `ATTEMPT_TIMEOUT` event, not an additional duplicate attempt failure.

Event names: `REQUEST_STARTED`, `ATTEMPT_STARTED`, `ATTEMPT_SUCCEEDED`, `ATTEMPT_FAILED`, `ATTEMPT_TIMEOUT`, `RETRY_SCHEDULED`, `RETRY_STARTED`, `CIRCUIT_OPENED`, `CIRCUIT_HALF_OPEN`, `CIRCUIT_CLOSED`, `REQUEST_REJECTED`, `REQUEST_FINISHED`.

SSE ID is `<epoch>:<sequence>`. Sequence never decreases within the server process, including reset; restart gets a fresh UUID and starts a fresh sequence. Since there is no durable storage, a different generation requires rehydration, not old-event replay.

1. New connections receive a named `snapshot` message with separately typed `SnapshotMessage {kind, reason, snapshot}`. REST `/api/snapshot` returns the inner `Snapshot` directly.
2. Reconnect with `Last-Event-ID`, or `?cursor=<encoded ID>` for a newly constructed EventSource. The header takes precedence over the URL query. Valid replay is **strictly after** that cursor, then live events; synchronous registration/replay has no await gap.
3. Expired, malformed, future or different-generation cursors receive an authoritative snapshot (`expired`, `invalid` or `generation`) instead of an incomplete tail. Reset sends `reason: reset` to existing streams.
4. Treat snapshots as replacement state, not request events. Deduplicate by epoch and sequence; never reapply events at/below an already-applied cursor. Snapshot `events` is the bounded inspection/playback tail, not new logical work.
5. Heartbeats are comment-only frames (`: heartbeat <epoch-ms>`), **no id**, every 15 seconds. Nest otherwise auto-generates numeric IDs for data messages without IDs, corrupting Last-Event-ID; comment-only frames bypass that behavior (verified with compiled Nest over real HTTP). Nest Observable teardown removes listeners/timers on disconnect; it does not use incoming request-body `close` as SSE disconnect. Service shutdown completes streams, including subscriptions whose initial upstream refresh is pending.

Snapshot includes state, policy, lifetime/rolling metrics, finished **and active** histories, replay cursor/event tail, `openedAt`, `recoveryAt`, `serverTime`, external data or error. Engine state is captured synchronously. Upstream config/metrics are actual HTTP observations, not an atomic distributed transaction; `externalObservedAt` records their freshness. Asynchronous refresh results are revision-fenced so an older read cannot overwrite a completed reset/config mutation. Frontend should use `serverTime` to align countdowns, not invent breaker transitions.

Memory bounds: 100 executing operations, 200 finished histories, 1000 events; upstream retains 200 finished logs plus at most 100 active logs. Rolling metrics aggregate by millisecond and expire at the configured window; validated maximum window bounds bucket count. Lifetime counters do not need per-request storage.

## Upstream API and modes

Inside Compose, relative to `http://external-api:3002` (not published to the host); native development uses `http://localhost:3002`: `GET /health`, `GET /config`, `PATCH /config`, `GET /metrics`, `POST /reset`, `GET /work`.

- Config: `mode` (`normal`, `slow`, `fail`, `intermittent`); integer `latencyMs` 0–30000; integer `errorStatus` 400–599; finite `failureRate` 0–1; `intermittent` strategy (`alternating`, `probability`). Unknown/invalid JSON fields fail 400.
- `normal` succeeds after configured latency. `slow` uses 1500 ms when latency is zero; any positive explicit latency overrides that convenience default. `fail` returns the configured error status after latency.
- `intermittent: alternating` fails the first intermittent call after reset, succeeds the second, then alternates. Normal/fail traffic does not advance that sequence. This makes a single request followed by its retry reproducible; concurrent batches share the sequence and can interleave.
- `intermittent: probability` uses the configured failure rate and a seeded xorshift sequence. Reset restores the seed; rates 0 and 1 guarantee success and failure respectively. Alternating intentionally ignores probability.
- Metrics count received/completed/cancelled/active and preserve correlated logs. Client abort is detected with **response** `close && !writableEnded`, cancels the delay timer and counts cancelled rather than completed. Capacity rejection is an immediate completed 503, included in received/completed metrics.

## Historical test-first evidence

The following T1 and deadline/backoff results describe earlier local tests, not the native-statistics candidate. Current proof uses the [Compose-only workflow](verification.md#current-compose-only-workflow), whose rebuilt stack passed 16 acceptance groups; no host unit suites were run for the native replacement. No native code-review approval is claimed.

The original **T1** evidence covered 54 core tests. Later corrected suites contained **60 core tests** (33 engine, 21 API/events/startup, 6 upstream), **76 Vitest tests** including the frontend, and **3 Node helper tests**. Those historical results are retained separately from the current Compose observations.

Observed RED: four pre-engine behavior tests failed on expected success/failure versus the scaffold's rejection. First GREEN: those four passed using real local Fastify HTTP. Additional observed RED/GREEN regressions: stalled HTTP 422 bodies originally retried three times instead of once; Nest originally assigned heartbeat ID `1` instead of leaving the replay cursor unchanged. Both fixes pass their targeted tests. Original T1 focused validation: 54 tests passed (27 engine, 21 API/events/startup, 6 upstream). Expanded deterministic suites cover retries/backoffs, full-body abort, fresh controllers, deadline clamping, inclusive threshold, no-HTTP OPEN, both HALF_OPEN outcomes, stale-action concurrency, mutation 409, proxy timeout, bounded history, replay/gap/generation/deduplication, heartbeats and teardown. Compiled entrypoint tests start **both Node processes** and execute backend-to-upstream HTTP; Nest REST/SSE tests import the actual `tsc` output.

### Deadline/backoff regression

An independent concurrent snapshot run observed **69/70** UI tests passing: the deadline/backoff case made **two attempts instead of one**. Isolated reruns passed, but neither erase that failure nor establish an environmental cause. The old engine clipped backoff to the budget, awaited once and admitted a retry whenever any budget remained.

Deterministic RED used real Fastify HTTP with a controlled monotonic clock and wait scheduler: after failure at 20.25 ms, a 200 ms backoff was clipped to the 100 ms deadline. Waking at 99.75 ms produced an erroneous `RETRY_STARTED`. GREEN rechecks the wait target, stays pending at that early wake and finishes only at the actual 100 ms deadline, with one HTTP attempt and one logical failure. This proves the admission defect under an early wake, **not** the precise trigger of the original untraced intermittent failure.

Six added cases cover truncated/full/equal/zero backoffs, exhausted budget and shutdown. They assert real upstream call counts, no premature retry/attempt events, one completed logical sample and wait-timer cleanup. At that time all 33 engine tests and the full 76 + 3 suite passed sequentially; existing real-time deadline expectations were unchanged. No shared API/event schema changed.

Historical focused commands (not run for the current Compose-only verification):

```sh
npm run test:engine
npm run test:api
npm run test:external
```

References inspected: [Opossum circuit source, v8.5.0](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js), [Nest SSE lifecycle](https://docs.nestjs.com/techniques/server-sent-events), [Nest SSE serialization source, v11.2.7](https://github.com/nestjs/nest/blob/v11.2.7/packages/core/router/sse-stream.ts), [Node require(ESM)](https://nodejs.org/docs/latest-v22.x/api/modules.html#loading-ecmascript-modules-using-require).
