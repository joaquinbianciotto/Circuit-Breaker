export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
export type EventType =
  | 'REQUEST_STARTED' | 'ATTEMPT_STARTED' | 'ATTEMPT_SUCCEEDED'
  | 'ATTEMPT_FAILED' | 'ATTEMPT_TIMEOUT' | 'RETRY_SCHEDULED' | 'RETRY_STARTED'
  | 'CIRCUIT_OPENED' | 'CIRCUIT_HALF_OPEN' | 'CIRCUIT_CLOSED'
  | 'REQUEST_REJECTED' | 'REQUEST_FINISHED';

export interface Policy {
  attemptTimeoutMs: number;
  retries: number;
  backoffMs: number;
  operationDeadlineMs: number;
  errorThresholdPercentage: number;
  minimumVolume: number;
  rollingWindowMs: number;
  recoveryMs: number;
}
export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  attemptTimeoutMs: 800, retries: 2, backoffMs: 200,
  operationDeadlineMs: 3000, errorThresholdPercentage: 50,
  minimumVolume: 4, rollingWindowMs: 20000, recoveryMs: 7000,
});
export type ExternalMode = 'normal' | 'slow' | 'fail' | 'intermittent';
export interface ExternalConfig {
  mode: ExternalMode;
  latencyMs: number;
  errorStatus: number;
  failureRate: number;
  intermittent: 'alternating' | 'probability';
}
export const DEFAULT_EXTERNAL_CONFIG: Readonly<ExternalConfig> = Object.freeze({
  mode: 'normal', latencyMs: 0, errorStatus: 503,
  failureRate: 0.5, intermittent: 'alternating',
});
export interface UpstreamLog {
  requestId: string | null;
  attemptId: string | null;
  receivedAt: number;
  finishedAt?: number;
  outcome: 'active' | 'completed' | 'cancelled';
  status?: number;
}
export interface ExternalMetrics {
  received: number;
  completed: number;
  cancelled: number;
  active: number;
  logs: UpstreamLog[];
}
export interface ExternalSnapshot { config: ExternalConfig; metrics: ExternalMetrics }
export interface EngineEvent {
  id: string;
  sequence: number;
  epoch: string;
  type: EventType;
  timestamp: number;
  state: CircuitState;
  requestId: string | null;
  attemptId?: string;
  durationMs?: number;
  reason?: string;
  status?: number;
  index?: number;
  backoffMs?: number;
  deadlineAt?: number;
  probe?: boolean;
}
export type Outcome = 'success' | 'failure' | 'rejected';
export interface AttemptHistory {
  attemptId: string;
  index: number;
  startedAt: number;
  finishedAt?: number;
  status?: number;
  outcome?: 'success' | 'failure' | 'timeout';
  reason?: string;
}
export interface RequestHistory {
  requestId: string;
  startedAt: number;
  deadlineAt: number;
  probe: boolean;
  attempts: AttemptHistory[];
  finishedAt?: number;
  outcome?: Outcome;
  reason?: string;
}
export interface LogicalResult {
  requestId: string;
  outcome: Outcome;
  attempts: number;
  durationMs: number;
  reason?: string;
}
export interface EngineMetrics {
  completed: number;
  succeeded: number;
  failed: number;
  rejected: number;
  active: number;
  rollingCalls: number;
  rollingCompleted: number;
  rollingFailed: number;
  errorPercentage: number;
}
export interface Snapshot {
  kind: 'snapshot';
  epoch: string;
  cursor: string;
  serverTime: number;
  state: CircuitState;
  openedAt: number | null;
  recoveryAt: number | null;
  policy: Policy;
  metrics: EngineMetrics;
  histories: RequestHistory[];
  events: EngineEvent[];
  external: ExternalSnapshot | null;
  externalObservedAt: number | null;
  externalError?: string;
}
// Snapshots are authoritative control messages, not fabricated engine events.
export interface SnapshotMessage {
  kind: 'snapshot';
  reason: 'initial' | 'expired' | 'generation' | 'invalid' | 'reset';
  snapshot: Snapshot;
}
export interface BatchResponse { results: LogicalResult[] }
export interface ApiError { statusCode: number; message: string }

export class ValidationError extends Error {}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}
export function validateCount(value: unknown): number {
  const data = object(value);
  if (Object.keys(data).some(key => key !== 'count')) throw new ValidationError('Unknown request field');
  return integer(data.count, 1, 10, 'count');
}
export function validatePolicyPatch(value: unknown, current: Policy): Policy {
  const data = object(value);
  const ranges: Record<keyof Policy, [number, number]> = {
    attemptTimeoutMs: [10, 30000], retries: [0, 2], backoffMs: [0, 5000],
    operationDeadlineMs: [10, 90000], errorThresholdPercentage: [1, 100],
    minimumVolume: [1, 10000], rollingWindowMs: [100, 300000], recoveryMs: [20, 60000],
  };
  const result = { ...current };
  for (const [key, val] of Object.entries(data)) {
    if (!Object.hasOwn(ranges, key)) throw new ValidationError(`Unknown policy field: ${key}`);
    const field = key as keyof Policy;
    result[field] = integer(val, ...ranges[field], field);
  }
  return result;
}
export function validateExternalPatch(value: unknown, current: ExternalConfig): ExternalConfig {
  const data = object(value);
  const result = { ...current };
  for (const [key, val] of Object.entries(data)) {
    switch (key) {
      case 'mode':
        if (!['normal', 'slow', 'fail', 'intermittent'].includes(String(val)) || typeof val !== 'string')
          throw new ValidationError('Invalid mode');
        result.mode = val as ExternalMode; break;
      case 'intermittent':
        if (val !== 'alternating' && val !== 'probability') throw new ValidationError('Invalid intermittent strategy');
        result.intermittent = val; break;
      case 'latencyMs': result.latencyMs = integer(val, 0, 30000, key); break;
      case 'errorStatus': result.errorStatus = integer(val, 400, 599, key); break;
      case 'failureRate':
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1)
          throw new ValidationError('failureRate must be finite from 0 to 1');
        result.failureRate = val; break;
      default: throw new ValidationError(`Unknown external field: ${key}`);
    }
  }
  return result;
}
