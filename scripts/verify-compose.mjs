// Built-in Node APIs only. Owns/reset ephemeral lab data, never restarts containers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { parseComposeContainers } from './compose-output.mjs';

const root = resolve(import.meta.dirname, '..');
const base = `http://${docker('compose', 'port', 'frontend', '80')}`;
const defaults = {
  attemptTimeoutMs: 800, retries: 2, backoffMs: 200, operationDeadlineMs: 3000,
  errorThresholdPercentage: 50, minimumVolume: 4, rollingWindowMs: 20000, recoveryMs: 7000,
};
const fast = {
  attemptTimeoutMs: 100, retries: 2, backoffMs: 15, operationDeadlineMs: 500,
  errorThresholdPercentage: 50, minimumVolume: 1000, rollingWindowMs: 20000, recoveryMs: 1200,
};
const checks = [];
function pass(label) { checks.push(label); console.log(`PASS ${label}`); }
function docker(...args) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 15000 }).trim();
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`${base}/api/${path}`, {
    method, signal: AbortSignal.timeout(15000),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, method === 'POST' ? 201 : 200,
    `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function until(read, predicate, label, timeout = 5000) {
  const deadline = performance.now() + timeout;
  let last;
  do {
    last = await read();
    if (predicate(last)) return last;
    await sleep(25);
  } while (performance.now() < deadline);
  throw new Error(`Deadline waiting for ${label}: ${JSON.stringify(last)}`);
}
const snapshot = () => api('snapshot');
const external = patch => api('external', 'PATCH', patch);
function dependency(patch) {
  // Change the real dependency through its public API, even while backend work is active.
  const result = JSON.parse(docker('compose', 'exec', '-T', 'external-api', 'node', '-e',
    `fetch('http://127.0.0.1:3002/config', {method:'PATCH', headers:{'content-type':'application/json'}, body:JSON.stringify(${JSON.stringify(patch)})}).then(async r => console.log(JSON.stringify({status:r.status, body:await r.json()})))`));
  assert.equal(result.status, 200);
  return result.body;
}
const request = async (count = 1) => (await api('requests', 'POST', { count })).results;
async function idle() {
  return until(snapshot, s => s.metrics.active === 0 && s.external?.metrics.active === 0, 'engine/upstream idle');
}
async function reset(policy = fast) {
  await idle();
  await api('reset', 'POST');
  await api('config', 'PATCH', policy);
}
async function observed(received, cancelled = 0) {
  return until(snapshot, s => s.external?.metrics.received === received &&
    s.external.metrics.cancelled >= cancelled && s.external.metrics.active === 0, 'fresh upstream metrics');
}

async function stream(headers = {}, query = '') {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('SSE stream deadline')), 120000);
  deadline.unref();
  const response = await fetch(`${base}/api/events${query}`, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.match(response.headers.get('cache-control'), /no-cache/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const frames = [];
  let failure;
  // Frames can span arbitrary HTTP chunks; comments never become replay IDs.
  const done = (async () => {
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const lines = buffer.slice(0, end).split('\n');
          buffer = buffer.slice(end + 2);
          const frame = { data: [] };
          for (const line of lines) {
            if (line.startsWith(':')) frame.comment = line.slice(1).trim();
            else {
              const colon = line.indexOf(':');
              if (colon < 0) continue;
              const key = line.slice(0, colon);
              const field = line.slice(colon + 1).replace(/^ /, '');
              if (key === 'data') frame.data.push(field);
              else if (key === 'id' || key === 'event') frame[key] = field;
            }
          }
          if (frame.data.length) frame.json = JSON.parse(frame.data.join('\n'));
          if (frame.json || frame.comment) frames.push(frame);
        }
      }
    } catch (error) { if (!controller.signal.aborted) failure = error; }
  })();
  return {
    frames,
    wait: (predicate, label, timeout = 5000) => until(() => {
      if (failure) throw failure;
      return frames;
    }, predicate, label, timeout),
    close: async () => { clearTimeout(deadline); controller.abort(); await done; },
  };
}

const services = docker('compose', 'config', '--services').split('\n').sort();
assert.deepEqual(services, ['backend', 'external-api', 'frontend']);
const containers = parseComposeContainers(docker('compose', 'ps', '--format', 'json'));
assert.equal(containers.length, 3);
for (const container of containers) {
  assert.equal(container.State, 'running');
  assert.equal(container.Health, 'healthy');
  const ports = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container.ID));
  const published = Object.entries(ports ?? {}).filter(([, bindings]) => bindings?.length);
  if (container.Service === 'frontend') {
    assert.deepEqual(published, [['80/tcp', [{ HostIp: '127.0.0.1', HostPort: new URL(base).port }]]]);
  } else {
    assert.deepEqual(published, []);
    assert.equal(docker('inspect', '--format', '{{.Config.User}}', container.ID), 'node');
    assert.equal(docker('compose', 'exec', '-T', container.Service, 'node', '-p', 'process.version'), 'v22.22.2');
    assert.equal(docker('compose', 'exec', '-T', container.Service, 'node', '-p',
      "require('@resilience/contracts').DEFAULT_POLICY.attemptTimeoutMs"), '800');
    docker('compose', 'exec', '-T', container.Service, 'node', '-e',
      "for(const p of ['typescript','vite','vitest','esbuild']){try{require.resolve(p)}catch{continue}throw Error('Build dependency in runtime: '+p)}");
  }
  console.log(`${container.Service}: ${container.ID} ${container.Name} ${container.Health}`);
}
pass('Exactly three healthy production containers; only localhost frontend published; Node/ESM contracts resolve.');
assert.match(await (await fetch(base, { signal: AbortSignal.timeout(5000) })).text(), /<div id="root">/);
assert.equal((await api('health')).ok, true);

let live;
let restored = false;
try {
  await reset();
  live = await stream();
  await live.wait(frames => frames.some(f => f.event === 'snapshot' && f.json.reason === 'initial'), 'SSE handshake');
  const initial = live.frames.find(f => f.event === 'snapshot').json.snapshot;
  const [normal] = await request();
  assert.equal(normal.outcome, 'success');
  assert.equal(normal.attempts, 1);
  const normalSnapshot = await observed(1);
  const normalLog = normalSnapshot.external.metrics.logs[0];
  assert.equal(normalLog.requestId, normal.requestId);
  assert.equal(normalLog.attemptId, normalSnapshot.histories[0].attempts[0].attemptId);
  await live.wait(frames => frames.some(f => f.json?.type === 'REQUEST_FINISHED' && f.json.requestId === normal.requestId), 'correlated SSE completion');
  const operationFrames = live.frames.filter(f => f.event === 'engine' && f.json.requestId === normal.requestId);
  assert.deepEqual(operationFrames.map(f => f.json.type), ['REQUEST_STARTED', 'ATTEMPT_STARTED', 'ATTEMPT_SUCCEEDED', 'REQUEST_FINISHED']);
  for (const frame of operationFrames) {
    assert.equal(frame.id, frame.json.id);
    assert.equal(frame.id, `${frame.json.epoch}:${frame.json.sequence}`);
  }
  pass('Normal: one real attempt, correlated upstream receipt and live SSE execution through nginx.');

  await reset();
  await external({ mode: 'slow', latencyMs: 1000 });
  const pendingSlow = request();
  const activeSlow = await until(snapshot, s => s.metrics.active === 1 &&
    s.histories.some(h => h.attempts.some(a => a.finishedAt === undefined)), 'actual active timeout clock');
  const activeHistory = activeSlow.histories.find(h => h.finishedAt === undefined);
  assert.equal(activeHistory.deadlineAt, activeHistory.startedAt + fast.operationDeadlineMs);
  assert(activeHistory.attempts[0].startedAt <= activeSlow.serverTime);
  const [slow] = await pendingSlow;
  assert.equal(slow.outcome, 'failure');
  assert.equal(slow.attempts, 3);
  assert(slow.durationMs <= fast.operationDeadlineMs, `Slow duration ${slow.durationMs} exceeds budget`);
  const slowSnapshot = await observed(3, 3);
  assert.equal(slowSnapshot.metrics.completed, 1);
  assert.equal(slowSnapshot.external.metrics.completed, 0);
  assert.equal(slowSnapshot.events.filter(e => e.type === 'ATTEMPT_TIMEOUT').length, 3);
  for (const attempt of slowSnapshot.histories[0].attempts) {
    assert.equal(attempt.outcome, 'timeout');
    assert(attempt.finishedAt - attempt.startedAt <= fast.attemptTimeoutMs + 50);
  }
  pass('Slow: three body-inclusive timeouts within operation budget; actual upstream cancellation.');

  await reset();
  await external({ mode: 'fail', errorStatus: 503 });
  const [failed] = await request();
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.attempts, 3);
  const failSnapshot = await observed(3);
  assert.equal(failSnapshot.metrics.completed, 1);
  assert.deepEqual(failSnapshot.events.filter(e => e.type === 'RETRY_SCHEDULED').map(e => e.backoffMs), [15, 30]);
  await reset();
  await external({ mode: 'fail', errorStatus: 422 });
  const [clientError] = await request();
  assert.equal(clientError.outcome, 'failure');
  assert.equal(clientError.attempts, 1);
  assert(!(await observed(1)).events.some(e => e.type.startsWith('RETRY_')));
  pass('503 retries bounded at three attempts; ordinary 422 has one attempt and no retry.');

  await reset();
  await external({ mode: 'intermittent', intermittent: 'alternating' });
  const [intermittent] = await request();
  assert.equal(intermittent.outcome, 'success');
  assert.equal(intermittent.attempts, 2);
  const alternating = await observed(2);
  assert.equal(alternating.metrics.completed, 1);
  assert.equal(new Set(alternating.external.metrics.logs.map(log => log.requestId)).size, 1);
  pass('Intermittent: two real attempts, one successful logical breaker sample.');

  const nativeFailures = [];
  async function nativeCase(label, check) {
    try { await check(); pass(label); }
    catch (error) {
      nativeFailures.push(error);
      console.error(`FAIL ${label}: ${error.message}`);
    }
  }
  const nativePolicy = { ...fast, retries: 0, attemptTimeoutMs: 1000, operationDeadlineMs: 1500, minimumVolume: 4 };

  await nativeCase('Native threshold: exactly 50% stays CLOSED; the next failure opens above 50%.', async () => {
    await reset(nativePolicy);
    await external({ mode: 'fail', errorStatus: 503 });
    for (let i = 0; i < 2; i++) assert.equal((await request())[0].outcome, 'failure');
    assert.equal((await snapshot()).state, 'CLOSED');
    await external({ mode: 'normal' });
    for (let i = 0; i < 2; i++) assert.equal((await request())[0].outcome, 'success');
    const boundary = await observed(4);
    assert.equal(boundary.state, 'CLOSED', 'Exactly 50% must not open a native >50% breaker');
    assert.equal(boundary.metrics.rollingCalls, 4);
    assert.equal(boundary.metrics.rollingCompleted, 4);
    assert.equal(boundary.metrics.rollingFailed, 2);
    assert.equal(boundary.metrics.errorPercentage, 50);
    await external({ mode: 'fail' });
    const [failure] = await request();
    assert.equal(failure.outcome, 'failure');
    const opened = await observed(5);
    assert.equal(opened.state, 'OPEN');
    assert.equal(opened.metrics.completed, 5);
    assert.equal(opened.metrics.failed, 3);
    assert.equal(opened.recoveryAt, opened.openedAt + opened.policy.recoveryMs);
    assert(opened.events.some(event => event.type === 'CIRCUIT_OPENED' &&
      event.requestId === failure.requestId && event.reason === 'error-threshold'));
  });

  await nativeCase('Native upper boundary: a configured 100% threshold does not open at exactly 100%.', async () => {
    await reset({ ...nativePolicy, errorThresholdPercentage: 100 });
    await external({ mode: 'fail' });
    for (let i = 0; i < 4; i++) assert.equal((await request())[0].outcome, 'failure');
    const current = await observed(4);
    assert.equal(current.state, 'CLOSED');
    assert.equal(current.metrics.rollingCalls, 4);
    assert.equal(current.metrics.rollingFailed, 4);
    assert.equal(current.metrics.errorPercentage, 100);
  });

  await nativeCase('Native calls include pending actions; returned active histories remain immutable.', async () => {
    await reset({ ...nativePolicy, minimumVolume: 1000 });
    await external({ mode: 'normal', latencyMs: 350 });
    const pending = request(2);
    try {
      const active = await until(snapshot, s => s.metrics.active === 2 &&
        s.external?.metrics.active === 2, 'two real pending HTTP actions');
      assert.equal(active.metrics.rollingCalls, 2);
      assert.equal(active.metrics.rollingCompleted, 0);
      assert.equal(active.metrics.rollingFailed, 0);
      assert.equal(active.metrics.errorPercentage, 0);
      assert(active.histories.every(history => history.outcome === undefined && history.attempts.length === 1));
      const results = await pending;
      assert(results.every(result => result.outcome === 'success' && result.attempts === 1));
      const complete = await observed(2);
      assert.equal(complete.metrics.rollingCalls, 2);
      assert.equal(complete.metrics.rollingCompleted, 2);
      assert(active.histories.every(history => history.outcome === undefined));
    } finally { await pending; }
  });

  await nativeCase('Native calls include OPEN rejections without sending any upstream HTTP.', async () => {
    await reset(nativePolicy);
    await external({ mode: 'fail' });
    for (let i = 0; i < 4; i++) assert.equal((await request())[0].outcome, 'failure');
    const before = await observed(4);
    assert.equal(before.state, 'OPEN');
    const rejected = await request(3);
    assert(rejected.every(result => result.outcome === 'rejected' && result.attempts === 0));
    const after = await observed(4);
    assert.equal(after.state, 'OPEN');
    assert.equal(after.metrics.rollingCalls, before.metrics.rollingCalls + 3);
    assert.equal(after.metrics.rollingCompleted, before.metrics.rollingCompleted);
    assert.equal(after.metrics.rollingFailed, before.metrics.rollingFailed);
    assert.equal(after.metrics.completed, 4);
    assert.equal(after.metrics.failed, 4);
    assert.equal(after.metrics.rejected, 3);
  });

  await nativeCase('Native sampling counts one fire for a logical operation that retries successfully.', async () => {
    await reset();
    await external({ mode: 'intermittent', intermittent: 'alternating' });
    const [result] = await request();
    assert.equal(result.outcome, 'success');
    assert.equal(result.attempts, 2);
    const current = await observed(2);
    assert.equal(current.metrics.rollingCalls, 1);
    assert.equal(current.metrics.rollingCompleted, 1);
    assert.equal(current.metrics.rollingFailed, 0);
    assert.equal(current.metrics.errorPercentage, 0);
  });
  if (nativeFailures.length) throw new AggregateError(nativeFailures, 'Native Opossum acceptance failed');

  async function probeCase(mode, expected) {
    await reset({ ...fast, attemptTimeoutMs: 400, operationDeadlineMs: 1500, minimumVolume: 4 });
    await external({ mode: 'fail', latencyMs: 0 });
    for (let i = 0; i < 4; i++) await request();
    const before = await observed(12);
    assert.equal(before.state, 'OPEN');
    await external({ mode, latencyMs: 200 });
    const half = await until(snapshot, s => s.state === 'HALF_OPEN', 'actual HALF_OPEN', 4000);
    assert(half.serverTime >= before.recoveryAt - 5);
    assert(half.events.some(e => e.type === 'CIRCUIT_HALF_OPEN' && e.timestamp >= before.recoveryAt - 5));
    const results = await request(4);
    assert.equal(results.filter(r => r.outcome === 'rejected').length, 3);
    const admitted = results.find(r => r.outcome !== 'rejected');
    assert.equal(admitted.outcome, mode === 'normal' ? 'success' : 'failure');
    assert.equal(admitted.attempts, 1);
    const after = await observed(13);
    assert.equal(after.state, expected);
    const history = after.histories.find(h => h.requestId === admitted.requestId);
    assert.equal(history.probe, true);
    assert(!after.events.some(e => e.requestId === admitted.requestId && e.type.startsWith('RETRY_')));
    if (expected === 'CLOSED') assert.equal(after.metrics.rollingCompleted, 1);
    else assert(after.recoveryAt > before.recoveryAt);
  }
  await probeCase('normal', 'CLOSED');
  await probeCase('fail', 'OPEN');
  pass('Recovery timer is authoritative; HALF_OPEN admits one probe/no retries and closes or reopens on its real result.');

  for (const oldMode of ['normal', 'fail']) {
    await reset({ ...nativePolicy, errorThresholdPercentage: 1, minimumVolume: 1,
      attemptTimeoutMs: 3000, operationDeadlineMs: 5000, recoveryMs: 250 });
    await external({ mode: oldMode, latencyMs: 1800 });
    const old = request();
    let probe;
    try {
      await until(snapshot, s => s.external?.metrics.received === 1 && s.metrics.active === 1, 'old action in flight');
      dependency({ mode: 'fail', latencyMs: 0 });
      assert.equal((await request())[0].outcome, 'failure');
      assert.equal((await snapshot()).state, 'OPEN');
      await until(snapshot, s => s.state === 'HALF_OPEN', 'isolated recovery gate');
      dependency({ mode: 'normal', latencyMs: 2400 });
      probe = request();
      await until(snapshot, s => s.histories.some(h => h.probe && h.finishedAt === undefined), 'pending recovery probe');
      const [oldResult] = await old;
      assert.equal(oldResult.outcome, oldMode === 'normal' ? 'success' : 'failure');
      assert.equal((await snapshot()).state, 'HALF_OPEN');
      assert.equal((await request())[0].outcome, 'rejected');
      const during = await until(snapshot, s => s.external?.metrics.received === 3 &&
        s.external.metrics.active === 1 && s.metrics.active === 1, 'old result settled while probe remains pending');
      assert.equal(during.state, 'HALF_OPEN');
      assert.equal(during.metrics.rollingCalls, 2);
      assert.equal(during.metrics.rollingCompleted, 0);
      const [recovery] = await probe;
      assert.equal(recovery.outcome, 'success');
      assert.equal(recovery.attempts, 1);
      const closed = await observed(3);
      assert.equal(closed.state, 'CLOSED');
      assert.equal(closed.metrics.completed, 3);
      assert.equal(closed.metrics.rollingCalls, 2);
      assert.equal(closed.metrics.rollingCompleted, 1);
      assert.equal(closed.events.filter(event => event.type === 'CIRCUIT_CLOSED' && event.reason === 'probe-succeeded').length, 1);
    } finally { await Promise.allSettled([old, probe].filter(Boolean)); }
    pass(`Late old ${oldMode === 'normal' ? 'success' : 'failure'} cannot close/reopen a newer pending probe or enter its native statistics.`);
  }

  await reset();
  const cursor = (await snapshot()).cursor;
  const [replayResult] = await request();
  const expectedEvents = (await snapshot()).events.filter(e => e.requestId === replayResult.requestId);
  const replay = await stream({ 'Last-Event-ID': cursor }, '?cursor=invalid');
  try {
    await replay.wait(frames => frames.filter(f => f.event === 'engine').length === expectedEvents.length, 'Last-Event-ID replay');
    assert.deepEqual(replay.frames.filter(f => f.event === 'engine').map(f => f.id), expectedEvents.map(e => e.id));
    assert(!replay.frames.some(f => f.event === 'snapshot'));
    const [next] = await request();
    await replay.wait(frames => frames.some(f => f.json?.type === 'REQUEST_FINISHED' && f.json.requestId === next.requestId), 'replay joins live stream');
    const ids = replay.frames.filter(f => f.event === 'engine').map(f => f.id);
    assert.equal(ids.length, new Set(ids).size);
  } finally { await replay.close(); }
  pass('Last-Event-ID survives nginx, takes precedence over query cursor, replays strictly after cursor without duplicates then streams live.');

  const oldCursor = (await snapshot()).cursor;
  await reset();
  const generation = await stream({ 'Last-Event-ID': oldCursor });
  try {
    await generation.wait(frames => frames.some(f => f.json?.reason === 'generation'), 'generation snapshot');
    assert.equal(generation.frames[0].json.snapshot.histories.length, 0);
  } finally { await generation.close(); }
  const expiredCursor = (await snapshot()).cursor;
  for (let batch = 0; batch < 26; batch++) await request(10);
  assert.equal((await snapshot()).events.length, 1000);
  const expired = await stream({ 'Last-Event-ID': expiredCursor });
  try {
    await expired.wait(frames => frames.some(f => f.json?.reason === 'expired'), 'expired snapshot');
    assert.equal(expired.frames[0].json.snapshot.events.length, 1000);
    assert(!expired.frames.some(f => f.event === 'engine'));
  } finally { await expired.close(); }
  pass('Reset generation and expired bounded replay cursor produce authoritative snapshots, not incomplete tails.');
  await live.wait(frames => frames.some(f => f.comment?.startsWith('heartbeat')), 'unbuffered heartbeat', 17000);
  for (const frame of live.frames.filter(f => f.comment)) {
    assert.equal(frame.id, undefined);
    assert.equal(frame.json, undefined);
  }
  pass('Unbuffered heartbeat comments arrive without data or IDs; real countdowns never invent transitions.');
} finally {
  if (live) await live.close();
  await idle();
  const final = await api('reset', 'POST');
  assert.deepEqual(final.policy, defaults);
  assert.equal(final.state, 'CLOSED');
  assert.equal(final.metrics.completed, 0);
  assert.equal(final.external.config.mode, 'normal');
  restored = true;
}
assert(restored);
console.log(`Completed ${checks.length} acceptance groups; default policy/upstream restored; containers left running.`);
