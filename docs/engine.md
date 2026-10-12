# Resilience engine

The memory-only technical core uses shared ESM contracts, real Opossum admission and real upstream HTTP. See the [native quickstart](../README.md).

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

`@resilience/contracts` is an actual npm workspace package, not a TypeScript path alias. It exports ESM JavaScript plus declarations. The CommonJS Nest/Fastify builds use Node 22's synchronous ESM `require()` support. Contracts must be built first. The root build does this in order. Direct dependencies are exact versions; transitive versions are locked.

This unauthenticated lab is not a production gateway. Native processes bind all host interfaces: keep them on a trusted development machine/network. Vitest **5.0.3** patched the original dev-only critical/moderate findings. A low Windows development-server esbuild advisory, [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), was then removed by a compatible lock-only refresh to **esbuild 0.28.2** in the locked development toolchain. Current full and production-only npm audits both report **zero findings**; no force fix or overrides were used. Audit does not evaluate container OS/image vulnerabilities, lab authentication or production readiness.

## What one request means

One **logical operation** goes through real Opossum `fire()`. Its protected action contains all attempts and waits; retries are not independent breaker calls.

| Default policy | Value |
| --- | --- |
| Per-attempt timeout | 800 ms |
| Additional retries | 2 maximum |
| Retry waits | 200 ms, then 400 ms |
| Whole-operation deadline | 3000 ms |
| Opening error percentage | **at least** 50% |
| Minimum completed volume | 4 |
| Rolling window | 20000 ms |
| OPEN recovery wait | 7000 ms |

- Each attempt is real `fetch('/work')`, with fresh `AbortController`, `x-request-id` and `x-attempt-id`. Its timeout remains live until the **whole response body** finishes, not just headers. Timers are cleared on settlement. Response bodies are drained without accumulation, capped at 64 KiB.
- Retry only HTTP 5xx, network/body transport failure or timeout. Known 4xx fails once, including 429 and a 4xx response whose body later times out; it still counts as one logical breaker failure. Oversized bodies fail without retry.
- Use a monotonic clock for the operation budget; each attempt timeout is clamped to the remaining budget. A retry requires the **full configured backoff** to finish with positive budget left. If the backoff equals or exceeds the budget, wait only to the actual deadline and finish with `operation-deadline`, without another HTTP attempt. Recheck the monotonic target after every timer wake: an early wake cannot shorten either wait. `RETRY_SCHEDULED.backoffMs` describes the bounded wait; `RETRY_STARTED` appears only after an eligible completed wait. Shutdown cancels the wait without retry. No attempt starts after expiration. The default 3000 ms is `3 × 800 + 200 + 400`; overhead consumes that same budget, so the final attempt can have less than 800 ms.
- OPEN arrivals are rejected by Opossum without HTTP. HALF_OPEN's real `pendingClose` gate synchronously admits exactly one probe. That probe has **one attempt and no retry**. Other arrivals reject even while the probe is pending. Success closes; failure or timeout reopens.
- Batches launch 1–10 logical operations concurrently and return every expected outcome. They do not turn breaker rejection/failure into an HTTP 500. Global admission is capped at 100 executing operations; excess arrivals reject without HTTP.

### Why the completed ledger exists

Opossum 8.5.0 does not implement the requested statistical meaning:

1. [`fail()` uses `failures / fires` and strict `>`](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L978-L997), not inclusive `>=`.
2. [`call()` emits `fire` before the OPEN gate](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L643-L727), so its denominator includes pending actions and OPEN rejections.

We disable **automatic CLOSED threshold calculation only** with `errorThresholdPercentage: 101`. An exact millisecond-bucket rolling ledger counts completed logical successes/failures, never attempts, pending work or rejected admissions. At minimum volume and inclusive percentage, it calls real `Opossum.open()`. This is not a separate synthetic breaker: Opossum owns OPEN, the recovery timer, HALF_OPEN exclusion, probe transitions and admission. The test for two failures followed by two successes opens on the fourth completed operation, at exactly 50%.

### Concurrency fence: an old success is not a probe

The installed source's [`success` listener closes any HALF_OPEN breaker](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L348-L353), without checking whether the success belongs to its probe. An action admitted while CLOSED can finish after OPEN → HALF_OPEN; on the same instance it would incorrectly close the gate. A late old failure can likewise reopen it via `fail()`'s HALF_OPEN branch.

Every opening therefore shuts down/detaches that instance and immediately opens a fresh **real Opossum** instance. Already-admitted actions settle through their old promises; shutdown removes their listeners and old recovery/statistics timers. Only the fresh instance's controlled probe can affect its recovery state. Its real reset timer starts on opening. Tests place both a late old success and a late old failure inside another operation's pending probe and verify that neither changes the gate.

