# Four real demonstrations

Open **http://localhost:3000** after `docker compose up --build`. Wait for **ENGINE CONNECTED**. These walkthroughs use default policy and real HTTP; **do not restart containers** between scenarios.

## Presenter setup

- Begin every baseline with **Reset Simulation**, wait for completion, then **Live catch-up**. Defaults: CLOSED, no histories, zero counters, 800 ms timeout, 2 extra retries, 200/400 ms waits, 3000 ms deadline, ≥50% at 4 completed operations, 20 s window, 7 s recovery.
- Choose **0.25× playback** for an explained replay. Real 800 ms timeouts remain 800 ms; diagram lag/historical labels disclose the delay. Use Live catch-up before comparing contacts to the live gate.
- Configure the scenario in the dock first. **Focus View** enlarges the plate for projection and keeps Send Request / Send Batch / Playback controls; Escape exits. Tab to controls/components; Enter inspects components without HTTP. Focus can be toggled between sends without changing the engine.
- Read the live completed-operation meter and expand logical history for attempt IDs/durations. Do not count visual pulses as independent requests. Management is held while work is active; wait for the completed notice before resetting/configuring.

## 1. Normal — the gate conducts

1. Reset baseline, select **Normal Response** (260 ms / 200).
2. Click **Send Request** once; wait for completion.
3. Follow inlet → touching CLOSED contacts → HTTP winding → green success terminal.

**Expect:** 1 logical success, 1 attempt, 1 upstream receipt/completion, no retries/cancellations; rolling failure meter **0 / 1 = 0%**, still CLOSED. Actual duration is approximately 260 ms plus transport overhead, not an artificial fixed animation duration.

## 2. Slow — timeout aborts real HTTP

1. Reset baseline, select **Slow Response** (1500 ms).
2. Optionally select 0.25×, then click **Send Request** once and wait for real completion.
3. Inspect timeout dial, amber WAIT and feedback loop returning to HTTP within the same request.

**Expect:** 1 logical failure, up to 3 timed-out attempts under the 3000 ms total deadline, actual upstream cancellation, waits 200/400 ms. With the default local latency each attempt times out; the third may have slightly less than 800 ms because the deadline includes overhead. Meter **1 / 1 = 100%**, but minimum volume 4 is unmet, so CLOSED. Quarter-speed drawing can still be replaying after the request has finished. Never describe its virtual countdown as extending the real timeout.

## 3. 503 — trip, reject, recover

1. Reset baseline, select **Always Fail** (220 ms / 503). Keep batch count **4**.
2. Click **Send Multiple Requests** once; wait for all four to finish. Each logical failure uses 3 attempts and the 200/400 ms waits, about 1260 ms plus overhead.
3. Observe **OPEN**, meter **4 / 4 = 100%** and 12 upstream receipts. Immediately click **Send Request**: it rejects with **0 attempts**; upstream receipts stay 12.
4. Click **Recover Service** (normal 260 ms); this does **not** close the gate. Wait for the actual **LIVE GATE HALF_OPEN**, about 7 s after opening. Zero on the countdown alone is not admission authority.
5. Click **Send Multiple Requests** once. The probe makes 1 successful attempt; the other 3 callers reject. The gate closes. Successful probe becomes the first sample in the new rolling baseline: **0 / 1 = 0%**.

**Counts after step 5:** 5 completed logical operations (4 failed + 1 successful), 4 rejected admissions (1 OPEN + 3 concurrent), **13 upstream receipts**. An OPEN rejection does not extend the recovery wait. History and upstream receipts—not animation timing—prove the probe exclusivity.

**Failure variant:** start step 1 from another reset baseline and leave Always Fail selected. After the four failures and the actual HALF_OPEN event, send the batch of 4 **without Recover Service**. One probe fails after one 503 attempt despite retries being configured; three arrivals reject, receipt count rises only 12 → 13, and a new 7 s OPEN wait begins. Then Recover Service, wait for HALF_OPEN again, and send one request to close. No policy change or container restart is needed.

## 4. Intermittent — retry is not another operation

1. Reset baseline so alternating starts from its first failure.
2. Select **Intermittent Failure** (240 ms, alternating). Select 0.25× to inspect WAIT.
3. Click **Send Request** once, then expand that history.

**Expect:** attempt A1 fails 503, a 200 ms wait, attempt A2 succeeds; approximately **680 ms** plus overhead. Two real upstream receipts share one request ID and have different attempt IDs. Exactly **1 logical success**, zero logical failures, meter **0 / 1 = 0%**, CLOSED. Do not use concurrent batches for this baseline: callers share the alternating sequence.

## Guided alternative

**Start Auto Demo** resets and runs normal → slow → reset → four sequential 503 failures → OPEN rejection → actual HALF_OPEN → recovered single probe → alternating retry. Stop prevents future sends; admitted work still settles. At default durations allow roughly 20–30 s, plus playback lag. [UI guide](ui.md) explains inspection, pause and reconnect; [Node acceptance harness](verification.md) additionally proves the exact inclusive **2 failures + 2 successes = 50%** boundary with a fast test policy.
