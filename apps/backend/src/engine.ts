import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import {
  DEFAULT_POLICY, validatePolicyPatch, validateExternalPatch,
  type Policy, type CircuitState, type EngineEvent, type Snapshot,
  type ExternalConfig, type ExternalMetrics, type ExternalSnapshot,
  type RequestHistory, type LogicalResult, type AttemptHistory,
} from '@resilience/contracts';
import { EventJournal } from './events';

interface Circuit extends EventEmitter {
  readonly closed: boolean;
  readonly opened: boolean;
  readonly halfOpen: boolean;
  readonly pendingClose: boolean;
  fire(context: Operation): Promise<void>;
  open(): void;
  shutdown(): void;
}
// Small local type surface, not a reimplementation of Opossum.
const CircuitBreaker = require('opossum') as new (
  action: (context: Operation) => Promise<void>, options: Record<string, unknown>,
) => Circuit;
interface Operation {
  history: RequestHistory;
  monotonicDeadline: number;
  gateGeneration: number;
  admitted: boolean;
}
class AttemptError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}
export class ConflictError extends Error {}
export class ProxyError extends Error {}

export class Engine {
  private breaker: Circuit;
  private policyValue: Policy;
  private gateGeneration = 0;
  private openingReplacement = false;
  private transitionRequest: Operation | null = null;
  private probe: Operation | null = null;
  private openedAt: number | null = null;
  private recoveryAt: number | null = null;
  private active = new Map<string, Operation>();
  private finished: RequestHistory[] = [];
  // Exact millisecond buckets, bounded by the validated rollingWindowMs + 1.
  private ledger = new Map<number, { completed: number; failed: number }>();
  private counters = { completed: 0, succeeded: 0, failed: 0, rejected: 0 };
  private management = false;
  private stopped = false;
  private controllers = new Set<AbortController>();
  private sleeps = new Map<NodeJS.Timeout, () => void>();
  private external: ExternalSnapshot | null = null;
  private externalError: string | undefined;
  private externalObservedAt: number | null = null;
  private externalRevision = 0;
  private refreshTicket = 0;
  readonly journal: EventJournal;

