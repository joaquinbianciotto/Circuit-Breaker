import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { DEFAULT_POLICY, ValidationError, type Policy } from '@resilience/contracts';
import { createExternalApi } from '../../external-api/src/server';
import { ConflictError, Engine, ProxyError } from '../src/engine';
import Fastify from 'fastify';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const policy: Policy = {
  ...DEFAULT_POLICY, attemptTimeoutMs: 100, retries: 2, backoffMs: 25,
  operationDeadlineMs: 600, minimumVolume: 4, rollingWindowMs: 2000, recoveryMs: 150,
};
let upstream: ReturnType<typeof createExternalApi>;
let engine: Engine;
let url: string;
async function configure(data: unknown) {
  const response = await fetch(`${url}/config`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  expect(response.status).toBe(200);
}
async function metrics() { return (await fetch(`${url}/metrics`)).json(); }
async function until(check: () => boolean | Promise<boolean>, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await sleep(5);
  }
}
function replacePolicy(patch: Partial<Policy>) {
  engine.shutdown();
  engine = new Engine(url, { ...policy, ...patch });
}
beforeEach(async () => {
  upstream = createExternalApi();
  url = await upstream.listen({ port: 0, host: '127.0.0.1' });
  engine = new Engine(url, policy);
});
afterEach(async () => { engine.shutdown(); await upstream.close(); });

