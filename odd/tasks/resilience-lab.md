# Resilience Lab

## Objective
Deliver a functional educational electrical instrument explaining real Circuit Breaker, Timeout and Retry behavior. Technical correctness precedes visual polish.

## Scope and constraints
- Exactly three Docker Compose services: React/TypeScript/Vite/Tailwind frontend, NestJS/TypeScript/Opossum backend, Node/Fastify external API.
- Backend performs real upstream HTTP. All state, events and histories are bounded and in memory; no database, Redis, broker or fourth service.
- Default policy: attempt timeout 800 ms; 2 additional retries; backoffs 200/400 ms; total deadline 3000 ms; inclusive 50% completed-operation failure threshold; minimum 4; rolling window 20 s; recovery 7 s.
- Opossum gates complete logical operations. Attempts do not count as separate breaker samples; rejected admissions are excluded. HALF_OPEN admits one non-retrying probe. AbortController covers full response consumption.
- Internal mechanism illustration, not container topology; identified SVG-path signals, physical contacts, timeout dial, retry WAIT/feedback, success/failure/rejection and recovery indicators.
- Separate authoritative SSE state and visual playback; snapshots, generations and replay support reconnect. Focus, inspection, keyboard access, reduced motion and responsive layout.
- English technical artifacts/UI; Spanish conversation.
- No Git staging, commits, push or PR without explicit user request. Feature branch: feat/resilience-lab; initial repository had no commits.

## Work units and routing
Initial authored-line forecast: 3000–4500, generated lockfile excluded. Full new application requires coherent behavior-oriented review slices, not artificial file-type splits. Delivery strategy: feature-branch-chain, explicitly selected by user for future review slices. Local staging/commits now authorized; push/PR/merge remain unauthorized.
- T1: gentle-ai-worker, real engine/contracts/upstream; mandatory multi-file write and evidence triggers.
- T2: gentle-ai-worker, electrical frontend/playback; mandatory multi-file write trigger.
- T3: gentle-ai-worker, deployment/docs/harness; mandatory multi-file write trigger. Parent resolved one small passive primary-citation gap inline.
- T4: independent gentle-ai-verify; bounded corrective writer for projection; second independent post-correction verifier. One writer at a time. Parent recorded final passive verification documentation inline.

## Tasks
- [x] T1 — Implement and test real resilience engine and event contracts. Status: done.
- [x] T2 — Implement event-driven electrical machine and educational controls. Status: done.
- [x] T3 — Package exactly three containers and document reproducible demonstrations. Status: done.
- [x] T4 — Verify complete Docker/browser flow; resolve acceptance failures. Status: done (functional verification complete; native review unavailable, not approved).
- [x] C1 — Prepare and verify a standalone technical-core snapshot, then create the root work-unit commit. Status: done (d20b81a; deadline edge now tracked separately in F1).
- [x] F1 — Fix the authorized deadline/backoff edge with deterministic regression and a corrective work-unit commit. Status: done (aa92d40; independent fix60/UI76/deploy79/engine33 passed).
- [x] C2 — Verify the accessible frontend snapshot and create its dependent work-unit commit. Status: done (add7b76; independent76/build/hash proof; native candidate review declined).
- [x] C3 — Verify and commit the full three-service deployment, docs and delivery record; confirm final tree/status. Status: done (4f4eb1e; independent79/build/hash proof; native candidate review declined).

## Implementation evidence
### T1 — Technical core
Shared ESM contracts; compiled Nest/Fastify entrypoints; completed-operation rolling ledger adapts Opossum's native strict > and fires denominator to requested inclusive completed semantics. Real Opossum owns admission, OPEN recovery and exclusive probe. Instance fencing prevents old CLOSED actions from closing/reopening a later probe.
Observed four initial RED behavior tests, then GREEN. Additional RED/GREEN regressions covered stalled 4xx bodies and Nest heartbeat IDs. 27 engine + 21 API/events/startup + 6 upstream tests passed. Builds passed; real local HTTP full-body cancellation and deadline cases covered.
Rollback boundary: technical workspaces, contracts, root workspace/TS/Vitest setup and docs/engine.md.

### T2 — Electrical machine
Graphite engineering instrument, SVG-path signals, guarded live/visual clocks, policy/upstream editors, real Auto Demo, timeline/trace history, inspection, Focus and accessibility.
Observed initial reducer RED, then GREEN; policy/stale-snapshot/offline regressions fixed. 16 frontend tests plus 54 core = 70 passing Vitest tests. Native real-browser HTTP/SSE/reconnect checks passed.
Patched Vitest to 5.0.3 and compatible esbuild to 0.28.2; final full and production npm audits have zero findings.
Rollback boundary: frontend and frontend scripts/dependencies/docs; preserve backend behavior.

