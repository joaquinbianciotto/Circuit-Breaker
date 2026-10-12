# Always-live request journeys

## Objective and scope
Remove the visible LIVE BACKEND ROLLING LEDGER widget and make live catch-up the sole visualization mode. Every new request must visibly start at REQUEST IN and traverse its observed route, including fast successes and concurrent batches. Preserve real HTTP timing, outcomes, backend rolling protection metrics, retry identity, reset fencing and reconnect safety. User explicitly authorized implementation and commit on feat/resilience-lab; no push or PR.

## Tasks
- [x] T1 (completed): Implement always-live complete journeys and remove visual ledger, with regression tests, aligned browser smoke and concise docs; independently verify, review under enabled RDD, and commit one coherent work unit.

## Acceptance and checks
- Each newly observed request starts at inlet before HTTP or rejection; completed batches cannot disappear before animation.
- No optional historical pause/speed/snapshot-jump mode can skip a journey; live observations remain authoritative.
- Retry and rejection routes remain honest; reset removes old-generation journeys only.
- Remove whole visible ledger widget and stale inspector copy, not backend statistics.
- Test-first deterministic model regressions: observed RED then GREEN, including same-frame/zero-latency success, ten-request batch, retry, rejection and reset.
- npm run test:frontend; npm run build; npm test.
- Browser smoke with existing Playwright installation: verify inlet, HTTP and terminal visibility for single/batch requests, Focus and reduced motion. Document unavailable environment honestly.
- Native review per current provider authority; no delivery claim from review alone.

## Evidence and progress
Exploration identified advance() draining due events, liveCatchUp() clearing queue, terminal-first signalRoute(), and completed-history truncation. Working tree initially clean. Backend changes out of scope. Human approved validation-only generated dist, tsbuildinfo, Vite cache and frontend .verification outputs, including tool-managed regeneration; no additional source or dependency edits authorized. Initial writer stopped before implementation to request this scope; resumed after approval.

Worker evidence: frontend 19 tests; full 79 Vitest + 3 Node tests; all workspace builds and isolated Playwright browser smoke passed; git diff --check passed. Test-first RED observed on 11 initial regressions, then GREEN. Independent verification reproduced frontend/full tests and builds but browser smoke failed on reduced-motion coordinate stability (HTTP marker x410 -> x800 after 100 ms); read-only diagnosis pending. Native review review-16c119e0922f2299 created for candidate sha256:40325fe73d6d01cb0dc2975348326f3cba157e1fd50e01527f3a7461ff89c247; capture blocked because review-reliability has no configured model. Fresh bound STATUS reoffers reviewer slot; no capture admission/approval/acknowledgement occurred. Preserve prior immutable review authority (no admitted results); authorized functional correction now delegated on live source. Verifier confirmed React initial origin versus RAF reduced endpoint race; fix initial circle/label/static trail state and identity-bound reduced HTTP/WAIT/retry assertions, plus two stale Send Batch guide labels. Revised candidate requires fresh inspect; never reuse prior snapshot authority. Documentation scope includes docs/scenarios.md to remove now-obsolete control/widget instructions without changing backend numeric expectations. Approximately 729 changed lines (implementation, deletions and coverage), still one coherent frontend behavior; no backend source changes. Docker/projector checks not performed. Sustained hidden-tab ingress may accumulate pending journeys.

## Commit and rollback
Behavior commit: 9147cdc9bd8f30c86967dccd5106d2e290cf5ce8 (`fix(frontend): show every live request journey from admission`). Roll back frontend journey/UI changes and corresponding tests/docs as one unit; backend protection unchanged.

## Latest correction and review decision
Reduced-motion correction observed seven failing initial-render regressions then GREEN: 27 frontend tests, 87 Vitest + 3 Node tests, four workspace builds, diff-check and isolated browser smoke passed in worker run. Independent rerun in progress. Fresh inspect identified revised candidate sha256:ec477ee949f62d348fb7d2b844394844fbcbf61fb9d744146ecbbcfb52d517b7; no revised START performed. Human explicitly selected commit with functional/independent checks and native review unavailable, without config changes or disabling RDD. ASSESS with unavailable returned unassessable/high-equivalent: writer verification plus independent verifier required.

## Next step
Independent corrected candidate verified: 27 frontend, 87 Vitest + 3 Node tests, four builds, diff-check and isolated browser smoke passed, zero browser errors, Focus geometry and mobile passed. Read-only production HTTP/fresh Chromium confirmed localhost:3000 serves LIVE / OBSERVED JOURNEYS with ledger and old controls absent; HTTP assets match container hashes, no controlling service worker. No deployment/restart/reset performed. User's existing tab remains inaccessible; hard reload/private window suggested, exact URL and screenshot needed if it persists. Initial browser reduced-motion failure corrected and independently rerun passing. Docker scenario mutation smoke and physical projector not performed. Native review unavailable by explicit human choice, not approved; old immutable lineage preserved without mutation. Behavior committed as 9147cdc9bd8f30c86967dccd5106d2e290cf5ce8; no push/PR.

No implementation work remains. Next human step: refresh current browser or provide exact URL/new screenshot if old widget persists.
