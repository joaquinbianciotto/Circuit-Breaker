import { useEffect, useRef, useState } from 'react';
import type { ExternalConfig, Policy } from '@resilience/contracts';
import { api } from './api';
import { runDemo } from './demo';
import { Dock } from './Dock';
import { Machine, PARTS, type Part } from './Machine';
import { Timeline } from './Timeline';
import { useLab } from './useLab';
import { normalizeVisualSpeed, VISUAL_SPEEDS, type VisualSpeed } from './model';

export function App() {
  const [visualSpeed, setVisualSpeed] = useState<VisualSpeed>(1);
  const lab = useLab(visualSpeed);
  const [focus, setFocus] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [inspect, setInspect] = useState<Part>('gate');
  const [count, setCount] = useState(4);
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  const [demo, setDemo] = useState(false);
  const [demoStage, setDemoStage] = useState('');
  const demoController = useRef<AbortController | null>(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const focusButton = useRef<HTMLButtonElement>(null);
  const observedAt = useRef<HTMLSpanElement>(null);
  const live = lab.store.live;
  const view = lab.store.view;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; demoController.current?.abort(); };
  }, []);
  useEffect(() => { setSelected(null); }, [live?.epoch]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && focus) { setFocus(false); focusButton.current?.focus(); }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [focus]);
  useEffect(() => lab.subscribe(store => {
    if (observedAt.current && store.live) observedAt.current.textContent =
      `backend sample ${new Date(store.live.serverTime).toLocaleTimeString('en-GB')}`;
  }), [lab.subscribe]);

  async function perform(label: string, action: () => Promise<void>) {
    if (actionLock.current) throw new Error('A control action is already pending.');
    if (!lab.connected) throw new Error('Reconnect the event stream before changing the lab.');
    actionLock.current = true;
    setPending(label);
    setMessage('');
    lab.setError('');
    try {
      await action();
      if (mounted.current) setMessage(`${label} complete.`);
    } catch (error) {
      if (mounted.current) lab.setError((error as Error).message);
      throw error;
    } finally {
      actionLock.current = false;
      if (mounted.current) setPending('');
    }
  }
  const send = async (amount: number) => perform(`Sending ${amount} request${amount === 1 ? '' : 's'}`, async () => {
    const response = await api.send(amount);
    await lab.refresh();
    if (mounted.current) setMessage(response.results.map(result => `${result.requestId.slice(0, 8)}: ${result.outcome}`).join(' · '));
  });
  const configure = async (config: Partial<ExternalConfig>) => perform('Applying upstream configuration', async () => {
    await api.external(config);
    await lab.refresh();
  });
  const policy = async (policy: Policy) => perform('Applying protection policy', async () => {
    await api.policy(policy);
    await lab.refresh();
  });
  const reset = async () => perform('Resetting simulation', async () => {
    const snapshot = await api.reset();
    lab.restore(snapshot, 'reset');
  });
  const manual = (action: () => Promise<void>) => { void action().catch(() => { /* perform exposes the concrete error */ }); };
  const toggleDemo = () => {
    if (demoController.current) {
      demoController.current.abort();
      demoController.current = null;
      setDemo(false);
      setDemoStage('Stopped / already admitted operations are not cancelled');
      return;
    }
    const controller = new AbortController();
    demoController.current = controller;
    setDemo(true);
    void runDemo({ reset, configure, send: () => send(1), waitForProbe: lab.waitForProbe,
      stage: label => { if (mounted.current) setDemoStage(label); } }, controller.signal)
      .catch(error => {
        if (!controller.signal.aborted && mounted.current) {
          lab.setError(error.message);
          setDemoStage('Stopped / resolve the API error before restarting');
        }
      }).finally(() => {
        if (demoController.current === controller) { demoController.current = null; if (mounted.current) setDemo(false); }
      });
  };

  return <main className={`lab-shell ${focus ? 'focus-mode' : ''}`}>
    <header className="masthead">
      <a className="brand" href="#instrument" aria-label="Resilience Lab instrument"><span className="brand-mark" aria-hidden="true">R<span>↯</span></span><span>RESILIENCE<span className="brand-light"> LAB</span></span></a>
      <div className="masthead-note">AN INTERACTIVE STUDY OF HTTP PROTECTION</div>
      <div className="connection-label" data-testid="connection-state"><span className={`dot ${lab.connected ? 'green' : 'red'}`} />{lab.connected ? 'ENGINE CONNECTED' : 'ENGINE OFFLINE'}</div>
    </header>
    <div className="page-intro">
      <div><div className="eyebrow">SYSTEMS STUDY / 001</div><h1>Failure is part of the circuit.</h1><p>Watch real requests flow. See exactly where protection intervenes.</p></div>
      <div className="intro-spec mono">CIRCUIT BREAKER<br />TIMEOUT / RETRY<br /><span>AN OBSERVABLE MACHINE</span></div>
    </div>
    <section id="instrument" className="instrument-layout" aria-label="Protection lab">
      <div className="figure-column">
        <div className="figure-toolbar">
          <div className="live-readout"><span className="eyebrow">LIVE / OBSERVED JOURNEYS</span>
            <span id="visual-speed-help" className="visual-speed-help">Visual only; real HTTP timing is unchanged.</span>
          </div>
          <div className="visual-speed-control"><label htmlFor="visual-speed">Visual speed</label>
            <select id="visual-speed" data-testid="visual-speed" aria-describedby="visual-speed-help" value={visualSpeed}
              onChange={event => setVisualSpeed(normalizeVisualSpeed(Number(event.target.value)))}>
              {VISUAL_SPEEDS.map(rate => <option key={rate} value={rate}>{rate}×</option>)}
            </select>
          </div>
          <button ref={focusButton} className="tool-button focus-button" data-testid="focus-toggle" aria-pressed={focus}
            onClick={() => setFocus(!focus)}>{focus ? 'Exit Focus' : 'Focus View'} <span aria-hidden="true">{focus ? '↙' : '↗'}</span></button>
        </div>
        {view && live ? <Machine snapshot={view} journeys={lab.store.journeys} focus={focus} selected={selected} inspect={inspect} onInspect={setInspect} onSelect={setSelected} subscribe={lab.subscribe} onVisibility={lab.setVisible} />
          : <div className="machine-loading"><span className="eyebrow">FIG. 01 / STANDBY</span><h2>Connecting the instrument.</h2><p>Start the backend and upstream services. No synthetic requests are displayed.</p><button className="button" onClick={() => { void lab.refresh().catch(error => lab.setError(error.message)); }}>Retry Snapshot</button></div>}
        <div className="figure-footer">
          <div className="legend" aria-label="Signal legend"><span><i className="dot cyan" />Conducting</span><span><i className="dot green" />Success</span><span><i className="dot amber" />Retry / probe</span><span><i className="dot red" />Failure / reject</span></div>
          <div className="live-state mono" data-testid="live-state">LIVE GATE <strong className={live?.state === 'OPEN' ? 'failure-text' : live?.state === 'HALF_OPEN' ? 'retry-text' : 'success-text'}>{live?.state ?? '—'}</strong></div>
        </div>
        <div className="inspection-panel" data-testid="component-inspection">
          <div className="inspection-number">{PARTS[inspect].title.slice(0, 2)}</div>
          <div><h2>{PARTS[inspect].title.slice(5)}</h2><p>{PARTS[inspect].text}</p></div>
          <div className="inspection-hint mono">HOVER / SELECT<br />TAB TO INSPECT</div>
        </div>
        <div className="observation-note"><span>Live observations stay current. Minimum visible stages never change real HTTP timing.</span><span ref={observedAt} className="mono">backend sample —</span></div>
      </div>
      {!focus && live && <Dock snapshot={live} connected={lab.connected} pending={pending} message={message}
        count={count} onCount={setCount} demo={demo} demoStage={demoStage} actions={{
          send: amount => manual(() => send(amount)), external: patch => manual(() => configure(patch)),
          policy: value => manual(() => policy(value)), reset: () => manual(reset), demo: toggleDemo,
        }} />}
      {!focus && !live && <aside className="dock offline-dock"><span className="eyebrow">CONTROL DOCK / HELD</span><p>Controls become available after an authoritative snapshot and a connected event stream.</p></aside>}
    </section>
    {focus && <div className="focus-controls" aria-label="Minimal focus controls">
      <button className="button button-primary" disabled={!lab.connected || !!pending || demo} onClick={() => manual(() => send(1))}>Send Request</button>
      <label className="sr-only" htmlFor="focus-count">Focus batch count</label>
      <input id="focus-count" type="number" min={1} max={10} step={1} value={count} onChange={event => setCount(Math.min(10, Math.max(1, Number(event.target.value) || 1)))} />
      <button className="button" disabled={!lab.connected || !!pending || demo} onClick={() => manual(() => send(count))}>Send Batch</button>
      {demo && <button className="button stop-button" onClick={toggleDemo}>Stop Demo</button>}
    </div>}
    {lab.error && <p className="global-error" data-testid="api-error">{lab.error}</p>}
    {lab.store.notice && <p className="resync-notice" data-testid="resync-notice">{lab.store.notice}</p>}
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{lab.connected ? `Engine connected. Live gate ${live?.state}.` : 'Engine disconnected. Controls disabled.'} {lab.error} {pending}</div>
    {!focus && live && <Timeline snapshot={live} selected={selected} onSelect={setSelected} />}
    <footer className="page-footer"><span>RESILIENCE LAB / ENGINEERING SERIES</span><span>One breaker · real HTTP · no invented outcomes</span><span className="mono">RL—01 / 2026</span></footer>
  </main>;
}