  constructor(readonly externalUrl = 'http://localhost:3002', policy: Policy = { ...DEFAULT_POLICY }) {
    this.policyValue = validatePolicyPatch(policy, { ...DEFAULT_POLICY });
    this.journal = new EventJournal(() => this.snapshot());
    this.breaker = this.createBreaker();
  }
  get policy(): Policy { return { ...this.policyValue }; }
  get state(): CircuitState {
    return this.breaker.halfOpen ? 'HALF_OPEN' : this.breaker.opened ? 'OPEN' : 'CLOSED';
  }
  private createBreaker(): Circuit {
    const breaker = new CircuitBreaker(context => this.action(context), {
      timeout: false,
      errorThresholdPercentage: 101, // Disable only automatic CLOSED threshold.
      volumeThreshold: this.policyValue.minimumVolume,
      resetTimeout: this.policyValue.recoveryMs,
      rollingCountTimeout: this.policyValue.rollingWindowMs,
      rollingCountBuckets: 1,
      rollingPercentilesEnabled: false,
      capacity: 100,
    });
    breaker.on('open', () => {
      if (this.openingReplacement || breaker !== this.breaker) return;
      this.openedAt = Date.now();
      this.recoveryAt = this.openedAt + this.policyValue.recoveryMs;
      const context = this.transitionRequest ?? this.probe;
      this.emit('CIRCUIT_OPENED', context, { reason: context?.history.probe ? 'probe-failed' : 'completed-threshold' });
      // Opossum's success listener closes ANY half-open breaker, even for an
      // old CLOSED action. Fence these continuations with a detached instance.
      // The new Opossum owns the actual OPEN timer, HALF_OPEN gate and probe.
      breaker.shutdown();
      this.gateGeneration++;
      this.probe = null;
      this.breaker = this.createBreaker();
      this.openingReplacement = true;
      try { this.breaker.open(); } finally { this.openingReplacement = false; }
    });
    breaker.on('halfOpen', () => {
      if (breaker === this.breaker) this.emit('CIRCUIT_HALF_OPEN', null, { reason: 'recovery-timer' });
    });
    breaker.on('close', () => {
      if (breaker !== this.breaker) return;
      this.openedAt = this.recoveryAt = null;
      // Successful recovery establishes a fresh sampling baseline.
      this.ledger.clear();
      this.emit('CIRCUIT_CLOSED', this.probe, { reason: 'probe-succeeded' });
      this.probe = null;
    });
    return breaker;
  }
  private emit(type: EngineEvent['type'], context: Operation | null, fields: Partial<EngineEvent> = {}) {
    this.journal.publish({
      type, timestamp: Date.now(), state: this.state,
      requestId: context?.history.requestId ?? null,
      ...(context ? { deadlineAt: context.history.deadlineAt, probe: context.history.probe } : {}),
      ...fields,
    });
  }
  async run(): Promise<LogicalResult> {
    const startedAt = Date.now();
    const context: Operation = {
      history: {
        requestId: randomUUID(), startedAt, deadlineAt: startedAt + this.policyValue.operationDeadlineMs,
        probe: this.state === 'HALF_OPEN' && this.breaker.pendingClose, attempts: [],
      },
      monotonicDeadline: performance.now() + this.policyValue.operationDeadlineMs,
      gateGeneration: this.gateGeneration, admitted: false,
    };
    this.active.set(context.history.requestId, context);
    this.emit('REQUEST_STARTED', context);
    let outcome: LogicalResult['outcome'];
    let reason: string | undefined;
    try {
      if (this.management || this.stopped) throw new Error(this.stopped ? 'engine-stopped' : 'maintenance');
      if (this.active.size > 100) throw new Error('engine-capacity');
      // fire() synchronously acquires Opossum's exclusive pendingClose gate.
      await this.breaker.fire(context);
      outcome = 'success';
    } catch (error) {
      reason = error instanceof Error ? error.message : 'unknown-failure';
      outcome = context.admitted ? 'failure' : 'rejected';
      if (outcome === 'rejected') {
        this.counters.rejected++;
        this.emit('REQUEST_REJECTED', context, { reason });
      }
    }
    const finishedAt = Date.now();
    context.history.finishedAt = finishedAt;
    context.history.outcome = outcome;
    context.history.reason = reason;
    if (outcome !== 'rejected') {
      this.counters.completed++;
      if (outcome === 'success') this.counters.succeeded++; else this.counters.failed++;
      // Old instance completions remain lifetime outcomes, but cannot poison
      // the post-opening gate generation or close/consume someone else's probe.
      if (context.gateGeneration === this.gateGeneration || this.state !== 'CLOSED') {
        const bucket = this.ledger.get(finishedAt) ?? { completed: 0, failed: 0 };
        bucket.completed++;
        if (outcome === 'failure') bucket.failed++;
        this.ledger.set(finishedAt, bucket);
        const rolling = this.rolling();
        if (context.gateGeneration === this.gateGeneration && this.state === 'CLOSED' && rolling.completed >= this.policyValue.minimumVolume &&
            rolling.failed * 100 >= rolling.completed * this.policyValue.errorThresholdPercentage) {
          this.transitionRequest = context;
          try { this.breaker.open(); } finally { this.transitionRequest = null; }
        }
      }
    }
    this.emit('REQUEST_FINISHED', context, {
      reason: reason ?? outcome, durationMs: finishedAt - startedAt,
      status: context.history.attempts.at(-1)?.status, index: context.history.attempts.length,
    });
    this.active.delete(context.history.requestId);
    this.finished.push(context.history);
    if (this.finished.length > 200) this.finished.shift();
    return { requestId: context.history.requestId, outcome, reason, attempts: context.history.attempts.length, durationMs: finishedAt - startedAt };
  }
  private remaining(context: Operation) { return context.monotonicDeadline - performance.now(); }
  private async action(context: Operation) {
    context.admitted = true;
    if (context.history.probe) this.probe = context;
    const retries = context.history.probe ? 0 : this.policyValue.retries;
    for (let index = 1; index <= retries + 1; index++) {
      if (this.stopped) throw new AttemptError('engine-stopped', false);
      if (this.remaining(context) <= 0) throw new AttemptError('operation-deadline', false);
      try {
        await this.attempt(context, index);
        return;
      } catch (error) {
        if (!(error instanceof AttemptError) || !error.retryable || index > retries) throw error;
        const remaining = this.remaining(context);
        if (remaining <= 0) throw new AttemptError('operation-deadline', false);
        const configuredBackoffMs = this.policyValue.backoffMs * 2 ** (index - 1);
        const retryFits = configuredBackoffMs < remaining;
        const backoffMs = Math.min(configuredBackoffMs, remaining);
        const waitUntil = context.monotonicDeadline - remaining + backoffMs;
        this.emit('RETRY_SCHEDULED', context, { index: index + 1, backoffMs, reason: error.message });
        // A timer wake is not proof that the monotonic wait has elapsed.
        // A clipped wait reaches the deadline; it never authorizes a retry.
        do {
          await new Promise<void>(resolve => {
            const timer = setTimeout(() => {
              clearTimeout(timer);
              this.sleeps.delete(timer);
              resolve();
            }, Math.max(0, Math.ceil(waitUntil - performance.now())));
            this.sleeps.set(timer, resolve);
          });
          if (this.stopped) throw new AttemptError('engine-stopped', false);
        } while (performance.now() < waitUntil);
        if (!retryFits || this.remaining(context) <= 0) throw new AttemptError('operation-deadline', false);
        this.emit('RETRY_STARTED', context, { index: index + 1, backoffMs });
      }
    }
  }
  private async attempt(context: Operation, index: number) {
    const attempt: AttemptHistory = { attemptId: randomUUID(), index, startedAt: Date.now() };
    context.history.attempts.push(attempt);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeoutMs = Math.min(this.policyValue.attemptTimeoutMs, this.remaining(context));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, Math.ceil(timeoutMs)));
    this.emit('ATTEMPT_STARTED', context, { attemptId: attempt.attemptId, index });
    try {
      const response = await fetch(`${this.externalUrl}/work`, {
        signal: controller.signal,
        headers: { 'x-request-id': context.history.requestId, 'x-attempt-id': attempt.attemptId },
      });
      attempt.status = response.status;
      // Keep the same signal and timer through the ENTIRE response body.
      const reader = response.body?.getReader();
      let bytes = 0;
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 65536) {
              controller.abort();
              throw new AttemptError('upstream-body-too-large', false, response.status);
            }
          }
        } finally { reader.releaseLock(); }
      }
      if (!response.ok) throw new AttemptError(`HTTP ${response.status}`, response.status >= 500, response.status);
      attempt.outcome = 'success';
      this.emit('ATTEMPT_SUCCEEDED', context, {
        attemptId: attempt.attemptId, index, status: response.status, durationMs: Date.now() - attempt.startedAt,
      });
    } catch (error) {
      const reason = timedOut ? (this.remaining(context) <= 1 ? 'operation-deadline' : 'attempt-timeout')
        : error instanceof Error ? error.message : 'network-error';
      attempt.outcome = timedOut ? 'timeout' : 'failure';
      attempt.reason = reason;
      this.emit(timedOut ? 'ATTEMPT_TIMEOUT' : 'ATTEMPT_FAILED', context, {
        attemptId: attempt.attemptId, index, reason, status: attempt.status, durationMs: Date.now() - attempt.startedAt,
      });
      if (error instanceof AttemptError && !timedOut) throw error;
      const known4xx = attempt.status !== undefined && attempt.status >= 400 && attempt.status < 500;
      throw new AttemptError(reason, !this.stopped && !known4xx, attempt.status);
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      attempt.finishedAt = Date.now();
    }
  }
  private rolling() {
    const cutoff = Date.now() - this.policyValue.rollingWindowMs;
    let completed = 0;
    let failed = 0;
    for (const [timestamp, bucket] of this.ledger) {
      if (timestamp <= cutoff) this.ledger.delete(timestamp);
      else { completed += bucket.completed; failed += bucket.failed; }
    }
    return { completed, failed };
  }
  snapshot(): Snapshot {
    const rolling = this.rolling();
    return {
      kind: 'snapshot', epoch: this.journal.generation, cursor: this.journal.cursor, serverTime: Date.now(),
      state: this.state, openedAt: this.openedAt, recoveryAt: this.recoveryAt, policy: this.policy,
      metrics: {
        ...this.counters, active: this.active.size, rollingCompleted: rolling.completed,
        rollingFailed: rolling.failed, errorPercentage: rolling.completed ? rolling.failed / rolling.completed * 100 : 0,
      },
      histories: structuredClone([...this.finished, ...[...this.active.values()].map(item => item.history)]),
      events: this.journal.events, external: structuredClone(this.external),
      externalObservedAt: this.externalObservedAt, externalError: this.externalError,
    };
  }
  configure(value: unknown): Policy {
    this.assertIdle();
    const next = validatePolicyPatch(value, this.policyValue);
    this.breaker.shutdown();
    this.policyValue = next;
    this.gateGeneration++;
    this.ledger.clear();
    this.openedAt = this.recoveryAt = null;
    this.breaker = this.createBreaker();
    this.emit('CIRCUIT_CLOSED', null, { reason: 'policy-replaced' });
    return this.policy;
  }
  private assertIdle() {
    if (this.active.size || this.management || this.stopped) throw new ConflictError('Engine work or management is active');
  }
  private async proxy<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(`${this.externalUrl}${path}`, {
        method, signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) throw new ConflictError('Upstream work is active');
        throw new ProxyError(`Upstream HTTP ${response.status}`);
      }
      return result as T;
    } catch (error) {
      if (error instanceof ConflictError || error instanceof ProxyError) throw error;
      throw new ProxyError(error instanceof Error ? error.message : 'upstream-unavailable');
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  async refreshExternal(): Promise<ExternalSnapshot | null> {
    const revision = this.externalRevision;
    const ticket = ++this.refreshTicket;
    try {
      const [config, metrics] = await Promise.all([
        this.proxy<ExternalConfig>('/config'), this.proxy<ExternalMetrics>('/metrics'),
      ]);
      if (revision === this.externalRevision && ticket === this.refreshTicket) {
        this.external = { config, metrics };
        this.externalObservedAt = Date.now();
        this.externalError = undefined;
      }
    } catch (error) {
      if (revision === this.externalRevision && ticket === this.refreshTicket) {
        this.external = null;
        this.externalObservedAt = null;
        this.externalError = error instanceof Error ? error.message : 'upstream-unavailable';
      }
    }
    return structuredClone(this.external);
  }
  async configureExternal(value: unknown): Promise<ExternalConfig> {
    this.assertIdle();
    this.management = true;
    this.externalRevision++;
    try {
      const current = await this.proxy<ExternalConfig>('/config');
      const next = validateExternalPatch(value, current);
      const config = await this.proxy<ExternalConfig>('/config', 'PATCH', next);
      this.externalRevision++;
      await this.refreshExternal();
      return config;
    } finally { this.management = false; }
  }
  async reset(): Promise<Snapshot> {
    this.assertIdle();
    this.management = true;
    this.externalRevision++;
    try {
      const external = await this.proxy<ExternalSnapshot>('/reset', 'POST', {});
      this.externalRevision++;
      this.external = external;
      this.externalObservedAt = Date.now();
      this.externalError = undefined;
      this.breaker.shutdown();
      this.policyValue = { ...DEFAULT_POLICY };
      this.gateGeneration++;
      this.ledger.clear();
      this.finished = [];
      this.counters = { completed: 0, succeeded: 0, failed: 0, rejected: 0 };
      this.openedAt = this.recoveryAt = null;
      this.breaker = this.createBreaker();
      this.journal.reset();
      return this.snapshot();
    } finally { this.management = false; }
  }
  events(cursor?: string, heartbeatMs = 15000): Observable<MessageEvent> {
    return new Observable(subscriber => {
      let disposed = false;
      let subscription: { unsubscribe(): void } | undefined;
      void this.refreshExternal().then(() => {
        if (disposed) return;
        if (this.stopped) subscriber.complete();
        else subscription = this.journal.stream(cursor, heartbeatMs).subscribe(subscriber);
      });
      return () => { disposed = true; subscription?.unsubscribe(); };
    });
  }
  onModuleDestroy() { this.shutdown(); }
  shutdown() {
    this.stopped = true;
    this.breaker.shutdown();
    this.journal.close();
    for (const controller of this.controllers) controller.abort();
    for (const [timer, resolve] of this.sleeps) { clearTimeout(timer); resolve(); }
    this.sleeps.clear();
  }
}
