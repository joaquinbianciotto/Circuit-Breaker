import type { EngineEvent, Policy, RequestHistory, Snapshot } from '@resilience/contracts';

export const EVENT_LIMIT = 1000;
export const HISTORY_LIMIT = 200;
export type Route = 'inlet' | 'http' | 'retry' | 'wait' | 'success' | 'failure' | 'reject';
export interface Store {
  live: Snapshot | null;
  view: Snapshot | null;
  clock: number;
  sequence: number;
  queue: EngineEvent[];
  pending: EngineEvent[];
  policyObservations: { timestamp: number; policy: Policy }[];
  retired: string[];
  generation: number;
  gap: boolean;
  notice: string;
}
export interface SnapshotTicket { epoch: string | null; generation: number }
export const createStore = (): Store => ({
  live: null, view: null, clock: 0, sequence: 0, queue: [], pending: [], policyObservations: [],
  retired: [], generation: 0, gap: false, notice: '',
});
export const snapshotTicket = (store: Store): SnapshotTicket => ({
  epoch: store.live?.epoch ?? null, generation: store.generation,
});
export const cursorSequence = (cursor: string) => Number(cursor.slice(cursor.lastIndexOf(':') + 1));

function boundedHistories(histories: RequestHistory[]) {
  const active = histories.filter(item => item.finishedAt === undefined);
  const finished = histories.filter(item => item.finishedAt !== undefined).slice(-HISTORY_LIMIT);
  return [...finished, ...active.slice(-100)];
}

/** Apply only observed events; elapsed time never settles an operation. */
export function applyEvent(snapshot: Snapshot, event: EngineEvent): Snapshot {
  const next = { ...snapshot, state: event.state, serverTime: Math.max(snapshot.serverTime, event.timestamp),
    cursor: event.id, events: [...snapshot.events, event].slice(-EVENT_LIMIT) };
  if (event.type === 'CIRCUIT_OPENED') {
    next.openedAt = event.timestamp;
    next.recoveryAt = event.timestamp + snapshot.policy.recoveryMs;
  } else if (event.type === 'CIRCUIT_CLOSED') {
    next.openedAt = null;
    next.recoveryAt = null;
  }
  if (!event.requestId) return next;
  const id = event.requestId;
  const histories = snapshot.histories.map(item => ({ ...item, attempts: item.attempts.map(attempt => ({ ...attempt })) }));
  let history = histories.find(item => item.requestId === id);
  if (!history && (event.type === 'REQUEST_STARTED' || event.type === 'REQUEST_REJECTED')) {
    history = { requestId: id, startedAt: event.timestamp,
      deadlineAt: event.deadlineAt ?? event.timestamp + snapshot.policy.operationDeadlineMs,
      probe: event.probe ?? false, attempts: [] };
    histories.push(history);
  }
  // A bootstrap may start mid-operation. Its snapshot supplies the missing history.
  if (history) {
    if (event.type === 'ATTEMPT_STARTED' && event.attemptId && !history.attempts.some(item => item.attemptId === event.attemptId)) {
      history.attempts.push({ attemptId: event.attemptId, index: event.index ?? 1, startedAt: event.timestamp });
    }
    const attempt = history.attempts.find(item => item.attemptId === event.attemptId);
    if (attempt && ['ATTEMPT_SUCCEEDED', 'ATTEMPT_FAILED', 'ATTEMPT_TIMEOUT'].includes(event.type)) {
      attempt.finishedAt = event.timestamp;
      attempt.status = event.status;
      attempt.reason = event.reason;
      attempt.outcome = event.type === 'ATTEMPT_SUCCEEDED' ? 'success' : event.type === 'ATTEMPT_TIMEOUT' ? 'timeout' : 'failure';
    }
    if (event.type === 'REQUEST_REJECTED') {
      history.outcome = 'rejected';
      history.reason = event.reason;
      history.finishedAt = event.timestamp;
    }
    if (event.type === 'REQUEST_FINISHED') {
      history.finishedAt = event.timestamp;
      history.outcome = history.outcome === 'rejected' ? 'rejected' : event.reason === 'success' ? 'success' : 'failure';
      history.reason = event.reason;
    }
  }
  next.histories = boundedHistories(histories);
  // Rolling percentages remain the backend snapshot observation, never attempt counts.
  return next;
}

export function ingest(store: Store, event: EngineEvent): Store {
  if (!store.live || event.epoch !== store.live.epoch || event.sequence <= store.sequence ||
      store.pending.some(item => item.sequence === event.sequence)) return store;
  let next = { ...store, pending: [...store.pending, event].sort((a, b) => a.sequence - b.sequence).slice(0, EVENT_LIMIT) };
  while (next.pending[0]?.sequence === next.sequence + 1) {
    const item = next.pending[0];
    if (next.queue.length >= EVENT_LIMIT) {
      // Bounded slow playback cannot silently lose topology transitions.
      next = { ...next, view: next.live, clock: next.live!.serverTime, queue: [], policyObservations: [], notice: 'Playback resynchronized: bounded buffer reached.' };
    }
    next = { ...next, live: applyEvent(next.live!, item), sequence: item.sequence,
      queue: [...next.queue, item], pending: next.pending.slice(1) };
  }
  next.gap = next.pending.length > 0;
  return next;
}