Lifetime counters keep all admitted outcomes. The rolling ledger includes late completions during OPEN/HALF_OPEN; successful recovery clears the rolling baseline. Older-generation completions after recovery cannot pollute that new baseline. A successful probe itself becomes the first new completed sample.

## Backend API

All backend paths below use `http://localhost:3001` in native development. JSON types/validators live in `packages/contracts/src/index.ts`.

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
curl -X PATCH http://localhost:3001/api/external \
  -H 'content-type: application/json' -d '{"mode":"intermittent"}'
curl -X POST http://localhost:3001/api/requests \
  -H 'content-type: application/json' -d '{"count":1}'
```

## SSE client contract

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

The native upstream uses `http://localhost:3002`: `GET /health`, `GET /config`, `PATCH /config`, `GET /metrics`, `POST /reset`, `GET /work`.

- Config: `mode` (`normal`, `slow`, `fail`, `intermittent`); integer `latencyMs` 0–30000; integer `errorStatus` 400–599; finite `failureRate` 0–1; `intermittent` strategy (`alternating`, `probability`). Unknown/invalid JSON fields fail 400.
- `normal` succeeds after configured latency. `slow` uses 1500 ms when latency is zero; any positive explicit latency overrides that convenience default. `fail` returns the configured error status after latency.
- `intermittent: alternating` fails the first intermittent call after reset, succeeds the second, then alternates. Normal/fail traffic does not advance that sequence. This makes a single request followed by its retry reproducible; concurrent batches share the sequence and can interleave.
- `intermittent: probability` uses the configured failure rate and a seeded xorshift sequence. Reset restores the seed; rates 0 and 1 guarantee success and failure respectively. Alternating intentionally ignores probability.
- Metrics count received/completed/cancelled/active and preserve correlated logs. Client abort is detected with **response** `close && !writableEnded`, cancels the delay timer and counts cancelled rather than completed. Capacity rejection is an immediate completed 503, included in received/completed metrics.

## Verification evidence

The original T1 evidence covered 54 core tests. The corrected technical-core suite contains **60 tests** (33 engine, 21 API/events/startup, 6 upstream); the full core/frontend suite contains **76 tests**. Clean-snapshot results are recorded separately; no native review approval is claimed.

Observed RED: four pre-engine behavior tests failed on expected success/failure versus the scaffold's rejection. First GREEN: those four passed using real local Fastify HTTP. Additional observed RED/GREEN regressions: stalled HTTP 422 bodies originally retried three times instead of once; Nest originally assigned heartbeat ID `1` instead of leaving the replay cursor unchanged. Both fixes pass their targeted tests. Original T1 focused validation: 54 tests passed (27 engine, 21 API/events/startup, 6 upstream). Expanded deterministic suites cover retries/backoffs, full-body abort, fresh controllers, deadline clamping, inclusive threshold, no-HTTP OPEN, both HALF_OPEN outcomes, stale-action concurrency, mutation 409, proxy timeout, bounded history, replay/gap/generation/deduplication, heartbeats and teardown. Compiled entrypoint tests start **both Node processes** and execute backend-to-upstream HTTP; Nest REST/SSE tests import the actual `tsc` output.

### Deadline/backoff regression

An independent concurrent snapshot run observed **69/70** UI tests passing: the deadline/backoff case made **two attempts instead of one**. Isolated reruns passed, but neither erase that failure nor establish an environmental cause. The old engine clipped backoff to the budget, awaited once and admitted a retry whenever any budget remained.

Deterministic RED used real Fastify HTTP with a controlled monotonic clock and wait scheduler: after failure at 20.25 ms, a 200 ms backoff was clipped to the 100 ms deadline. Waking at 99.75 ms produced an erroneous `RETRY_STARTED`. GREEN rechecks the wait target, stays pending at that early wake and finishes only at the actual 100 ms deadline, with one HTTP attempt and one logical failure. This proves the admission defect under an early wake, **not** the precise trigger of the original untraced intermittent failure.

Six added cases cover truncated/full/equal/zero backoffs, exhausted budget and shutdown. They assert real upstream call counts, no premature retry/attempt events, one completed logical sample and wait-timer cleanup. All 33 engine tests and the 76-test core/frontend suite pass sequentially; existing real-time deadline expectations are unchanged. No shared API/event schema changed.

Focused commands (build first for compiled API/startup tests):

```sh
npm run test:engine
npm run test:api
npm run test:external
```

References inspected: [Opossum circuit source, v8.5.0](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js), [Nest SSE lifecycle](https://docs.nestjs.com/techniques/server-sent-events), [Nest SSE serialization source, v11.2.7](https://github.com/nestjs/nest/blob/v11.2.7/packages/core/router/sse-stream.ts), [Node require(ESM)](https://nodejs.org/docs/latest-v22.x/api/modules.html#loading-ecmascript-modules-using-require).