describe('real HTTP logical operations', () => {
  it('performs correlated HTTP and completes one logical success', async () => {
    const result = await engine.run();
    expect(result.outcome).toBe('success');
    expect(result.attempts).toBe(1);
    const stats = await metrics();
    expect(stats.received).toBe(1);
    expect(stats.completed).toBe(1);
    expect(stats.logs[0].requestId).toBe(result.requestId);
    expect(stats.logs[0].attemptId).toBeTruthy();
  });
  it('retries 5xx exactly twice with two real backoffs', async () => {
    await configure({ mode: 'fail' });
    const start = Date.now();
    const result = await engine.run();
    expect(result.outcome).toBe('failure');
    expect(result.attempts).toBe(3);
    expect(Date.now() - start).toBeGreaterThanOrEqual(70);
    expect((await metrics()).received).toBe(3);
  });
  it('ordinary 4xx fails without retry', async () => {
    await configure({ mode: 'fail', errorStatus: 422 });
    const result = await engine.run();
    expect(result.outcome).toBe('failure');
    expect(result.attempts).toBe(1);
    expect((await metrics()).received).toBe(1);
  });
  it('aborts every timed-out delayed upstream request', async () => {
    await configure({ latencyMs: 1000 });
    const result = await engine.run();
    expect(result.outcome).toBe('failure');
    expect(result.attempts).toBe(3);
    await sleep(40);
    const stats = await metrics();
    expect(stats.cancelled).toBe(3);
    expect(stats.completed).toBe(0);
    expect(stats.active).toBe(0);
  });
  it('alternating intermittent failures reproducibly recover on the retry', async () => {
    await configure({ mode: 'intermittent' });
    expect((await engine.run()).outcome).toBe('success');
    expect((await engine.run()).outcome).toBe('success');
    expect((await metrics()).logs.map((log: { status: number }) => log.status)).toEqual([503, 200, 503, 200]);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 2, failed: 0, rollingCompleted: 2 });
  });
  it('counts one logical failure rather than three attempt samples', async () => {
    await configure({ mode: 'fail' });
    await engine.run();
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, failed: 1, rollingCompleted: 1, rollingFailed: 1 });
    expect(engine.state).toBe('CLOSED');
    const events = engine.snapshot().events;
    expect(events.filter(event => event.type === 'RETRY_SCHEDULED').map(event => event.backoffMs)).toEqual([25, 50]);
    expect(events.filter(event => event.type === 'ATTEMPT_FAILED')).toHaveLength(3);
  });
  it('creates fresh controllers after timeout and clears successful attempt timers', async () => {
    await configure({ latencyMs: 500 });
    const pending = engine.run();
    await until(async () => (await metrics()).received === 1);
    await configure({ latencyMs: 0 });
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'success', attempts: 2 });
    await sleep(120);
    const stats = await metrics();
    expect(stats).toMatchObject({ received: 2, cancelled: 1, completed: 1, active: 0 });
    expect(new Set(stats.logs.map((log: { attemptId: string }) => log.attemptId)).size).toBe(2);
    expect(engine.snapshot().events.filter(event => event.type === 'ATTEMPT_TIMEOUT')).toHaveLength(1);
  });
  it('clamps a later attempt after timeout plus backoff used the shared budget', async () => {
    replacePolicy({ attemptTimeoutMs: 80, backoffMs: 20, operationDeadlineMs: 140 });
    await configure({ latencyMs: 1000 });
    const result = await engine.run();
    expect(result).toMatchObject({ outcome: 'failure', attempts: 2, reason: 'operation-deadline' });
    expect(result.durationMs).toBeGreaterThanOrEqual(135);
    expect(result.durationMs).toBeLessThan(350);
    await until(async () => (await metrics()).cancelled === 2);
  });
  it('retries genuine network failure with a bounded deadline', async () => {
    const port = (upstream.server.address() as { port: number }).port;
    await upstream.close();
    engine.shutdown();
    engine = new Engine(`http://127.0.0.1:${port}`, policy);
    const result = await engine.run();
    expect(result.outcome).toBe('failure');
    expect(result.attempts).toBe(3);
    expect(engine.snapshot().events.filter(event => event.type === 'ATTEMPT_FAILED')).toHaveLength(3);
  });
  it('clamps the timeout to the total operation deadline', async () => {
    replacePolicy({ attemptTimeoutMs: 1000, operationDeadlineMs: 80 });
    await configure({ latencyMs: 1000 });
    const result = await engine.run();
    expect(result.attempts).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(75);
    expect(result.durationMs).toBeLessThan(300);
    expect(result.reason).toBe('operation-deadline');
    await until(async () => (await metrics()).cancelled === 1);
  });
  it('does not start an extra attempt after the deadline expires during backoff', async () => {
    replacePolicy({ backoffMs: 200, operationDeadlineMs: 80 });
    await configure({ mode: 'fail' });
    const result = await engine.run();
    expect(result.attempts).toBe(1);
    expect(result.reason).toBe('operation-deadline');
    expect((await metrics()).received).toBe(1);
    expect(engine.snapshot().events.some(event => event.type === 'RETRY_STARTED')).toBe(false);
  });
  it.each([200, 422])('aborts unfinished HTTP %s bodies and never retries known 4xx', async status => {
    const streaming = Fastify({ forceCloseConnections: true });
    let cancelled = 0;
    let bodyTimer: NodeJS.Timeout | undefined;
    streaming.get('/work', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(status, { 'content-type': 'application/json' });
      reply.raw.write('{');
      bodyTimer = setTimeout(() => reply.raw.end('}'), 1000);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) { cancelled++; clearTimeout(bodyTimer); }
      });
    });
    const streamingUrl = await streaming.listen({ port: 0, host: '127.0.0.1' });
    engine.shutdown();
    engine = new Engine(streamingUrl, { ...policy, retries: status === 422 ? 2 : 0 });
    try {
      const result = await engine.run();
      expect(result.outcome).toBe('failure');
      expect(result.attempts).toBe(1);
      expect(engine.snapshot().events.find(event => event.type === 'ATTEMPT_TIMEOUT')?.status).toBe(status);
      await until(() => cancelled === 1);
    } finally { clearTimeout(bodyTimer); await streaming.close(); }
  });
});

