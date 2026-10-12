# Resilience Lab technical core

Run a real HTTP Circuit Breaker / Timeout / Retry experiment with shared ESM contracts, NestJS/Opossum and a Fastify upstream. State is bounded, in memory and unauthenticated; this is a local teaching lab, not a production gateway.

## Quick path

Use Node 22.20+ within Node 22 (verified 22.22.2) and npm.

```sh
npm ci
npm run build
npm test
# Two separate terminals, after building:
npm run dev:external
npm run dev:backend
```

Backend: http://localhost:3001; upstream: http://localhost:3002. Both native processes bind all host interfaces: use a trusted local machine/network. Each accepts PORT; backend EXTERNAL_API_URL defaults to http://localhost:3002. Stop each owned process with Ctrl-C. Rebuild after source changes. Contracts build before upstream and backend; their CommonJS entrypoints load the ESM workspace using Node 22 require(ESM). No frontend or container setup is part of this unit.

## Try the real API

```sh
curl -X PATCH http://localhost:3001/api/external -H 'content-type: application/json' -d '{"mode":"intermittent"}'
curl -X POST http://localhost:3001/api/requests -H 'content-type: application/json' -d '{"count":1}'
curl http://localhost:3001/api/snapshot
curl -N http://localhost:3001/api/events
```

One logical operation contains bounded attempts: 800 ms full-body timeout, two additional retries, 200/400 ms waits, 3000 ms total deadline. The inclusive 50% threshold uses at least four completed operations in a 20 s window. OPEN rejects without HTTP; after 7 s HALF_OPEN admits one non-retrying probe. Ordinary 4xx never retry. Policy mutation clears rolling statistics but preserves lifetime history; reset restores all defaults and changes replay generation. Management conflicts return 409 during active work.

## Verification and reference

The existing technical suite contains 60 tests, including compiled entrypoints and real HTTP/SSE. Run npm test after building. Audit with npm audit --json and npm audit --omit=dev --json; audits are registry evidence, not security approval. Vitest is locked to 5.0.3 and compatible esbuild to 0.28.2.

[Engine API, completed-operation statistics and SSE semantics](docs/engine.md). No push or PR was performed; native review approval is not claimed.
