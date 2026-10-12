import type { EngineEvent, Policy, RequestHistory, Snapshot } from '@resilience/contracts';

export const EVENT_LIMIT = 1000;
export const HISTORY_LIMIT = 200;
export const VISUAL_SPEEDS = [1, 0.5, 0.25] as const;
export type VisualSpeed = typeof VISUAL_SPEEDS[number];
export const normalizeVisualSpeed = (rate: number): VisualSpeed =>
  VISUAL_SPEEDS.find(supported => supported === rate) ?? 1;
export type Route = 'inlet' | 'http' | 'retry' | 'wait' | 'success' | 'failure' | 'reject';
export interface Stage { route: Route; attemptId?: string; index?: number }
export interface Journey { history: RequestHistory; stages: Stage[]; elapsed: number; completed: boolean }
export const STAGE_MS: Record<Route, number> = {
  inlet: 320, http: 360, wait: 180, retry: 220, success: 600, failure: 600, reject: 600,
};
const terminal = (route: Route) => ['success', 'failure', 'reject'].includes(route);
export interface Store {
  live: Snapshot | null;
  view: Snapshot | null;
  clock: number;
  sequence: number;
  journeys: Journey[];
  pending: EngineEvent[];
  retired: string[];
  generation: number;
  gap: boolean;
  notice: string;
}
export interface SnapshotTicket { epoch: string | null; generation: number }
export const createStore = (): Store => ({
  live: null, view: null, clock: 0, sequence: 0, journeys: [], pending: [],
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
    const live = applyEvent(next.live!, item);
    let journeys = next.journeys;
    const history = live.histories.find(history => history.requestId === item.requestId);
    if (history) {
      const existing = journeys.find(journey => journey.history.requestId === item.requestId);
      const route: Route | undefined = item.type === 'ATTEMPT_STARTED' ? 'http'
        : item.type === 'RETRY_SCHEDULED' ? 'wait' : item.type === 'RETRY_STARTED' ? 'retry'
        : item.type === 'REQUEST_REJECTED' ? 'reject'
        : item.type === 'REQUEST_FINISHED' ? signalRoute(live, history.requestId) : undefined;
      const journey = existing ?? { history, stages: [{ route: 'inlet' as Route }], elapsed: 0, completed: false };
      const stage = route ? { route, attemptId: item.attemptId, index: item.index } : undefined;
      const append = stage && !(terminal(stage.route) && journey.stages.some(item => terminal(item.route)));
      const updated = { ...journey, history, stages: append ? [...journey.stages, stage] : journey.stages };
      journeys = existing ? journeys.map(value => value === existing ? updated : value) : [...journeys, updated];
    }
    next = { ...next, live, view: live, journeys, sequence: item.sequence, pending: next.pending.slice(1) };
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
    const histories = [...snapshot.histories.filter(item => item.finishedAt !== undefined).slice(-4),
      ...snapshot.histories.filter(item => item.finishedAt === undefined)];
    const journeys = histories.map(history => ({ history, stages: [{ route: signalRoute(snapshot, history.requestId),
      attemptId: history.attempts.at(-1)?.attemptId, index: history.attempts.at(-1)?.index }],
      elapsed: history.finishedAt !== undefined ? STAGE_MS[signalRoute(snapshot, history.requestId)] : 0,
      completed: history.finishedAt !== undefined }));
    return { ...createStore(), live: snapshot, view: snapshot, journeys, clock: snapshot.serverTime, sequence,
      generation: store.generation + 1,
      retired: store.live && store.live.epoch !== snapshot.epoch
        ? [...store.retired, store.live.epoch].slice(-32) : store.retired,
      notice: store.live ? 'Authoritative snapshot restored; no synthetic requests.' : '' };
  }
  let next = store;
  const tail = snapshot.events.filter(item => item.epoch === snapshot.epoch && item.sequence > store.sequence)
    .sort((a, b) => a.sequence - b.sequence);
  for (const event of tail) next = ingest(next, event);
  const missingTail = next.sequence !== sequence;
  // Snapshot catch-up repairs authority, never discards an unpainted journey.
  let journeys = next.journeys.map(journey => ({ ...journey,
    history: snapshot.histories.find(item => item.requestId === journey.history.requestId) ?? journey.history }));
  for (const history of snapshot.histories) {
    let journey = journeys.find(item => item.history.requestId === history.requestId);
    if (!journey && !store.live.histories.some(item => item.requestId === history.requestId)) {
      journey = { history, stages: [{ route: 'inlet' }], elapsed: 0, completed: false };
      journeys.push(journey);
    }
    if (!journey || journey.completed) continue;
    // If the tail expired, recover only stages evidenced by real snapshot history.
    const stages = [...journey.stages];
    for (const attempt of history.attempts) {
      if (!stages.some(stage => stage.attemptId === attempt.attemptId && stage.route === 'http') &&
          (!next.live?.histories.find(item => item.requestId === history.requestId)?.attempts
            .some(item => item.attemptId === attempt.attemptId))) {
        stages.push({ route: 'http', attemptId: attempt.attemptId, index: attempt.index });
      }
    }
    if (history.outcome && !stages.some(stage => terminal(stage.route))) {
      stages.push({ route: signalRoute(snapshot, history.requestId) });
    }
    journeys = journeys.map(item => item === journey ? { ...item, stages } : item);
  }
  const pending = missingTail ? [] : next.pending.filter(item => item.sequence > sequence);
  return { ...next, live: snapshot, view: snapshot, journeys, sequence, pending, gap: pending.length > 0,
    notice: missingTail ? 'Authoritative snapshot restored: event tail has a gap; known journeys retained.' : next.notice };
}

export function advance(store: Store, dt: number, target: number, visualSpeed = 1): Store {
  if (!store.live) return store;
  const journeyDelta = Math.max(0, dt) * normalizeVisualSpeed(visualSpeed);
  const journeys = store.journeys.map(journey => {
    if (journey.completed) return journey;
    const elapsed = journey.elapsed + journeyDelta;
    if (elapsed < STAGE_MS[journey.stages[0].route]) return { ...journey, elapsed };
    // At most one transition per painted frame, even after a delayed frame.
    if (journey.stages.length > 1) return { ...journey, stages: journey.stages.slice(1), elapsed: 0 };
    return { ...journey, elapsed, completed: terminal(journey.stages[0].route) };
  });
  const completed = journeys.filter(item => item.completed).slice(-4);
  return { ...store, clock: Math.max(target, store.live.serverTime),
    journeys: journeys.filter(item => !item.completed || completed.includes(item)) };
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
