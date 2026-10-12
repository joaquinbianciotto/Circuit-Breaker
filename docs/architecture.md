# Three containers, one logical breaker

The network topology is **frontend → backend → external-api**. The electrical drawing instead models one protected logical operation and its retry loop; it is not a diagram of three breakers or three sequential resilience filters.

## Deployment boundary

```text
Browser http://localhost:3000
    │ 127.0.0.1:3000 → 80 (the only published port)
    ▼
frontend: nginx / static React distribution
    │ /api/* HTTP + SSE, same origin
    ▼
backend:3001 — compiled NestJS / real Opossum
    │ fetch /work + management HTTP
    ▼
external-api:3002 — compiled Fastify
```

Exactly these three services share the Compose network. There is no broker, database, volume, initialization sidecar or fourth proxy service. Health-gated dependencies order upstream, backend, frontend; `init: true` handles process reaping. Node build/runtime stages use **22.22.2-alpine**, `npm ci` and the root lock. Runtime Node processes run as `node` with selected production dependencies only. The copied ESM contracts package and workspace symlink targets are essential to the compiled CJS services' Node 22 require(ESM) imports.

Frontend runtime is nginx, not Vite. Its `/api/` location retains paths, query cursor and request headers (including Last-Event-ID), uses HTTP/1.1 upstream keepalive and a one-hour read timeout. Buffering, caching and compression are disabled there, so SSE events and comment heartbeats are delivered as frames rather than accumulated into chunks. Build contexts omit local dependencies, Git, generated output and verification/browser artifacts. See [Compose](../compose.yaml) and [nginx configuration](../apps/frontend/nginx.conf).

## One operation, bounded HTTP attempts

[Engine source](../apps/backend/src/engine.ts) calls real Opossum `fire()` once per logical request. Its action performs attempts and backoffs internally. Each fresh AbortController covers headers **and full body consumption**, capped at 64 KiB, with cleanup on every settlement. A monotonic total deadline bounds attempt time and waits; elapsed overhead consumes the same budget. Default retries are 2 extra, waits 200/400 ms, timeout 800 ms, deadline 3000 ms.

5xx, timeout and network/body failure can retry; ordinary 4xx (including 429 or a later stalled 4xx body) fails once. Oversized bodies do not retry. [Fastify source](../apps/external-api/src/server.ts) records real correlated received/completed/cancelled/active counts and cancels pending latency on client disconnect.

### Inclusive completed-operation statistics

Opossum 8.5.0's [threshold source](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L978-L997) uses strict `>` and failures/fires, while its [admission source](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L643-L727) emits fire before rejecting OPEN traffic. Neither denominator nor strictness matches this lab's **≥50% of at least four completed logical operations** contract.

The engine disables automatic CLOSED statistical opening (`errorThresholdPercentage: 101`) and maintains a bounded rolling completed ledger. At inclusive threshold it calls actual Opossum `open()`. Attempts, pending work and rejected admissions are excluded. Opossum still owns OPEN rejection, recovery timer, HALF_OPEN pendingClose exclusion and probe success/failure transitions. Two failures plus two successes open at the fourth completion, not after a fifth failure.

### Instance fencing protects recovery

Opossum's [success listener](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js#L348-L353) closes any HALF_OPEN instance, even for an old CLOSED action. On opening, the engine shuts down/detaches that instance and opens a fresh real Opossum instance. Old promises still settle, but cannot close/reopen the new probe gate. Shutdown removes old listeners/statistics/recovery timers. Generation fences prevent late completions after successful recovery from contaminating the new baseline. HALF_OPEN allows one probe with **one attempt, no retries**; concurrent callers reject without upstream traffic.

## Stream and memory boundaries

[EventJournal source](../apps/backend/src/events.ts) retains at most 1000 events; the engine retains 200 finished histories plus at most 100 active operations. Upstream keeps 200 finished logs plus bounded active logs. All state is memory-only.

SSE IDs are `<UUID epoch>:<increasing sequence>`. Valid Last-Event-ID replays strictly after its cursor, then joins live delivery synchronously. Expired, invalid/future and different-generation cursors receive replacement snapshots rather than an incomplete tail. Reset changes epoch and broadcasts a reset snapshot; sequence never decreases within the process. Heartbeats every 15 s are comments only: no data and no ID to corrupt replay. Snapshots contain actual upstream observations and their freshness timestamp, not an atomic cross-container transaction. Acceptance polling waits for the needed receipt/cancellation counts instead of trusting a stale observation.

## Real time versus visual journeys

[Visual model](../apps/frontend/src/model.ts), [stream integration](../apps/frontend/src/useLab.ts) and [machine drawing](../apps/frontend/src/Machine.tsx) ingest actual REST/SSE snapshots/events with epoch, sequence and stale-response fences. The Visual speed selector offers 1× (default), 0.5× and 0.25× in normal and Focus View. It scales only journey delta, preserving accumulated progress and queued stages; unsupported rates fall back to 1×. App holds the non-persisted rate; `useLab` reads it through a ref without restarting the SSE/RAF lifecycle. The authoritative clock, HTTP timers, live metrics and gate remain current and unscaled. There is no pause or replay. Reduced-motion static markers, offscreen freezing and at most one visual stage transition per painted frame remain unchanged. Recovery countdown reaching zero waits for the actual HALF_OPEN event. Timeout/deadline readouts derive from observed timestamps, not animation duration.

The design adapts [Anatomy](https://github.com/wheresryan22/anatomy)'s working-object philosophy: the mechanism itself explains the concept, and motion and numerical readouts share an underlying model. Research covered its [README](https://github.com/wheresryan22/anatomy/blob/main/README.md), [craft guide](https://github.com/wheresryan22/anatomy/blob/main/references/craft.md), [motion guide](https://github.com/wheresryan22/anatomy/blob/main/references/motion.md), and actual [dial-indicator example](https://github.com/wheresryan22/anatomy/blob/main/examples/dial-indicator/build.mjs). The transferable principles are purposeful inspectable components, bounded glow, calm timestamp-driven motion and reduced-motion access—not copied illustrations, isometric geometry or 3D. No Anatomy code or artwork is imported. This lab's implementation is [Machine.tsx](../apps/frontend/src/Machine.tsx), [SVG topology](../apps/frontend/src/topology.ts) and [styles.css](../apps/frontend/src/styles.css); [task provenance](../odd/tasks/resilience-lab.md#progressevidence) records the research handoff.

## Local lab, not a gateway

There is no authentication, persistence or durable multi-service reset transaction. Reset/management conflict handling protects in-flight work but does not provide production isolation. Loopback publication reduces exposure; it is not an authorization boundary against other local users/processes. Do not put this lab behind a public ingress. Native host development binds all interfaces and needs the same trusted-machine caution.

[Verification evidence](verification.md) covers packaging and real runtime self-checks. Image/OS security scanning, independent T4 review and wider device/projector evaluation are not claimed.

Further primary references: [complete Opossum source v8.5.0](https://github.com/nodeshift/opossum/blob/v8.5.0/lib/circuit.js), [Node 22 require(ESM)](https://nodejs.org/docs/latest-v22.x/api/modules.html#loading-ecmascript-modules-using-require), [Nest SSE lifecycle](https://docs.nestjs.com/techniques/server-sent-events). Full policy/API details: [engine](engine.md).
