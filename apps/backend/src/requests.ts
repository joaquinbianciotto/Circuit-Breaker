import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  AttemptHistory, EngineEvent, LogicalResult, RequestHistory,
} from '@resilience/contracts';
import type { CircuitBreaker } from './circuit-breaker';

export interface Operation {
  history: RequestHistory;
  monotonicDeadline: number;
  admitted: boolean;
}
export type PublishEvent = (
  type: EngineEvent['type'], context: Operation | null, fields?: Partial<EngineEvent>,
) => void;

class AttemptError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number) { super(message); }
}

/** A logical HTTP request: attempts, deadlines, cancellation and observable history. */
export class Requests {
  private active = new Map<string, Operation>();
  private finished: RequestHistory[] = [];
  private counters = { completed: 0, succeeded: 0, failed: 0, rejected: 0 };
  private stopped = false;
  private controllers = new Set<AbortController>();
  private sleeps = new Map<NodeJS.Timeout, () => void>();

  constructor(
    private readonly externalUrl: string,
    private readonly circuit: CircuitBreaker,
    private readonly emit: PublishEvent,
  ) {}

  get activeCount() { return this.active.size; }
  get isStopped() { return this.stopped; }
  get metrics() { return { ...this.counters, active: this.active.size }; }
  get histories() { return structuredClone([...this.finished, ...[...this.active.values()].map(item => item.history)]); }
  private get policy() { return this.circuit.policy; }

  start(): Operation {
    const startedAt = Date.now();
    const context: Operation = {
      history: {
        requestId: randomUUID(), startedAt, deadlineAt: startedAt + this.policy.operationDeadlineMs,
        probe: this.circuit.probeAvailable, attempts: [],
      },
      monotonicDeadline: performance.now() + this.policy.operationDeadlineMs,
      admitted: false,
    };
    this.active.set(context.history.requestId, context);
    this.emit('REQUEST_STARTED', context);
    return context;
  }

  finish(context: Operation, outcome: LogicalResult['outcome'], reason?: string): LogicalResult {
    if (outcome === 'rejected') {
      this.counters.rejected++;
      this.emit('REQUEST_REJECTED', context, { reason });
    }
    const finishedAt = Date.now();
    context.history.finishedAt = finishedAt;
    context.history.outcome = outcome;
    context.history.reason = reason;
    if (outcome !== 'rejected') {
      this.counters.completed++;
      if (outcome === 'success') this.counters.succeeded++; else this.counters.failed++;
    }
    const durationMs = finishedAt - context.history.startedAt;
    this.emit('REQUEST_FINISHED', context, {
      reason: reason ?? outcome, durationMs,
      status: context.history.attempts.at(-1)?.status, index: context.history.attempts.length,
    });
    this.active.delete(context.history.requestId);
    this.finished.push(context.history);
    if (this.finished.length > 200) this.finished.shift();
    return { requestId: context.history.requestId, outcome, reason, attempts: context.history.attempts.length, durationMs };
  }

  async perform(context: Operation) {
    const retries = context.history.probe ? 0 : this.policy.retries;
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
        const configuredBackoffMs = this.policy.backoffMs * 2 ** (index - 1);
        const retryFits = configuredBackoffMs < remaining;
        const backoffMs = Math.min(configuredBackoffMs, remaining);
        const waitUntil = context.monotonicDeadline - remaining + backoffMs;
        this.emit('RETRY_SCHEDULED', context, { index: index + 1, backoffMs, reason: error.message });
        // Early timer wakes must not shorten the full backoff or authorize a late retry.
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

  reset() {
    this.finished = [];
    this.counters = { completed: 0, succeeded: 0, failed: 0, rejected: 0 };
  }

  shutdown() {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort();
    for (const [timer, resolve] of this.sleeps) { clearTimeout(timer); resolve(); }
    this.sleeps.clear();
  }

  private remaining(context: Operation) { return context.monotonicDeadline - performance.now(); }

  private async attempt(context: Operation, index: number) {
    const attempt: AttemptHistory = { attemptId: randomUUID(), index, startedAt: Date.now() };
    context.history.attempts.push(attempt);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeoutMs = Math.min(this.policy.attemptTimeoutMs, this.remaining(context));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, Math.ceil(timeoutMs)));
    this.emit('ATTEMPT_STARTED', context, { attemptId: attempt.attemptId, index });
    try {
      const response = await fetch(`${this.externalUrl}/work`, {
        signal: controller.signal,
        headers: { 'x-request-id': context.history.requestId, 'x-attempt-id': attempt.attemptId },
      });
      attempt.status = response.status;
      // The timeout covers headers AND full body consumption, bounded at 64 KiB.
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
}