### T3 — Deployment
Three health-gated services; only 127.0.0.1:3000 exposed. Nginx serves static frontend and unbuffered same-origin SSE; backend reaches external-api:3002 over Compose network. Node 22.22.2 nonroot service runtimes with production dependencies.
npm ci/build passed; 70 Vitest + 3 Node helper tests passed. Helper parser observed RED then GREEN for Compose 5.5.1 NDJSON. docker compose up --build -d --wait passed, three healthy containers. Ten real acceptance groups and Docker Chromium smoke passed.
Anatomy README, craft/motion guides and actual dial-indicator source were studied; verified primary URLs attached in architecture docs. No Anatomy code/artwork imported.
Rollback boundary: Compose, Dockerfiles/Nginx, acceptance scripts and deployment/docs; not core engine/UI.

### T4 — Independent verification and correction
Independent builds, 73 tests, audits 0/0, ten Docker groups and Chromium smoke passed. Four simultaneous distinct logical/attempt IDs followed paths. Reduced motion retained static markers without traveling trails.
Initial 1366×768 Focus annotations were too small. Observed RED at 12.59 px major text and an intermediate cropped failure annotation; final compact Focus GREEN: 1366 major >=16.94 px, annotations >=13.95 px, controls >=13 px; 1920 major >=26.94 px, annotations >=22.19 px. Zero checked clipping/collisions. Parent visually inspected corrected 1366 capture.
Final independent post-correction run reproduced 73/73 tests (zero failures/skips), 10/10 Docker acceptance groups and cache-disabled production browser smoke with zero unexpected errors. Focus/Escape/keyboard/reduced motion/mobile 390 px checks passed.
Final API reset confirmed CLOSED, idle, zero engine/upstream counters, empty histories/events/logs and all default policy/upstream settings.
Final three healthy container IDs unchanged throughout final scenarios: frontend 0c4b270e1261, backend 2922f3d91843, external-api 768bb496055d.

## Deployment incident and authorization
An earlier authorized frontend update without --no-deps recreated all three lab services and reset in-memory state. Parent paused writes and diagnosed the correct repository/current healthy stack read-only.
User explicitly approved docker compose up --build -d --wait --no-deps frontend. That subsequent deployment replaced only frontend and preserved backend/upstream IDs. No restart was used during the final acceptance scenarios. Do not claim uninterrupted continuity across the earlier deployment. Unrelated KUBO services were not mutated.

## Native review and Git delivery
RDD remained enabled. Initial inspect/START returned expired host consent with no lineage/mutation. After correction, fresh exact-scope inspect/START stopped at lens_context_budget_exceeded: complete immutable evidence exceeds the reviewer budget; no authority was created.
ASSESS was unassessable/unavailable and required the high-risk fallback: writer self-verification plus independent verification, both observed. No native receipt/approval, fictitious lineage STATUS, reset, recovery or switch change.
Native review remains unavailable for the complete initial candidate. Future review requires smaller coherent slices and applicable fresh consent. Do not retry this exact oversized candidate.
Implementation originally had no staging/commits/push. User subsequently requested local commits and chose feature-branch-chain. Core commit d20b81a138b65182d842da28142bc08a78a6a315 and corrective commit aa92d40cf8cd1d0ce6e9604f75f25fac48dabef3 created. UI commit add7b76899a3d559a1ddfe86b0f25e22a3fcb12b created, tree d189328c68c6eb1fd662f6cab2d983db0a56676b; 23changed paths +3499/-141 inclgeneratedlock. Deployment commit4f4eb1ef2aa79b89ddc47c9da8067b00872cabc0 created(treeb27a349f1c4ec9977f06e674f089475b49599c80),17changedpaths+956/-40. No push, PR or merge is authorized.

## Commit preparation and verification
Read-only scout mapped three coherent units: core/contracts/real upstream + tests, frontend/final Focus + tests, and Docker/acceptance/operator docs. Parent performs Git staging/commits; delegated writer prepares verified source-equivalent snapshots and stage-only metadata/docs under ignored .commit-preparation. Never use these scratch snapshots as native reviewer trees; native review remains provider-owned.
Writer prepared core26/UI45/deploy58 file snapshots, fresh npm ci/build/tests and full/prod audits0 for each. Core54,UI70,deploy70+3 tests passed; nativeUI and Dockerbrowser/10groups passed against unchanged code/runtime. Parent staged26core files via verified Gitblobs (treefe8d5f3edddb08758086c5c01dd2239eb8988995), no appsource rewrite.
Core commit: d20b81a138b65182d842da28142bc08a78a6a315, feat(engine): add real HTTP resilience core and event contracts;5488total added lines,3493generatedlock,1995authored.
Independent rerun: core54pass and deploy73pass, but UI69/70 deadline/backoff expectation failed during concurrent commands. New UI/deploy commits paused. Isolated UI reruns passed70/70, but observed attempts2-vs1 failure remains unresolved; engine clips backoff, waits once and admits retry when remaining budget is positive. Early timer wake is possible, not proven by traces. Do not erase initial failure or claim an environmental cause. User selected fix_then_commit: boundedengine/test/docs correction authorized before remaininglocalcommits. Worker stopped before edits for generated-output scope; user additionally approved only listed dist/TS/Vite outputs for required root validation. Source ownership remains engine.ts, engine.test.ts and docs/engine.md; no Docker lifecycle. Preservecreatedrootcommit; correctivefixgetsaseparateworkunit, noamend/historyrewrite. NoDockerlifecycle grant. Root native committed-only assessment requires explicit baseRef, but there is no parent commit; no invented empty-tree commit/ref or approval.
Each snapshot must support clean npm ci/build/focused tests. Core root metadata excludes absent frontend/deploy scripts; UI includes frontend but not absent Compose helper; deployment restores final metadata. Do not fabricate defective UI states or an empty initial commit. Ordinary source bytes remain unchanged except truthful README/delivery-record bookkeeping. No Docker recreation for this commit request; preserve the running lab.

