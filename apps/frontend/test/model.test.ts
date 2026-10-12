import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type EngineEvent, type Snapshot } from '@resilience/contracts';
import {
  createStore, acceptSnapshot, ingest, advance, liveCatchUp, snapshotTicket,
  attemptTimer, recoveryTimer, signalRoute,
} from '../src/model';

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  kind: 'snapshot', epoch: 'a', cursor: 'a:0', serverTime: 1000,
  state: 'CLOSED', openedAt: null, recoveryAt: null, policy: { ...DEFAULT_POLICY },
  metrics: { completed: 0, succeeded: 0, failed: 0, rejected: 0, active: 0,
    rollingCompleted: 0, rollingFailed: 0, errorPercentage: 0 },
  histories: [], events: [], external: null, externalObservedAt: null, ...overrides,
});
const event = (sequence: number, type: EngineEvent['type'], fields: Partial<EngineEvent> = {}): EngineEvent => ({
  id: `a:${sequence}`, epoch: 'a', sequence, type, timestamp: 1000 + sequence * 10,
  state: 'CLOSED', requestId: 'req-1', ...fields,
});
const boot = () => acceptSnapshot(createStore(), snapshot(), 'initial');

// This reducer is the boundary between actual outcomes and educational replay.
describe('authoritative ingestion', () => {
  it('buffers out-of-order events, drains in sequence, and deduplicates', () => {
    let store = ingest(boot(), event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }));
    expect(store.sequence).toBe(0);
    expect(store.gap).toBe(true);
    store = ingest(store, event(1, 'REQUEST_STARTED', { deadlineAt: 4000 }));
    expect(store.sequence).toBe(2);
    expect(store.live?.histories[0].attempts).toHaveLength(1);
    expect(ingest(store, event(2, 'ATTEMPT_STARTED'))).toBe(store);
  });
  it('replaces on reset and never revives a retired epoch', () => {
    let store = ingest(boot(), event(1, 'REQUEST_STARTED'));
    store = acceptSnapshot(store, snapshot({ epoch: 'b', cursor: 'b:2' }), 'reset');
    expect(store.queue).toHaveLength(0);
    expect(store.live?.histories).toHaveLength(0);
    expect(ingest(store, event(3, 'REQUEST_STARTED'))).toBe(store);
    expect(acceptSnapshot(store, snapshot(), 'initial')).toBe(store);
  });
  it('rejects stale REST snapshots after live events and generation changes', () => {
    let store = boot();
    const ticket = snapshotTicket(store);
    store = ingest(store, event(1, 'CIRCUIT_OPENED', { state: 'OPEN', requestId: null }));
    expect(acceptSnapshot(store, snapshot(), 'refresh', ticket)).toBe(store);
    store = acceptSnapshot(store, snapshot({ epoch: 'b', cursor: 'b:4' }), 'reset');
    expect(acceptSnapshot(store, snapshot({ cursor: 'a:9' }), 'refresh', ticket)).toBe(store);
  });
  it('rejects an older same-cursor observation instead of rolling back live configuration', () => {
    const current = acceptSnapshot(boot(), snapshot({ serverTime: 1200,
      policy: { ...DEFAULT_POLICY, attemptTimeoutMs: 1000 } }), 'refresh');
    expect(acceptSnapshot(current, snapshot({ serverTime: 1100 }), 'refresh')).toBe(current);
  });
  it('fresh metrics do not skip a slow visual queue', () => {
    let store = ingest(boot(), event(1, 'CIRCUIT_OPENED', { state: 'OPEN', requestId: null }));
    store = acceptSnapshot(store, snapshot({ cursor: 'a:1', state: 'OPEN', serverTime: 1050 }), 'refresh');
    expect(store.live?.state).toBe('OPEN');
    expect(store.view?.state).toBe('CLOSED');
    expect(store.queue).toHaveLength(1);
  });
  it('uses a snapshot tail to bridge a gap without inventing request starts', () => {
    const store = acceptSnapshot(boot(), snapshot({ cursor: 'a:2',
      events: [event(1, 'REQUEST_STARTED'), event(2, 'ATTEMPT_STARTED', { index: 1, attemptId: 'req-1:1' })],
    }), 'expired');
    expect(store.sequence).toBe(2);
    expect(store.queue.map(item => item.type)).toEqual(['REQUEST_STARTED', 'ATTEMPT_STARTED']);
    const missing = acceptSnapshot(store, snapshot({ cursor: 'a:10', events: [] }), 'expired');
    expect(missing.queue).toHaveLength(0);
    expect(missing.notice).toContain('resynchronized');
  });
  it('bounds event ingestion and rejects unknown generation events until snapshot', () => {
    let store = boot();
    for (let i = 1; i <= 1200; i++) store = ingest(store, event(i, 'CIRCUIT_CLOSED', { requestId: null }));
    expect(store.live!.events.length).toBeLessThanOrEqual(1000);
    expect(store.queue.length).toBeLessThanOrEqual(1000);
    expect(ingest(store, event(1201, 'REQUEST_STARTED', { epoch: 'unknown' })).sequence).toBe(1200);
  });
});