describe('controlled monotonic backoff with real HTTP', () => {
  const realSetTimeout = setTimeout;
  let now: number;
  let captureWait: boolean;
  let firstFailureAt: number;
  let waits: { delay: number; timer: NodeJS.Timeout; wake: (at: number) => void }[];
  beforeEach(async () => {
    replacePolicy({ retries: 1, backoffMs: 25, operationDeadlineMs: 100 });
    await configure({ mode: 'fail' });
    now = 0;
    firstFailureAt = 20.25;
    captureWait = false;
    waits = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const publish = engine.journal.publish.bind(engine.journal);
    vi.spyOn(engine.journal, 'publish').mockImplementation(event => {
      if (event.type === 'ATTEMPT_FAILED' && event.index === 1) now = firstFailureAt;
      if (event.type === 'RETRY_SCHEDULED') captureWait = true;
      if (event.type === 'RETRY_STARTED') captureWait = false;
      return publish(event);
    });
    vi.spyOn(globalThis, 'clearTimeout');
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay: number) => {
      if (!captureWait || delay > 200) return realSetTimeout(callback, delay);
      const timer = realSetTimeout(() => {}, 60000);
      waits.push({ delay, timer, wake: at => { now = at; clearTimeout(timer); callback(); } });
      return timer;
    }) as typeof setTimeout);
  });
  afterEach(() => { engine.shutdown(); vi.restoreAllMocks(); });
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => realSetTimeout(resolve, 5));
    expect(check(), JSON.stringify(engine.snapshot().events)).toBe(true);
  }
  it('fractional truncated backoff never admits an early HTTP retry', async () => {
    engine.configure({ backoffMs: 200 });
    const pending = engine.run();
    await waitFor(() => waits.length === 1);
    expect(waits[0].delay).toBe(80);
    waits[0].wake(99.75); // Deliberately wake before the clipped monotonic deadline.
    await waitFor(() => waits.length === 2 || engine.snapshot().metrics.completed === 1);
    expect(engine.snapshot().events.filter(e => e.type === 'RETRY_STARTED')).toHaveLength(0);
    expect(engine.snapshot().events.filter(e => e.type === 'ATTEMPT_STARTED')).toHaveLength(1);
    expect(engine.snapshot().metrics.completed).toBe(0);
    waits[1].wake(100);
    expect(await pending).toMatchObject({ outcome: 'failure', attempts: 1, reason: 'operation-deadline' });
    captureWait = false;
    expect((await metrics()).received).toBe(1);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, failed: 1, rollingCompleted: 1, rollingFailed: 1 });
    expect(engine.snapshot().events.filter(e => e.type === 'REQUEST_FINISHED')).toHaveLength(1);
    for (const wait of waits) expect(clearTimeout).toHaveBeenCalledWith(wait.timer);
  });
  it.each([
    { name: 'full', backoffMs: 25, failedAt: 20.25, early: 44.75, wakeAt: 45.25, attempts: 2 },
    { name: 'equal', backoffMs: 25, failedAt: 75, early: 99.75, wakeAt: 100, attempts: 1 },
    { name: 'zero', backoffMs: 0, failedAt: 20.25, early: null, wakeAt: 20.25, attempts: 2 },
  ])('$name backoff honors its full wait and remaining operation budget', async scenario => {
    engine.configure({ backoffMs: scenario.backoffMs });
    firstFailureAt = scenario.failedAt;
    const pending = engine.run();
    await waitFor(() => waits.length === 1);
    expect(waits[0].delay).toBe(scenario.backoffMs);
    if (scenario.early !== null) {
      waits[0].wake(scenario.early);
      await waitFor(() => waits.length === 2);
      expect(engine.snapshot().events.filter(e => e.type === 'RETRY_STARTED')).toHaveLength(0);
      expect(engine.snapshot().events.filter(e => e.type === 'ATTEMPT_STARTED')).toHaveLength(1);
      expect(engine.snapshot().metrics.completed).toBe(0);
    }
    waits.at(-1)!.wake(scenario.wakeAt);
    const result = await pending;
    expect(result).toMatchObject({ outcome: 'failure', attempts: scenario.attempts,
      reason: scenario.attempts === 1 ? 'operation-deadline' : 'HTTP 503' });
    captureWait = false;
    expect((await metrics()).received).toBe(scenario.attempts);
    const events = engine.snapshot().events.filter(e => e.requestId === result.requestId);
    expect(events.filter(e => e.type === 'RETRY_STARTED')).toHaveLength(scenario.attempts - 1);
    expect(events.filter(e => e.type === 'ATTEMPT_STARTED')).toHaveLength(scenario.attempts);
    expect(events.filter(e => e.type === 'RETRY_SCHEDULED')).toHaveLength(1);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, failed: 1, rollingCompleted: 1, rollingFailed: 1 });
    for (const wait of waits) expect(clearTimeout).toHaveBeenCalledWith(wait.timer);
  });
  it('zero backoff cannot retry with an exhausted operation budget', async () => {
    engine.configure({ backoffMs: 0 });
    firstFailureAt = 100;
    expect(await engine.run()).toMatchObject({ outcome: 'failure', attempts: 1, reason: 'operation-deadline' });
    expect(waits).toHaveLength(0);
    expect(engine.snapshot().events.filter(e => e.type.startsWith('RETRY_'))).toHaveLength(0);
    expect((await metrics()).received).toBe(1);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, failed: 1, rollingCompleted: 1, rollingFailed: 1 });
  });
  it('shutdown cancels a pending wait without retry or extra HTTP and clears its timer', async () => {
    const pending = engine.run();
    await waitFor(() => waits.length === 1);
    engine.shutdown();
    expect(await pending).toMatchObject({ outcome: 'failure', attempts: 1, reason: 'engine-stopped' });
    captureWait = false;
    expect((await metrics()).received).toBe(1);
    expect(engine.snapshot().events.filter(e => e.type === 'RETRY_STARTED')).toHaveLength(0);
    expect(engine.snapshot().events.filter(e => e.type === 'ATTEMPT_STARTED')).toHaveLength(1);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, failed: 1, rollingCompleted: 1, rollingFailed: 1 });
    expect(clearTimeout).toHaveBeenCalledWith(waits[0].timer);
  });
});