## Coverage limits
- Chromium tested; no full browser/device matrix or comprehensive accessibility audit.
- Projector resolutions checked, not physical projector hardware.
- npm audits passed, but no image/OS security scan.
- Full-body stalled 200/422 cancellation passed with real local HTTP; no separate Docker stalled-body endpoint experiment.
These are disclosed limits, not failing required functional checks. Intermediate failures were corrected and final required checks pass.

## Relevant files
README.md; compose.yaml; apps/frontend; apps/backend; apps/external-api; packages/contracts; scripts/verify-compose.mjs; docs/architecture.md; docs/scenarios.md; docs/engine.md; docs/ui.md; docs/verification.md.
Ignored screenshots: apps/frontend/.verification/docker-{desktop,focus,projector-1366,projector-1920,reduced-motion,mobile}.png.

## Next step
F1 source/docs/snapshots completed: deterministic99.75ms-before100msREDthenGREEN,33engine tests,root79(full76Vitest+3Node)buildpass; core/fix60,UI76,deploy79 cleaninstall/build/tests/audits0/0 SEQUENTIALLY,LOCALUIbrowserpass. Exactoriginal69/70timertraceunproven; causalclassreproduced/fixed. Correctivecommit aa92d40cf8cd1d0ce6e9604f75f25fac48dabef3,4files+137/-16,standalonetree605c38e9a80a2c80781780e3aa0a3cea86b548cb verifiedblobs. NativefixSTARTdeclined_this_candidate(medium153lines),noauthority; ASSESSunassessable/highfallbackindependentsequentialchecks passed:fix60/UI76/deploy79/engine33,builds/generatecheck/154hashcomparisons,nonewfailures. CorrectedengineNOTdeployedtoDocker,current3servicespreserved. Parent resolved its artificial three-file packaging constraint: correction commit may include fourth stage-only core README count blob54→60 within already-authorized scratch; actual README source remains untouched. F1 closed withindependentproof; UIcommittedfromverified45-file snapshot; exactaa92d40→add7b76 nativeinspectmatchedtrees23paths,STARTriskmediumreviewdeclined_this_candidate,nolineage/noapproval; highfallbackself+independent76 fulfilled. Deployment4f4eb1econtains58intendedfinalfiles/currenttaskdoc;sourceblobintegritypassandGitstatusclean aftercommit. Exactadd7b76→4f4eb1e assessedmedium996lines/largewriter;reviewdeclined_this_candidate,nolineage/noapproval;writer+independent79/build proof stands. Functional source committed; Dockerstillrunsolderengine, no redeploy performed under Git-only request. Preservehistory/runningDocker/no push/PR/merge.

## Completed local delivery

| Unit | Commit | Verification |
| --- | --- | --- |
| Core root | d20b81a138b65182d842da28142bc08a78a6a315 | Standalone clean install/build/audits0; 54 tests; later deadline edge isolated and corrected below. |
| Deadline/backoff correction | aa92d40cf8cd1d0ce6e9604f75f25fac48dabef3 | Deterministic real-HTTP RED/GREEN; 33 engine and 60 standalone core tests; no weakened expectations. |
| Accessible electrical UI | add7b76899a3d559a1ddfe86b0f25e22a3fcb12b | Standalone 76 tests/build; native-local browser/Focus checks; independent source/hash proof. |
| Three-service deployment | 4f4eb1ef2aa79b89ddc47c9da8067b00872cabc0 | Final 76 Vitest + 3 Node tests, builds/audits0; independent verified final source. |

The passive closure-record commit follows these behavior commits and does not change application code. Its own identity is available in Git history and the session memory, avoiding a self-referential commit hash in this file.
Original parallel 69/70 failure remains historical evidence; the controlled early-wake class was reproduced and fixed, while its exact original timer trace was not captured. No current required source-test failure remains. Root commit had no parent for an invented committed-range baseline; correction/UI/deployment native consent was declined for each exact candidate. No native approval is claimed.
Source is complete; running Docker services were deliberately not recreated during this Git delivery, so rebuild before using the newly corrected engine. No push, PR, merge, rebase, amend or reset occurred. Future publication follows the chosen feature-branch-chain strategy and requires separate authorization.
