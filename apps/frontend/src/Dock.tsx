import { useEffect, useState } from 'react';
import {
  DEFAULT_EXTERNAL_CONFIG, validateExternalPatch, validatePolicyPatch,
  type ExternalConfig, type Policy, type Snapshot,
} from '@resilience/contracts';

export interface DockActions {
  send: (count: number) => void;
  external: (patch: Partial<ExternalConfig>) => void;
  policy: (policy: Policy) => void;
  reset: () => void;
  demo: () => void;
}
interface Props {
  snapshot: Snapshot;
  connected: boolean;
  pending: string;
  demo: boolean;
  demoStage: string;
  message: string;
  count: number;
  onCount: (count: number) => void;
  actions: DockActions;
}
const policyFields: { key: keyof Policy; label: string; min: number; max: number; unit: string }[] = [
  { key: 'attemptTimeoutMs', label: 'Attempt timeout', min: 10, max: 30000, unit: 'ms' },
  { key: 'retries', label: 'Extra retries', min: 0, max: 2, unit: 'max' },
  { key: 'backoffMs', label: 'Base backoff', min: 0, max: 5000, unit: 'ms' },
  { key: 'errorThresholdPercentage', label: 'Inclusive threshold', min: 1, max: 100, unit: '%' },
  { key: 'minimumVolume', label: 'Minimum completed', min: 1, max: 10000, unit: 'ops' },
  { key: 'rollingWindowMs', label: 'Rolling window', min: 100, max: 300000, unit: 'ms' },
  { key: 'recoveryMs', label: 'Recovery wait', min: 20, max: 60000, unit: 'ms' },
  { key: 'operationDeadlineMs', label: 'Operation deadline', min: 10, max: 90000, unit: 'ms' },
];