describe('timestamp-aligned visual playback', () => {
  it('keeps one logical identity across attempts and parks the retry until RETRY_STARTED', () => {
    let store = boot();
    const events = [event(1, 'REQUEST_STARTED', { deadlineAt: 4000 }),
      event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }),
      event(3, 'ATTEMPT_FAILED', { attemptId: 'req-1:1', index: 1, status: 503 }),
      event(4, 'RETRY_SCHEDULED', { backoffMs: 200, index: 2 }),
      event(5, 'RETRY_STARTED', { timestamp: 1240, index: 2 }),
      event(6, 'ATTEMPT_STARTED', { timestamp: 1240, attemptId: 'req-1:2', index: 2 })];
    for (const item of events) store = ingest(store, item);
    store = advance(store, 100, 1, false, 1240);
    expect(signalRoute(store.view!, 'req-1')).toBe('wait');
    store = advance(store, 140, 1, false, 1240);
    expect(signalRoute(store.view!, 'req-1')).toBe('http');
    expect(store.view?.histories).toHaveLength(1);
    expect(store.view?.histories[0].attempts.map(item => item.attemptId)).toEqual(['req-1:1', 'req-1:2']);
  });
  it('uses actual start and operation-clamped deadline, zero never fabricates timeout', () => {
    const history = { requestId: 'req-1', startedAt: 1000, deadlineAt: 1500, probe: false,
      attempts: [{ attemptId: 'req-1:1', index: 1, startedAt: 1200 }] };
    expect(attemptTimer(history, DEFAULT_POLICY, 1300)).toEqual({ remaining: 200, fraction: 1 / 3, outcome: 'active' });
    expect(attemptTimer(history, DEFAULT_POLICY, 1800).outcome).toBe('active');
    expect(attemptTimer({ ...history, attempts: [{ ...history.attempts[0], outcome: 'timeout' }] }, DEFAULT_POLICY, 1800).outcome).toBe('timeout');
  });
  it('shows one HALF_OPEN probe and a separate rejection without new HTTP', () => {
    let store = boot();
    for (const item of [event(1, 'CIRCUIT_HALF_OPEN', { state: 'HALF_OPEN', requestId: null }),
      event(2, 'REQUEST_STARTED', { state: 'HALF_OPEN', probe: true }),
      event(3, 'ATTEMPT_STARTED', { state: 'HALF_OPEN', attemptId: 'req-1:1', index: 1, probe: true }),
      event(4, 'REQUEST_REJECTED', { state: 'HALF_OPEN', requestId: 'req-2', reason: 'probe-pending' })]) store = ingest(store, item);
    store = liveCatchUp(store, 1100);
    expect(store.view?.histories.filter(item => item.probe && !item.finishedAt)).toHaveLength(1);
    expect(signalRoute(store.view!, 'req-2')).toBe('reject');
    expect(store.view?.histories.find(item => item.requestId === 'req-2')?.attempts).toHaveLength(0);
  });
  it('routes OPEN rejection at the inlet while already admitted work can finish', () => {
    let store = boot();
    for (const item of [event(1, 'REQUEST_STARTED'), event(2, 'ATTEMPT_STARTED', { attemptId: 'req-1:1', index: 1 }),
      event(3, 'CIRCUIT_OPENED', { requestId: null, state: 'OPEN' }),
      event(4, 'REQUEST_REJECTED', { requestId: 'req-2', state: 'OPEN' })]) store = ingest(store, item);
    store = liveCatchUp(store, 1100);
    expect(signalRoute(store.view!, 'req-1')).toBe('http');
    expect(signalRoute(store.view!, 'req-2')).toBe('reject');
    expect(recoveryTimer({ ...store.view!, recoveryAt: 1100 }, 2000)).toBe(0);
    expect(store.view?.state).toBe('OPEN');
  });
  it('applies policy observations at their playback boundary, not to earlier attempts', () => {
    let store = ingest(boot(), event(1, 'REQUEST_STARTED', { deadlineAt: 4000 }));
    store = acceptSnapshot(store, snapshot({ cursor: 'a:1', serverTime: 1100,
      policy: { ...DEFAULT_POLICY, attemptTimeoutMs: 1000 } }), 'refresh');
    expect(store.view?.policy.attemptTimeoutMs).toBe(800);
    store = advance(store, 50, 1, false, 1200);
    expect(store.view?.policy.attemptTimeoutMs).toBe(800);
    store = advance(store, 100, 1, false, 1200);
    expect(store.view?.policy.attemptTimeoutMs).toBe(1000);
  });
  it('pause and quarter-speed only move the visual clock, not authoritative time or policy', () => {
    let store = ingest(boot(), event(1, 'CIRCUIT_OPENED', { state: 'OPEN', requestId: null }));
    const authoritative = store.live;
    store = advance(store, 400, 0.25, true, 1400);
    expect(store.clock).toBe(1000);
    store = advance(store, 40, 0.25, false, 1400);
    expect(store.clock).toBe(1010);
    expect(store.view?.state).toBe('OPEN');
    expect(store.live).toBe(authoritative);
    expect(store.live?.policy.attemptTimeoutMs).toBe(800);
  });
});
