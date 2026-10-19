import { EventEmitter } from 'node:events';
import type { CircuitState, Policy } from '@resilience/contracts';
import type { Operation, PublishEvent } from './requests';

interface CircuitStatistics {
  fires: number;
  successes: number;
  failures: number;
}
interface Circuit extends EventEmitter {
  readonly opened: boolean;
  readonly halfOpen: boolean;
  readonly pendingClose: boolean;
  readonly stats: CircuitStatistics;
  fire(context: Operation): Promise<void>;
  open(): void;
  shutdown(): void;
}
const Opossum = require('opossum') as new (
  action: (context: Operation) => Promise<void>, options: Record<string, unknown>,
) => Circuit;

/** Native Opossum policy, simulator events and isolated recovery probes. */
export class CircuitBreaker {
  private breaker: Circuit;
  private openingReplacement = false;
  private failureContext: Operation | null = null;
  private probe: Operation | null = null;
  private openedAt: number | null = null;
  private recoveryAt: number | null = null;

  constructor(
    private policyValue: Policy,
    private readonly action: (context: Operation) => Promise<void>,
    private readonly emit: PublishEvent,
  ) {
    this.breaker = this.createBreaker();
  }

  get policy(): Policy { return { ...this.policyValue }; }
  get stats(): CircuitStatistics { return this.breaker.stats; }
  get state(): CircuitState {
    return this.breaker.halfOpen ? 'HALF_OPEN' : this.breaker.opened ? 'OPEN' : 'CLOSED';
  }
  get probeAvailable() { return this.state === 'HALF_OPEN' && this.breaker.pendingClose; }
  get status() { return { state: this.state, openedAt: this.openedAt, recoveryAt: this.recoveryAt }; }

  fire(context: Operation): Promise<void> {
    return this.breaker.fire(context);
  }

  configure(policy: Policy) {
    this.breaker.shutdown();
    this.policyValue = policy;
    this.failureContext = this.probe = null;
    this.openedAt = this.recoveryAt = null;
    this.breaker = this.createBreaker();
  }

  shutdown() { this.breaker.shutdown(); }

  private createBreaker(): Circuit {
    const breaker = new Opossum(context => {
      context.admitted = true;
      if (context.history.probe) this.probe = context;
      return this.action(context);
    }, {
      timeout: false, // Requests owns per-attempt HTTP cancellation and the total deadline.
      errorThresholdPercentage: this.policyValue.errorThresholdPercentage,
      volumeThreshold: this.policyValue.minimumVolume,
      resetTimeout: this.policyValue.recoveryMs,
      rollingCountTimeout: this.policyValue.rollingWindowMs,
      rollingCountBuckets: 1,
      rollingPercentilesEnabled: false,
      capacity: 100,
    });
    // Opossum emits failure before deciding whether to open; retain its request ID.
    breaker.on('failure', (_error: unknown, _durationMs: number, args: Operation[]) => {
      this.failureContext = args[0] ?? null;
    });
    breaker.on('open', () => {
      if (this.openingReplacement || breaker !== this.breaker) return;
      this.openedAt = Date.now();
      this.recoveryAt = this.openedAt + this.policyValue.recoveryMs;
      const context = this.failureContext ?? this.probe;
      this.emit('CIRCUIT_OPENED', context, { reason: context?.history.probe ? 'probe-failed' : 'error-threshold' });
      // Detach old actions: their late success/failure must not settle a newer probe.
      breaker.shutdown();
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
      this.emit('CIRCUIT_CLOSED', this.probe, { reason: 'probe-succeeded' });
      this.probe = null;
    });
    return breaker;
  }
}
