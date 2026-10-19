import { Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import {
  DEFAULT_POLICY, validatePolicyPatch,
  type Policy, type CircuitState, type EngineEvent, type Snapshot,
  type ExternalConfig, type ExternalSnapshot, type LogicalResult,
} from '@resilience/contracts';
import { CircuitBreaker } from './circuit-breaker';
import { ExternalApi, ConflictError } from './external-api';
import { Requests, type Operation, type PublishEvent } from './requests';
import { EventJournal } from './events';

export { ConflictError, ProxyError } from './external-api';

/** Workshop entrypoint: protect one logical operation, then expose its result. */
export class Engine {
  private readonly breaker: CircuitBreaker;
  private readonly requests: Requests;
  private readonly external: ExternalApi;
  private management = false;
  readonly journal: EventJournal;

  constructor(readonly externalUrl = 'http://localhost:3002', policy: Policy = { ...DEFAULT_POLICY }) {
    const validatedPolicy = validatePolicyPatch(policy, { ...DEFAULT_POLICY });
    this.journal = new EventJournal(() => this.snapshot());
    const emit: PublishEvent = (...args) => this.emit(...args);
    this.breaker = new CircuitBreaker(validatedPolicy, context => this.requests.perform(context), emit);
    this.requests = new Requests(externalUrl, this.breaker, emit);
    this.external = new ExternalApi(externalUrl);
  }

  get policy(): Policy { return this.breaker.policy; }
  get state(): CircuitState { return this.breaker.state; }

  async run(): Promise<LogicalResult> {
    const request = this.requests.start();
    // Una llamada al circuit breaker proteje toda la operacion, incluyendo retrys y timeout
    return this.breaker.fire(request)
      .then(() => this.requests.finish(request, 'success'))
      .catch(error => this.requests.finish(
        request,
        request.admitted ? 'failure' : 'rejected',
        error instanceof Error ? error.message : 'unknown-failure',
      ));
  }

  configure(value: unknown): Policy {
    this.assertIdle();
    this.breaker.configure(validatePolicyPatch(value, this.policy));
    this.emit('CIRCUIT_CLOSED', null, { reason: 'policy-replaced' });
    return this.policy;
  }

  snapshot(): Snapshot {
    const stats = this.breaker.stats;
    return {
      kind: 'snapshot', epoch: this.journal.generation, cursor: this.journal.cursor, serverTime: Date.now(),
      ...this.breaker.status, policy: this.policy,
      metrics: {
        ...this.requests.metrics, rollingCalls: stats.fires,
        rollingCompleted: stats.successes + stats.failures, rollingFailed: stats.failures,
        errorPercentage: stats.fires ? stats.failures / stats.fires * 100 : 0,
      },
      histories: this.requests.histories, events: this.journal.events, ...this.external.snapshot,
    };
  }

  refreshExternal(): Promise<ExternalSnapshot | null> { return this.external.refresh(); }

  async configureExternal(value: unknown): Promise<ExternalConfig> {
    this.assertIdle();
    this.management = true;
    try { return await this.external.configure(value); }
    finally { this.management = false; }
  }

  async reset(): Promise<Snapshot> {
    this.assertIdle();
    this.management = true;
    try {
      await this.external.reset();
      this.breaker.configure({ ...DEFAULT_POLICY });
      this.requests.reset();
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
        if (this.requests.isStopped) subscriber.complete();
        else subscription = this.journal.stream(cursor, heartbeatMs).subscribe(subscriber);
      });
      return () => { disposed = true; subscription?.unsubscribe(); };
    });
  }

  onModuleDestroy() { this.shutdown(); }
  shutdown() {
    this.breaker.shutdown();
    this.journal.close();
    this.requests.shutdown();
    this.external.shutdown();
  }

  private assertIdle() {
    if (this.requests.activeCount || this.management || this.requests.isStopped) throw new ConflictError('Engine work or management is active');
  }

  private emit(type: EngineEvent['type'], context: Operation | null, fields: Partial<EngineEvent> = {}) {
    this.journal.publish({
      type, timestamp: Date.now(), state: this.state,
      requestId: context?.history.requestId ?? null,
      ...(context ? { deadlineAt: context.history.deadlineAt, probe: context.history.probe } : {}),
      ...fields,
    });
  }
}
