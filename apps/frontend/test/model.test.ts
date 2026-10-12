import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type EngineEvent, type Snapshot } from '@resilience/contracts';
import { createStore, acceptSnapshot, ingest, advance, snapshotTicket, attemptTimer, recoveryTimer } from '../src/model';

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  kind: 'snapshot', epoch: 'a', cursor: 'a:0', serverTime: 1000,
  state: 'CLOSED', openedAt: null, recoveryAt: null, policy: { ...DEFAULT_POLICY },
  metrics: { completed: 0, succeeded: 0, failed: 0, rejected: 0, active: 0,
    rollingCompleted: 0, rollingFailed: 0, errorPercentage: 0 },
  histories: [], events: [], external: null, externalObservedAt: null, ...overrides,
});
const event = (sequence: number, type: EngineEvent['type'], fields: Partial<EngineEvent> = {}): EngineEvent => ({
  id: `a:${sequence}`, epoch: 'a', sequence, type, timestamp: 1000,
  state: 'CLOSED', requestId: 'req-1', ...fields,
});
const boot = () => acceptSnapshot(createStore(), snapshot(), 'initial');
const route = (store: ReturnType<typeof boot>, id = 'req-1') =>
  store.journeys.find(item => item.history.requestId === id)?.stages[0].route;
const frame = (store: ReturnType<typeof boot>, dt = 1000) => advance(store, dt, 9000);
function success(store: ReturnType<typeof boot>, id: string, sequence: number) {
  for (const item of [event(sequence, 'REQUEST_STARTED', { requestId: id }),
    event(sequence + 1, 'ATTEMPT_STARTED', { requestId: id, attemptId: `${id}:1`, index: 1 }),
    event(sequence + 2, 'ATTEMPT_SUCCEEDED', { requestId: id, attemptId: `${id}:1` }),
    event(sequence + 3, 'REQUEST_FINISHED', { requestId: id, reason: 'success' })]) store = ingest(store, item);
  return store;
}

describe('always-live authoritative observations', () => {
  it('buffers out-of-order events, drains in sequence, and deduplicates journeys', () => {
    let store = ingest(boot(), event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }));
    expect(store.sequence).toBe(0);
    expect(store.gap).toBe(true);
    store = ingest(store, event(1, 'REQUEST_STARTED'));
    expect(store.sequence).toBe(2);
    expect(store.live?.histories[0].attempts).toHaveLength(1);
    expect(store.journeys[0].stages.map(stage => stage.route)).toEqual(['inlet', 'http']);
    expect(ingest(store, event(2, 'ATTEMPT_STARTED'))).toBe(store);
  });
  it('rejects stale REST snapshots, same-cursor timestamps and generation tickets', () => {
    let store = boot();
    const ticket = snapshotTicket(store);
    store = ingest(store, event(1, 'CIRCUIT_OPENED', { state: 'OPEN', requestId: null }));
    expect(store.view).toBe(store.live);
    expect(acceptSnapshot(store, snapshot(), 'refresh', ticket)).toBe(store);
    store = acceptSnapshot(store, snapshot({ cursor: 'a:1', serverTime: 1200 }), 'refresh');
    expect(acceptSnapshot(store, snapshot({ cursor: 'a:1', serverTime: 1100 }), 'refresh')).toBe(store);
    store = acceptSnapshot(store, snapshot({ epoch: 'b', cursor: 'b:0' }), 'reset');
    expect(acceptSnapshot(store, snapshot({ cursor: 'a:9' }), 'refresh', ticket)).toBe(store);
  });
  it('refresh and reconnect catch-up preserve unpainted journeys, even across an incomplete tail', () => {
    let store = success(boot(), 'req-1', 1);
    const authoritative = store.live!;
    store = acceptSnapshot(store, { ...authoritative, serverTime: 1100 }, 'refresh');
    expect(route(store)).toBe('inlet');
    store = acceptSnapshot(store, { ...authoritative, cursor: 'a:10', serverTime: 1200, events: [] }, 'expired');
    expect(store.sequence).toBe(10);
    expect(route(store)).toBe('inlet');
    expect(store.view).toBe(store.live);
    expect(route(frame(store))).toBe('http');
    expect(route(frame(frame(store)))).toBe('success');
  });
  it('uses an ordered snapshot tail without inventing engine events', () => {
    const store = acceptSnapshot(boot(), snapshot({ cursor: 'a:2', events: [event(1, 'REQUEST_STARTED'),
      event(2, 'ATTEMPT_STARTED', { index: 1, attemptId: 'req-1:1' })],
      histories: [{ requestId: 'req-1', startedAt: 1000, deadlineAt: 4000, probe: false,
        attempts: [{ attemptId: 'req-1:1', index: 1, startedAt: 1000 }] }] }), 'expired');
    expect(store.sequence).toBe(2);
    expect(route(store)).toBe('inlet');
    expect(store.live?.events).toHaveLength(2);
  });
  it('reset fences old generations and discards only their journeys', () => {
    let store = success(boot(), 'req-1', 1);
    store = acceptSnapshot(store, snapshot({ epoch: 'b', cursor: 'b:0' }), 'reset');
    expect(store.journeys).toHaveLength(0);
    expect(ingest(store, event(5, 'REQUEST_STARTED'))).toBe(store);
    expect(acceptSnapshot(store, snapshot(), 'initial')).toBe(store);
    store = ingest(store, event(1, 'REQUEST_STARTED', { epoch: 'b', id: 'b:1', requestId: 'new' }));
    expect(route(store, 'new')).toBe('inlet');
  });
  it('bootstrap completed markers are readable at the terminal, not replayed starts', () => {
    const completed = success(boot(), 'old', 1).live!;
    const store = acceptSnapshot(createStore(), completed, 'initial');
    expect(route(store, 'old')).toBe('success');
    expect(store.journeys[0].completed).toBe(true);
    expect(store.journeys[0].elapsed).toBeGreaterThanOrEqual(600);
    expect(frame(store).live?.events).toEqual(completed.events);
  });
  it('bounds authoritative events without erasing unplayed visual stages', () => {
    let store = success(boot(), 'req-1', 1);
    for (let i = 5; i <= 1200; i++) store = ingest(store, event(i, 'CIRCUIT_CLOSED', { requestId: null }));
    expect(store.live!.events.length).toBeLessThanOrEqual(1000);
    expect(route(store)).toBe('inlet');
    expect(ingest(store, event(1201, 'REQUEST_STARTED', { epoch: 'unknown' }))).toBe(store);
  });
});