export function acceptSnapshot(store: Store, snapshot: Snapshot, reason: string, ticket?: SnapshotTicket): Store {
  if (ticket && (ticket.generation !== store.generation || ticket.epoch !== (store.live?.epoch ?? null))) return store;
  if (store.retired.includes(snapshot.epoch)) return store;
  const sequence = cursorSequence(snapshot.cursor);
  if (store.live?.epoch === snapshot.epoch && (sequence < store.sequence ||
      (sequence === store.sequence && snapshot.serverTime < store.live.serverTime))) return store;
  if (!store.live || store.live.epoch !== snapshot.epoch || reason === 'reset') {
    return { ...createStore(), live: snapshot, view: snapshot, clock: snapshot.serverTime, sequence,
      generation: store.generation + 1,
      retired: store.live && store.live.epoch !== snapshot.epoch
        ? [...store.retired, store.live.epoch].slice(-32) : store.retired,
      notice: store.live ? 'Authoritative snapshot restored; no synthetic requests.' : '' };
  }
  let next = store;
  const tail = snapshot.events.filter(item => item.epoch === snapshot.epoch && item.sequence > store.sequence)
    .sort((a, b) => a.sequence - b.sequence);
  for (const event of tail) next = ingest(next, event);
  if (next.sequence !== sequence) {
    return { ...next, live: snapshot, view: snapshot, clock: snapshot.serverTime,
      sequence, pending: [], queue: [], policyObservations: [], gap: false, notice: 'Playback resynchronized: event tail has a gap.' };
  }
  // A fresh REST response updates real metrics/config without fast-forwarding the figure.
  const changedPolicy = JSON.stringify(snapshot.policy) !== JSON.stringify(store.live.policy);
  const policyObservations = changedPolicy
    ? [...next.policyObservations, { timestamp: snapshot.serverTime, policy: snapshot.policy }].slice(-EVENT_LIMIT)
    : next.policyObservations;
  return { ...next, live: snapshot, policyObservations, pending: next.pending.filter(item => item.sequence > sequence),
    gap: next.pending.some(item => item.sequence > sequence) };
}

export function advance(store: Store, dt: number, speed: number, paused: boolean, target: number): Store {
  if (paused || !store.view) return store;
  const clock = Math.min(Math.max(target, store.clock), store.clock + Math.max(0, dt) * speed);
  let view = store.view;
  let index = 0;
  let observation = 0;
  const applyPolicyThrough = (timestamp: number) => {
    while (store.policyObservations[observation]?.timestamp <= timestamp) {
      view = { ...view, policy: store.policyObservations[observation++].policy };
    }
  };
  while (index < store.queue.length && store.queue[index].timestamp <= clock) {
    applyPolicyThrough(store.queue[index].timestamp);
    view = applyEvent(view, store.queue[index++]);
  }
  applyPolicyThrough(clock);
  return { ...store, view, clock, queue: index ? store.queue.slice(index) : store.queue,
    policyObservations: observation ? store.policyObservations.slice(observation) : store.policyObservations };
}
export function liveCatchUp(store: Store, target: number): Store {
  if (!store.live) return store;
  return { ...store, view: store.live, clock: Math.max(target, store.live.serverTime), queue: [], policyObservations: [] };
}

export function signalRoute(snapshot: Snapshot, id: string): Route {
  const history = snapshot.histories.find(item => item.requestId === id);
  if (history?.outcome === 'rejected') return 'reject';
  if (history?.outcome === 'success') return 'success';
  if (history?.outcome === 'failure') return 'failure';
  const event = snapshot.events.findLast(item => item.requestId === id);
  if (event?.type === 'RETRY_SCHEDULED') return 'wait';
  if (event?.type === 'RETRY_STARTED') return 'retry';
  if (history?.attempts.length) return 'http';
  return 'inlet';
}
export function attemptTimer(history: RequestHistory, policy: Readonly<Policy>, now: number) {
  const attempt = history.attempts.at(-1);
  if (!attempt) return { remaining: 0, fraction: 0, outcome: 'idle' };
  const deadline = Math.min(attempt.startedAt + policy.attemptTimeoutMs, history.deadlineAt);
  const duration = Math.max(1, deadline - attempt.startedAt);
  const elapsed = Math.max(0, Math.min(now, attempt.finishedAt ?? now) - attempt.startedAt);
  return { remaining: Math.max(0, deadline - (attempt.finishedAt ?? now)),
    fraction: Math.min(1, elapsed / duration), outcome: attempt.outcome ?? 'active' };
}
export function recoveryTimer(snapshot: Snapshot, now: number) {
  return snapshot.recoveryAt === null ? 0 : Math.max(0, snapshot.recoveryAt - now);
}
export const shortId = (id: string) => id.slice(0, 8);