export function Dock({ snapshot, connected, pending, demo, demoStage, message, count, onCount, actions }: Props) {
  const [policy, setPolicy] = useState(snapshot.policy);
  const [external, setExternal] = useState<ExternalConfig>(snapshot.external?.config ?? { ...DEFAULT_EXTERNAL_CONFIG });
  const [policyDirty, setPolicyDirty] = useState(false);
  const [externalDirty, setExternalDirty] = useState(false);
  const [formError, setFormError] = useState('');
  const active = snapshot.histories.some(item => item.finishedAt === undefined);
  const disabled = !connected || !!pending || demo;
  const managementDisabled = disabled || active;
  useEffect(() => { if (!policyDirty) setPolicy(snapshot.policy); }, [snapshot.policy, policyDirty]);
  useEffect(() => { if (!externalDirty && snapshot.external) setExternal(snapshot.external.config); }, [snapshot.external, externalDirty]);
  useEffect(() => {
    setPolicyDirty(false);
    setExternalDirty(false);
    setPolicy(snapshot.policy);
    setExternal(snapshot.external?.config ?? { ...DEFAULT_EXTERNAL_CONFIG });
    setFormError('');
  }, [snapshot.epoch]);

  const validate = (action: () => void) => {
    try { action(); setFormError(''); } catch (error) { setFormError((error as Error).message); }
  };
  return <aside className="dock" aria-label="Real engine controls">
    <div className="dock-heading"><span className="eyebrow">CONTROL DOCK</span><span className="mono text-muted">REAL TIME</span></div>
    <section className="dock-section">
      <div className="section-label"><h2>Inject a signal</h2><span className="index-label">01</span></div>
      <p className="hint">Each send is a real logical operation.</p>
      <button className="button button-primary w-full" data-testid="send-request" disabled={disabled} onClick={() => actions.send(1)}>
        Send Request <span aria-hidden="true">↗</span>
      </button>
      <div className="batch-control">
        <label htmlFor="batch-count" className="sr-only">Number of requests</label>
        <input id="batch-count" data-testid="batch-count" type="number" min={1} max={10} step={1} value={count}
          disabled={disabled} onChange={event => onCount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} />
        <button className="button flex-1" data-testid="send-batch" disabled={disabled} onClick={() => actions.send(count)}>Send Multiple Requests</button>
      </div>
      <p className="hint">1–10 concurrent requests · default 4</p>
    </section>
    <section className="dock-section">
      <div className="section-label"><h2>Upstream behavior</h2><span className="index-label">02</span></div>
      <div className="preset-grid">
        <button className="preset" data-active={snapshot.external?.config.mode === 'normal'} disabled={managementDisabled}
          onClick={() => actions.external({ mode: 'normal', latencyMs: 260 })}><span className="dot cyan" />Normal Response<small>260 ms / 200</small></button>
        <button className="preset" data-active={snapshot.external?.config.mode === 'slow'} disabled={managementDisabled}
          onClick={() => actions.external({ mode: 'slow', latencyMs: 1500 })}><span className="dot amber" />Slow Response<small>1500 ms / timeout</small></button>
        <button className="preset" data-active={snapshot.external?.config.mode === 'fail'} disabled={managementDisabled}
          onClick={() => actions.external({ mode: 'fail', errorStatus: 503, latencyMs: 220 })}><span className="dot red" />Always Fail<small>220 ms / 503</small></button>
        <button className="preset" data-active={snapshot.external?.config.mode === 'intermittent'} disabled={managementDisabled}
          onClick={() => actions.external({ mode: 'intermittent', intermittent: 'alternating', latencyMs: 240 })}><span className="dot amber" />Intermittent Failure<small>alternating / retry</small></button>
      </div>
      <button className="button w-full recover-button" data-testid="recover-service" disabled={managementDisabled}
        onClick={() => actions.external({ mode: 'normal', latencyMs: 260 })}>Recover Service <span aria-hidden="true">↺</span></button>
      <p className="hint">Recovery changes upstream only; the real probe closes the gate.</p>
      <details className="editor" data-testid="external-editor">
        <summary>Custom external configuration</summary>
        <form onSubmit={event => { event.preventDefault(); validate(() => { actions.external(validateExternalPatch(external, external)); setExternalDirty(false); }); }}>
          <label className="field">Mode<select value={external.mode} disabled={managementDisabled}
            onChange={event => { setExternalDirty(true); setExternal({ ...external, mode: event.target.value as ExternalConfig['mode'] }); }}>
            <option value="normal">Normal</option><option value="slow">Slow</option><option value="fail">Always fail</option><option value="intermittent">Intermittent</option>
          </select></label>
          <label className="field">Latency <span className="unit">ms</span><input type="number" min={0} max={30000} step={1} required
            value={external.latencyMs} disabled={managementDisabled} onChange={event => { setExternalDirty(true); setExternal({ ...external, latencyMs: Number(event.target.value) }); }} /></label>
          <label className="field">Error status<input type="number" min={400} max={599} step={1} required
            value={external.errorStatus} disabled={managementDisabled} onChange={event => { setExternalDirty(true); setExternal({ ...external, errorStatus: Number(event.target.value) }); }} /></label>
          <label className="field">Intermittent strategy<select value={external.intermittent} disabled={managementDisabled}
            onChange={event => { setExternalDirty(true); setExternal({ ...external, intermittent: event.target.value as ExternalConfig['intermittent'] }); }}>
            <option value="alternating">Alternating (deterministic)</option><option value="probability">Probability (seeded)</option>
          </select></label>
          <label className="range-field">Failure probability <output>{Math.round(external.failureRate * 100)}%</output>
            <input aria-label="Failure probability" type="range" min={0} max={1} step={0.01} value={external.failureRate} disabled={managementDisabled}
              onChange={event => { setExternalDirty(true); setExternal({ ...external, failureRate: Number(event.target.value) }); }} />
          </label>
          <p className="hint">Probability applies only to the probability strategy.</p>
          <button className="button w-full" disabled={managementDisabled} type="submit">Apply External Configuration</button>
        </form>
      </details>
    </section>
    <section className="dock-section">
      <div className="section-label"><h2>Protection policy</h2><span className="index-label">03</span></div>
      <p className="policy-summary mono">{snapshot.policy.attemptTimeoutMs} ms · {snapshot.policy.retries} retries · ≥{snapshot.policy.errorThresholdPercentage}%</p>
      <details className="editor" data-testid="policy-editor">
        <summary>Edit all policy parameters</summary>
        <form onSubmit={event => { event.preventDefault(); validate(() => { actions.policy(validatePolicyPatch(policy, snapshot.policy)); setPolicyDirty(false); }); }}>
          {policyFields.map(field => <label className="field" key={field.key}>
            {field.label}<span className="unit">{field.unit}</span>
            <input type="number" name={field.key} data-testid={`policy-${field.key}`} min={field.min} max={field.max} step={1} required
              value={policy[field.key]} disabled={managementDisabled}
              onChange={event => { setPolicyDirty(true); setPolicy({ ...policy, [field.key]: Number(event.target.value) }); }} />
          </label>)}
          <p className="hint mono">Derived waits: {policy.backoffMs} / {policy.backoffMs * 2} ms</p>
          <p className="hint">Applying resets the rolling baseline and closes the gate. Lifetime history stays.</p>
          <button className="button w-full" disabled={managementDisabled} type="submit">Apply Policy</button>
        </form>
      </details>
    </section>
    <section className="dock-section automation">
      <button className={`button w-full ${demo ? 'stop-button' : ''}`} data-testid="auto-demo"
        disabled={!demo && (disabled || active)} onClick={actions.demo}>{demo ? 'Stop Auto Demo' : 'Start Auto Demo'} <span aria-hidden="true">{demo ? '■' : '▷'}</span></button>
      {demoStage && <p className="hint demo-stage">{demoStage}</p>}
      <p className="hint">Sequential real scenarios. Stop prevents future sends; admitted work finishes.</p>
      <button className="text-button" data-testid="reset-simulation" disabled={managementDisabled} onClick={actions.reset}>Reset Simulation</button>
    </section>
    {active && <p className="dock-notice">Management held until active operations finish.</p>}
    {(pending || message) && <p className="dock-notice" data-testid="mutation-status">{pending ? `${pending}…` : message}</p>}
    {formError && <p className="error-message" role="alert">{formError}</p>}
    {snapshot.externalError && <p className="error-message">Upstream observation unavailable: {snapshot.externalError}</p>}
  </aside>;
}