describe('minimum visible journeys, independent of HTTP timing', () => {
  it('same-timestamp zero-latency success paints inlet, then HTTP, then observed terminal', () => {
    let store = success(boot(), 'req-1', 1);
    const authoritative = store.live;
    expect(authoritative?.histories[0].outcome).toBe('success');
    expect(route(store)).toBe('inlet');
    store = frame(store, 0);
    expect(route(store)).toBe('inlet');
    store = frame(store, 100);
    expect(route(store)).toBe('inlet');
    store = frame(store);
    expect(route(store)).toBe('http');
    store = frame(store);
    expect(route(store)).toBe('success');
    expect(store.live).toBe(authoritative);
    expect(store.live?.histories[0].attempts[0].finishedAt).toBe(1000);
  });
  it('all ten batch IDs play admission, HTTP and terminal before completed caps apply', () => {
    let store = boot();
    const ids = Array.from({ length: 10 }, (_, i) => `batch-${i}`);
    ids.forEach((id, i) => { store = success(store, id, i * 4 + 1); });
    for (const expected of ['inlet', 'http', 'success']) {
      expect(store.journeys).toHaveLength(10);
      expect(ids.map(id => route(store, id))).toEqual(ids.map(() => expected));
      store = frame(store);
    }
    expect(store.journeys).toHaveLength(4);
  });
  it('rejection plays inlet then shunt without creating HTTP', () => {
    let store = ingest(boot(), event(1, 'REQUEST_REJECTED', { state: 'OPEN', reason: 'open' }));
    expect(route(store)).toBe('inlet');
    store = frame(store);
    expect(route(store)).toBe('reject');
    expect(store.journeys[0].history.attempts).toHaveLength(0);
    expect(store.journeys[0].stages.map(stage => stage.route)).not.toContain('http');
    expect(store.live?.state).toBe('OPEN');
  });
  it('HALF_OPEN stays authoritative while one probe and concurrent rejection enter separately', () => {
    let store = ingest(boot(), event(1, 'CIRCUIT_HALF_OPEN', { requestId: null, state: 'HALF_OPEN' }));
    store = ingest(store, event(2, 'REQUEST_STARTED', { probe: true, state: 'HALF_OPEN' }));
    store = ingest(store, event(3, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1, state: 'HALF_OPEN' }));
    store = ingest(store, event(4, 'REQUEST_REJECTED', { requestId: 'req-2', state: 'HALF_OPEN' }));
    expect(store.view?.state).toBe('HALF_OPEN');
    expect(store.journeys.filter(item => item.history.probe)).toHaveLength(1);
    expect(store.journeys.map(item => item.stages.map(stage => stage.route)))
      .toEqual([['inlet', 'http'], ['inlet', 'reject']]);
  });
  it('real rejection start/reject/finish has only one shunt stage', () => {
    let store = ingest(boot(), event(1, 'REQUEST_STARTED'));
    store = ingest(store, event(2, 'REQUEST_REJECTED', { reason: 'open' }));
    store = ingest(store, event(3, 'REQUEST_FINISHED', { reason: 'open' }));
    expect(store.journeys[0].stages.map(stage => stage.route)).toEqual(['inlet', 'reject']);
  });
  it('retry stays in the same journey and never re-enters admission', () => {
    let store = boot();
    for (const item of [event(1, 'REQUEST_STARTED'),
      event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }),
      event(3, 'ATTEMPT_FAILED', { attemptId: 'req-1:1', status: 503 }),
      event(4, 'RETRY_SCHEDULED'), event(5, 'RETRY_STARTED'),
      event(6, 'ATTEMPT_STARTED', { attemptId: 'req-1:2', index: 2 })]) store = ingest(store, item);
    for (const expected of ['inlet', 'http', 'wait', 'retry', 'http']) {
      expect(route(store)).toBe(expected);
      store = frame(store);
    }
    expect(store.journeys).toHaveLength(1);
    expect(store.journeys[0].stages[0].attemptId).toBe('req-1:2');
    expect(store.live?.histories[0].attempts).toHaveLength(2);
  });
  it('elapsed animation time never fabricates HTTP completion or recovery', () => {
    const history = { requestId: 'req-1', startedAt: 1000, deadlineAt: 1500, probe: false,
      attempts: [{ attemptId: 'req-1:1', index: 1, startedAt: 1200 }] };
    expect(attemptTimer(history, DEFAULT_POLICY, 1300)).toEqual({ remaining: 200, fraction: 1 / 3, outcome: 'active' });
    expect(attemptTimer(history, DEFAULT_POLICY, 1800).outcome).toBe('active');
    expect(recoveryTimer({ ...snapshot(), recoveryAt: 1100 }, 2000)).toBe(0);
    let store = ingest(boot(), event(1, 'REQUEST_STARTED'));
    store = ingest(store, event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }));
    for (let i = 0; i < 10; i++) store = frame(store);
    expect(route(store)).toBe('http');
    expect(store.live?.histories[0].outcome).toBeUndefined();
  });
});