describe('native Opossum gate and statistics', () => {
  it('stays closed at exactly 50%, then opens on a failure above the threshold', async () => {
    replacePolicy({ retries: 0 });
    await configure({ mode: 'fail' });
    await engine.run();
    await engine.run();
    expect(engine.state).toBe('CLOSED');
    await configure({ mode: 'normal' });
    await engine.run();
    await engine.run();
    expect(engine.state).toBe('CLOSED');
    expect(engine.snapshot().metrics).toMatchObject({ rollingCalls: 4, rollingCompleted: 4, rollingFailed: 2, errorPercentage: 50 });
    await configure({ mode: 'fail' });
    await engine.run();
    expect(engine.state).toBe('OPEN');
    const received = (await metrics()).received;
    const rejected = await Promise.all(Array.from({ length: 10 }, () => engine.run()));
    expect(rejected.every(result => result.outcome === 'rejected' && result.attempts === 0)).toBe(true);
    expect((await metrics()).received).toBe(received);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 5, failed: 3, rejected: 10,
      rollingCalls: 10, rollingCompleted: 0, rollingFailed: 0 });
    expect(engine.snapshot().events.filter(event => event.type === 'CIRCUIT_OPENED')).toHaveLength(1);
    expect(engine.snapshot().recoveryAt! - engine.snapshot().openedAt!).toBe(policy.recoveryMs);
  });
  it('counts pending fires and does not evaluate statistical opening on successful completions', async () => {
    replacePolicy({ retries: 0, attemptTimeoutMs: 1000, recoveryMs: 1000 });
    await configure({ latencyMs: 250 });
    const pending = [engine.run(), engine.run()];
    await until(async () => (await metrics()).received === 2);
    const snapshot = engine.snapshot();
    expect(snapshot.metrics).toMatchObject({ active: 2, rollingCalls: 2, rollingCompleted: 0 });
    expect(snapshot.histories.every(history => !history.outcome && history.attempts.length === 1)).toBe(true);
    await configure({ mode: 'fail', latencyMs: 0 });
    await engine.run(); await engine.run();
    expect(engine.state).toBe('CLOSED');
    expect(engine.snapshot().metrics).toMatchObject({ rollingCalls: 4, rollingCompleted: 2, rollingFailed: 2, errorPercentage: 50 });
    await Promise.all(pending);
    expect(engine.state).toBe('CLOSED');
    expect(engine.snapshot().metrics).toMatchObject({ rollingCalls: 4, rollingCompleted: 4, rollingFailed: 2 });
    // Returned snapshots are immutable copies, not live histories.
    expect(snapshot.histories[0].outcome).toBeUndefined();
  });
  it('HALF_OPEN admits precisely one successful probe without retries', async () => {
    replacePolicy({ minimumVolume: 1 });
    await configure({ mode: 'fail' });
    await engine.run();
    await until(() => engine.state === 'HALF_OPEN');
    await configure({ mode: 'normal', latencyMs: 50 });
    const received = (await metrics()).received;
    const results = await Promise.all(Array.from({ length: 5 }, () => engine.run()));
    expect(results.filter(result => result.outcome === 'success')).toHaveLength(1);
    expect(results.filter(result => result.outcome === 'rejected')).toHaveLength(4);
    expect((await metrics()).received).toBe(received + 1);
    expect(engine.state).toBe('CLOSED');
    const events = engine.snapshot().events;
    expect(events.filter(event => event.type === 'CIRCUIT_HALF_OPEN')).toHaveLength(1);
    expect(events.find(event => event.type === 'CIRCUIT_CLOSED')).toMatchObject({ probe: true, reason: 'probe-succeeded' });
  });
  it('failed HALF_OPEN probe reopens without retry, regardless of minimum volume', async () => {
    await configure({ mode: 'fail' });
    for (let index = 0; index < 4; index++) await engine.run();
    await until(() => engine.state === 'HALF_OPEN');
    const received = (await metrics()).received;
    const result = await engine.run();
    expect(result.outcome).toBe('failure');
    expect(result.attempts).toBe(1);
    expect((await metrics()).received).toBe(received + 1);
    expect(engine.state).toBe('OPEN');
    expect(engine.snapshot().events.filter(event => event.type === 'CIRCUIT_OPENED')).toHaveLength(2);
  });
  it.each(['normal', 'fail'] as const)('old %s completion cannot consume or alter the new HALF_OPEN probe', async oldMode => {
    replacePolicy({ minimumVolume: 1, errorThresholdPercentage: 1, retries: 0,
      attemptTimeoutMs: 1000, operationDeadlineMs: 1500, recoveryMs: 40 });
    await configure({ mode: oldMode, latencyMs: 200 });
    const old = engine.run();
    await until(async () => (await metrics()).received === 1);
    await configure({ mode: 'fail', latencyMs: 0 });
    await engine.run();
    expect(engine.state).toBe('OPEN');
    await until(() => engine.state === 'HALF_OPEN');
    await configure({ mode: 'normal', latencyMs: 350 });
    const probe = engine.run();
    await old;
    expect(engine.state).toBe('HALF_OPEN');
    expect((await engine.run()).outcome).toBe('rejected');
    expect(engine.snapshot().metrics).toMatchObject({ rollingCalls: 2, rollingCompleted: 0 });
    expect((await probe).outcome).toBe('success');
    expect(engine.state).toBe('CLOSED');
    expect(engine.snapshot().events.filter(event => event.type === 'CIRCUIT_CLOSED')).toHaveLength(1);
  });
  it('expires rolling samples without dropping lifetime outcomes', async () => {
    replacePolicy({ rollingWindowMs: 100, retries: 0 });
    await configure({ mode: 'fail' });
    await engine.run();
    expect(engine.snapshot().metrics.rollingCompleted).toBe(1);
    await sleep(125);
    expect(engine.snapshot().metrics).toMatchObject({ completed: 1, rollingCompleted: 0, rollingFailed: 0 });
  });
});

