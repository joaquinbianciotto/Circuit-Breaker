# Request visual speed

## Objective
Slow observed request journeys so users can follow their route without changing real HTTP or circuit-breaker timing.

## Scope and decisions
- Presentation-only selector: 1× (default), 0.5×, 0.25×, available in normal and Focus View.
- Scale journey elapsed only; preserve authoritative clocks, SSE lifecycle, identity, queued stages and current progress.
- No pause, replay, persistence, backend changes, deployment or lab-data reset.
- English UI/artifacts; accessible native control and responsive toolbar.

## Tasks
- [x] T1 (verified): Implement visual speed, deterministic regression tests, smoke assertions and concise documentation.
- [x] T2 (verified): Correct Focus viewport overflow and re-run isolated native browser verification. Native review unavailable after consent expiry; independent verification fallback completed.

## Acceptance and checks
- Quarter speed takes four times presentation delta; default behavior remains unchanged.
- Speed changes preserve elapsed progress; authoritative clocks/outcomes stay live.
- No fabricated completion without observed events; reduced motion and Focus View work.
- Commands: npx vitest run apps/frontend/test/model.test.ts apps/frontend/test/topology.test.ts; npm run test:frontend; npm run build -w @resilience/contracts; npm run build -w @resilience/frontend.
- Browser checks must use isolated native services, never --docker or reset existing lab data. No installations without approval.

## Evidence and delivery
Work-unit commit: `87c6223907fe473eb784ab73fd41eeca0a7859a6` — `feat(frontend): add visual request speed control` (T1/T2, code/tests/docs together).
T1 worker evidence: RED 3 expected failures/27 passes; GREEN 30 focused tests, 33 frontend tests, contracts/frontend builds and diff check passed. Source spot-check confirms only journey delta scaled and ref-based rate updates. Initial browser verification caught Focus overflow; correction and full worker browser GREEN recorded below. Current branch: feat/resilience-lab; starting worktree clean. User explicitly requested the work-unit commit. Push and deployment remain unauthorized.
Rollback boundary: remove visual multiplier/control, related tests and docs without changing backend behavior.

## T2 evidence
Independent verifier: 30 focused and 33 frontend tests passed; contracts/frontend/backend/external-api builds passed. Native smoke used existing global Playwright and isolated ports 3100–3102 (free before/after), no existing lab reset. Speed selector, quarter-rate ~4x inlet duration, real HTTP independence, unchanged SSE and prior flow scenarios passed. Initial run failed viewport containment at Focus 1366×768 (browser-smoke.mjs:384); resolved and all subsequent scenarios verified as recorded below. Native review START consent expired without lineage creation; ASSESS unassessable requires independent verification.

## Verification output authorization
User approved generated outputs under apps/frontend/.verification/, apps/frontend/dist/, apps/frontend/node_modules/.vite/, node_modules/.vite/ and node_modules/.vite-temp/. Use npm run build -w @resilience/frontend -- --emptyOutDir false to avoid output deletion. Correction worker resumed after scope stop; no edits were made during that stop.

## Correction evidence
Candidate-caused stacked helper increased toolbar height 43.5→49px, pushing absolute screen-reader status below 768px. Two-line Focus CSS override makes helper inline/wrappable; no hidden overflow or lowered readability thresholds. Worker observed native RED then full GREEN at 1366×768 and 1920×1080, quarter-speed, Escape/focus restoration, reduced motion, keyboard, mobile and final console checks. 33 frontend tests, non-deleting frontend build, diff check passed; isolated ports free before/after. One prior corrected-layout run failed console check on restart snapshot ECONNRESET/500, unchanged assertion passed on final rerun. Independent post-correction run PASSED: 33 frontend tests, full native smoke and diff check; zero unexpected console/page errors, isolated ports free before/after. Both Focus viewports fit exactly. Browser mid-flight rate continuity not covered by smoke; deterministic tests cover it. Production/Docker, physical projectors and broader suites skipped.

## Next step
Use Visual speed beside Focus View; select 0.25× for four-times-slower journeys. Implementation and applicable verification complete. User authorized commit; push and deployment are out of scope. Native review did not close (expired consent); independent verification fallback passed.