describe('mutation integrity', () => {
  it('rejects policy, external mutation and reset while work is active', async () => {
    await configure({ latencyMs: 50 });
    const pending = engine.run();
    expect(() => engine.configure({ retries: 0 })).toThrow(ConflictError);
    await expect(engine.configureExternal({ mode: 'fail' })).rejects.toBeInstanceOf(ConflictError);
    await expect(engine.reset()).rejects.toBeInstanceOf(ConflictError);
    await pending;
    expect(engine.snapshot().histories[0].outcome).toBe('success');
    expect(engine.configure({ retries: 0 }).retries).toBe(0);
  });
  it('caps admission at 100 active logical operations with no extra upstream call', async () => {
    replacePolicy({ retries: 0, attemptTimeoutMs: 1000, operationDeadlineMs: 1500 });
    await configure({ latencyMs: 100 });
    const pending = Array.from({ length: 100 }, () => engine.run());
    expect(engine.snapshot().metrics.active).toBe(100);
    const overflow = await engine.run();
    expect(overflow).toMatchObject({ outcome: 'rejected', attempts: 0, reason: 'engine-capacity' });
    const completed = await Promise.all(pending);
    expect(completed.every(result => result.outcome === 'success')).toBe(true);
    expect((await metrics()).received).toBe(100);
  });
  it('clears the external observation and timestamp when a successful refresh is followed by failure', async () => {
    const external = await engine.refreshExternal();
    expect(external).not.toBeNull();
    const observed = engine.snapshot();
    expect(observed.external).toEqual(external);
    expect(observed.externalObservedAt).toEqual(expect.any(Number));
    expect(observed.externalError).toBeUndefined();

    await upstream.close();
    await expect(engine.refreshExternal()).resolves.toBeNull();
    const failed = engine.snapshot();
    expect(failed.external).toBeNull();
    expect(failed.externalObservedAt).toBeNull();
    expect(failed.externalError).toBe('fetch failed');
    expect(failed.metrics).toEqual(observed.metrics);
    expect(failed.histories).toEqual(observed.histories);
    expect(failed.events).toEqual(observed.events);
    expect(failed.cursor).toBe(observed.cursor);
    expect(failed.state).toBe(observed.state);
    expect(failed.policy).toEqual(observed.policy);
    expect(observed.external).toEqual(external);
    expect(observed.externalObservedAt).toEqual(expect.any(Number));
  });
  it('external config proxy aborts a hung real HTTP response after its bounded timeout', async () => {
    const stalled = Fastify({ forceCloseConnections: true });
    let cancelled = 0;
    let timer: NodeJS.Timeout | undefined;
    stalled.get('/config', (_request, reply) => {
      timer = setTimeout(() => reply.send({}), 5000);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) { clearTimeout(timer); cancelled++; }
      });
      return reply;
    });
    const stalledUrl = await stalled.listen({ host: '127.0.0.1', port: 0 });
    const proxy = new Engine(stalledUrl, policy);
    try {
      const started = Date.now();
      await expect(proxy.configureExternal({ latencyMs: 10 })).rejects.toBeInstanceOf(ProxyError);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(Date.now() - started).toBeLessThan(2000);
      await until(() => cancelled === 1);
      expect(proxy.configure({ retries: 0 }).retries).toBe(0);
    } finally { proxy.shutdown(); clearTimeout(timer); await stalled.close(); }
  });
  it('validates strict finite bounded policy values and retains prior policy on errors', () => {
    for (const patch of [{ retries: 3 }, { retries: 1.5 }, { attemptTimeoutMs: Infinity }, { minimumVolume: NaN }, { retries: '1' }, { mystery: 2 }, null, []]) {
      expect(() => engine.configure(patch)).toThrow(ValidationError);
      expect(engine.policy).toEqual(policy);
    }
  });
  it('reset restores defaults/upstream, clears bounded history and fences cursor generation', async () => {
    await configure({ mode: 'fail' });
    await engine.run();
    const previous = engine.snapshot();
    const reset = await engine.reset();
    expect(reset.epoch).not.toBe(previous.epoch);
    expect(Number(reset.cursor.split(':')[1])).toBeGreaterThanOrEqual(Number(previous.cursor.split(':')[1]));
    expect(reset.policy).toEqual(DEFAULT_POLICY);
    expect(reset.state).toBe('CLOSED');
    expect(reset.histories).toEqual([]);
    expect(reset.events).toEqual([]);
    expect(reset.metrics).toMatchObject({ completed: 0, rejected: 0, active: 0 });
    expect(reset.external?.config.mode).toBe('normal');
    expect(reset.external?.metrics.received).toBe(0);
    expect((await engine.run()).outcome).toBe('success');
  });
  it('reset serializes management and rejects new admissions during its real upstream roundtrip', async () => {
    const reset = engine.reset();
    expect((await engine.run()).outcome).toBe('rejected');
    expect(() => engine.configure({ retries: 0 })).toThrow(ConflictError);
    await expect(engine.reset()).rejects.toBeInstanceOf(ConflictError);
    const snapshot = await reset;
    expect(snapshot.state).toBe('CLOSED');
    expect(snapshot.external?.metrics.received).toBe(0);
    expect((await engine.run()).outcome).toBe('success');
  });
  it('replacement shuts down the previous recovery timer', async () => {
    replacePolicy({ minimumVolume: 1, retries: 0, recoveryMs: 50 });
    await configure({ mode: 'fail' });
    await engine.run();
    expect(engine.state).toBe('OPEN');
    engine.configure({ minimumVolume: 10 });
    await sleep(90);
    expect(engine.state).toBe('CLOSED');
    expect(engine.snapshot().events.some(event => event.type === 'CIRCUIT_HALF_OPEN')).toBe(false);
  });
});
