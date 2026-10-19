import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Snapshot } from '@resilience/contracts';
import { attemptTimer, recoveryTimer, shortId, STAGE_MS, type Journey, type Route } from './model';
import { CONDUCTORS, REDUCED_POSITION, STAGE_ORIGIN, WAIT_POINT } from './topology';
import type { ClockListener } from './useLab';

export const PARTS = {
  gate: { title: '01 / Admission contacts', text: 'One breaker wraps a whole logical operation. CLOSED admits; OPEN rejects before HTTP. Work already admitted can still finish.' },
  timeout: { title: '02 / Attempt timeout', text: 'Each real HTTP attempt has its own abort deadline, clamped to the operation budget. Zero means awaiting an event, not a fabricated timeout.' },
  retry: { title: '03 / Retry feedback & WAIT', text: 'A retry stays inside the same logical operation. The identified signal parks during real backoff, then returns directly to HTTP—not through the breaker.' },
  probe: { title: '04 / Controlled probe', text: 'After the actual HALF_OPEN event, one operation can probe with one attempt and no retries. Concurrent arrivals reject. Only its outcome controls recovery.' },
  rejection: { title: '05 / Rejection shunt', text: 'An OPEN, occupied probe, maintenance or capacity rejection terminates at the inlet shunt. It creates no upstream HTTP attempt.' },
} as const;
export type Part = keyof typeof PARTS;
const colors: Record<Route, string> = {
  inlet: '#7bdbe3', http: '#7bdbe3', retry: '#e6b975', wait: '#e6b975',
  success: '#94d9b4', failure: '#ec8b88', reject: '#ec8b88',
};
interface Props {
  snapshot: Snapshot;
  journeys: Journey[];
  focus?: boolean;
  selected: string | null;
  inspect: Part;
  onInspect: (part: Part) => void;
  onSelect: (id: string) => void;
  subscribe: (listener: ClockListener) => () => void;
  onVisibility: (visible: boolean) => void;
}

export function Machine({ snapshot, journeys, focus = false, selected, inspect, onInspect, onSelect, subscribe, onVisibility }: Props) {
  const root = useRef<SVGSVGElement>(null);
  const paths = useRef(new Map<Route, SVGPathElement>());
  const waitDistance = useRef(0);
  const signals = useRef(new Map<string, SVGGElement>());
  const timerValue = useRef<SVGTextElement>(null);
  const timerNeedle = useRef<SVGLineElement>(null);
  const timerState = useRef<SVGTextElement>(null);
  const recoveryValue = useRef<SVGTextElement>(null);
  const visible = useRef(true);
  const [reduced, setReduced] = useState(() =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const histories = journeys.map(journey => journey.history);
  const watched = snapshot.histories.find(item => item.requestId === selected)
    ?? snapshot.histories.findLast(item => item.finishedAt === undefined) ?? snapshot.histories.at(-1);
  const closed = snapshot.state === 'CLOSED';
  const probe = snapshot.state === 'HALF_OPEN';
  const contactColor = closed ? 'var(--cyan)' : probe ? 'var(--amber)' : 'var(--red)';

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    const observer = new IntersectionObserver(entries => {
      visible.current = entries[0]?.isIntersecting ?? true;
      onVisibility(visible.current);
    });
    if (root.current) observer.observe(root.current);
    return () => { media.removeEventListener('change', update); observer.disconnect(); };
  }, [onVisibility]);

  useEffect(() => subscribe(store => {
    if (!store.view || !visible.current || document.hidden) return;
    const now = store.clock;
    for (let lane = 0; lane < histories.length; lane++) {
      const history = histories[lane];
      const group = signals.current.get(history.requestId);
      if (!group) continue;
      const journey = store.journeys.find(item => item.history.requestId === history.requestId);
      if (!journey) continue;
      const stage = journey.stages[0];
      const route = stage.route;
      const path = paths.current.get(route === 'wait' ? 'retry' : route);
      // Stage time is visual only; timers below still use authoritative timestamps.
      const phase = reduced ? (route === 'inlet' ? 0 : 1)
        : Math.min(1, route === 'inlet' ? Math.max(0, journey.elapsed - 100) / (STAGE_MS.inlet - 100)
          : journey.elapsed / (STAGE_MS[route] - (route === 'wait' ? 80
            : ['success', 'failure', 'reject'].includes(route) ? 120 : 0)));
      const length = path?.getTotalLength() ?? 0;
      const feedback = paths.current.get('retry');
      if (!waitDistance.current && feedback) {
        let closest = Infinity;
        const total = feedback.getTotalLength();
        for (let distance = 0; distance <= total; distance += 1) {
          const location = feedback.getPointAtLength(distance);
          const delta = Math.hypot(location.x - WAIT_POINT.x, location.y - WAIT_POINT.y);
          if (delta < closest) { closest = delta; waitDistance.current = distance; }
        }
      }
      group.style.color = history.probe && (route === 'http' || route === 'inlet') ? colors.retry : colors[route];
      group.dataset.route = route;
      group.dataset.stageRoute = route;
      group.dataset.attemptId = stage.attemptId ?? '';
      group.dataset.attemptIndex = String(stage.index ?? 0);
      group.dataset.phase = phase.toFixed(3);
      const point = (progress: number) => {
        if (reduced) return REDUCED_POSITION[route];
        const bounded = Math.max(0, progress);
        const distance = route === 'wait' ? waitDistance.current * bounded
          : route === 'retry' ? waitDistance.current + (length - waitDistance.current) * bounded
          : bounded * length;
        return path?.getPointAtLength(distance) ?? { x: 310, y: 300 };
      };
      const circles = group.querySelectorAll<SVGCircleElement>('circle');
      circles.forEach((circle, index) => {
        const position = point(phase - index * 0.025);
        circle.setAttribute('cx', String(position.x));
        circle.setAttribute('cy', String(position.y));
        circle.style.opacity = index === 0 ? '1' : reduced || route === 'wait' ? '0' : String(0.35 / index);
      });
      const position = point(phase);
      const label = group.querySelector('text');
      if (label) {
        label.setAttribute('x', String(position.x));
        label.setAttribute('y', String(position.y - 16 - (lane % 10) * 15));
      }
    }
    if (watched && watched.attempts.length) {
      const timer = attemptTimer(watched, store.view.policy, now);
      const attempt = watched.attempts.at(-1);
      const finished = attempt?.finishedAt !== undefined;
      const elapsed = finished ? attempt.finishedAt! - attempt.startedAt : 0;
      if (timerValue.current) timerValue.current.textContent = `${Math.ceil(finished ? elapsed : timer.remaining)} ms`;
      if (timerState.current) timerState.current.textContent = timer.outcome === 'active' && !timer.remaining
        ? 'AWAIT EVENT' : `${timer.outcome.toUpperCase()}${finished ? ' · ELAPSED' : ''}`;
      if (timerNeedle.current) timerNeedle.current.setAttribute('transform', `rotate(${-135 + (timer.outcome === 'timeout' ? 1 : timer.fraction) * 270} 676 175)`);
    } else {
      if (timerValue.current) timerValue.current.textContent = '— ms';
      if (timerState.current) timerState.current.textContent = 'IDLE';
      if (timerNeedle.current) timerNeedle.current.setAttribute('transform', 'rotate(-135 676 175)');
    }
    if (recoveryValue.current) {
      const remaining = recoveryTimer(store.view, now);
      recoveryValue.current.textContent = store.view.state === 'OPEN'
        ? remaining ? `${(remaining / 1000).toFixed(1)} s to probe` : 'AWAIT HALF_OPEN'
        : store.view.state === 'HALF_OPEN' ? 'SINGLE PROBE' : '';
    }
  }), [subscribe, journeys, watched, reduced]);

  const partProps = (part: Part) => ({
    role: 'button', tabIndex: 0, 'aria-label': PARTS[part].title,
    'aria-pressed': inspect === part, 'data-testid': `inspect-${part}`,
    className: `inspectable ${inspect === part ? 'inspected' : ''}`,
    onMouseEnter: () => onInspect(part), onClick: () => onInspect(part),
    onFocus: () => onInspect(part),
    onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onInspect(part); }
    },
  });
  return <svg ref={root} viewBox={focus ? '40 110 1060 530' : '0 0 1120 740'} className="machine" data-testid="machine"
    data-state={snapshot.state} data-epoch={snapshot.epoch} data-reduced-motion={reduced} aria-labelledby="machine-title machine-description">
    <title id="machine-title">HTTP resilience protection instrument — {snapshot.state}</title>
    <desc id="machine-description">A single admission gate feeds real HTTP attempts. A timeout dial measures the selected attempt; retry feedback parks at WAIT before re-entering HTTP. Separate branches terminate success, failure and rejection. Gate state and timers are live observations; each request retains minimum visible journey stages.</desc>
    <defs>
      <pattern id="engineering-grid" width="28" height="28" patternUnits="userSpaceOnUse">
        <path d="M28 0 H0 V28" fill="none" stroke="#acbbc8" strokeOpacity=".045" strokeWidth="1" />
      </pattern>
      <filter id="signal-glow" x="-100%" y="-100%" width="300%" height="300%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
    </defs>
    <rect x={focus ? 41 : 1} y={focus ? 111 : 1} width={focus ? 1058 : 1118} height={focus ? 528 : 738} rx="12" className="plate" />
    <rect x={focus ? 42 : 18} y={focus ? 112 : 18} width={focus ? 1056 : 1084} height={focus ? 526 : 704} fill="url(#engineering-grid)" />
    {!focus && <g>
    {[ [22, 22], [1098, 22], [22, 718], [1098, 718] ].map(([x, y]) => <g key={`${x}-${y}`} className="screw">
      <circle cx={x} cy={y} r="5" /><path d={`M${x - 2} ${y + 2} l4 -4`} />
    </g>)}
    <text x="48" y="56" className="svg-kicker">FIG. 01 / PROTECTION CIRCUIT</text>
    <text x="48" y="90" className="svg-title">The resilience machine</text>
    <text x="48" y="119" className="svg-secondary">One logical operation. Bounded HTTP attempts.</text>
    <text x="1070" y="56" textAnchor="end" className="svg-kicker">RL—01 · v0.1</text>
    <text x="1070" y="88" textAnchor="end" className="svg-secondary">REAL HTTP / OBSERVED JOURNEYS</text>
    <path d="M48 143 H1072" className="hairline" />
    </g>}

    <g className="conductors">
      {(Object.entries(CONDUCTORS) as [Exclude<Route, 'wait'>, string][]).map(([route, d]) =>
        <path key={route} ref={element => { if (element) paths.current.set(route, element); }}
          id={`route-${route}`} data-route={route} d={d}
          className={`conductor conductor-${route}`} />)}
      <path d="M86 292 V308 M974 228 V244 M974 378 V394 M974 604 V620" className="terminal-bars" />
      <circle cx="256" cy="300" r="4" /><circle cx="800" cy="300" r="4" />
    </g>
    <text x="86" y="259" className="svg-label">REQUEST IN</text>
    <circle cx="86" cy="300" r="8" className="socket" />

    <g {...partProps('gate')} style={{ color: contactColor }}>
      <rect x="278" y="178" width="174" height="239" rx="10" className="hit-area" />
      <text x="365" y="208" textAnchor="middle" className="svg-label">CIRCUIT BREAKER</text>
      <text x="365" y="239" textAnchor="middle" className="state-value" data-testid="visual-state">{snapshot.state}</text>
      <path d="M310 300 L410 300" className={`contact-guide ${closed ? 'connected' : ''}`} />
      <path d={closed ? 'M310 300 L410 300' : probe ? 'M310 300 L410 300' : 'M310 300 L386 247'}
        className={`contact-lever ${probe ? 'probe-contact' : ''}`} data-testid="breaker-contact" />
      <circle cx="310" cy="300" r="9" className="contact-pivot" />
      <circle cx="410" cy="300" r="7" className="contact-pivot" />
      <path d="M363 325 V344 M351 332 H375" className="contact-spring" />
      <text ref={recoveryValue} data-testid="recovery-countdown" x="365" y="398" textAnchor="middle" className="svg-small">{closed ? 'ADMISSION ENABLED' : probe ? 'SINGLE PROBE / NO RETRY' : 'RECOVERY WAIT'}</text>
    </g>
    <g {...partProps('probe')}>
      <rect x="442" y="234" width="113" height="86" rx="8" className="hit-area" />
      <path d="M448 300 H552" className={`probe-mark ${probe ? 'enabled' : ''}`} />
      <path d="M488 275 l10 10 -10 10 M506 275 l10 10 -10 10" className="probe-symbol" />
      <text x="500" y="253" textAnchor="middle" className="svg-small">{probe ? 'ONE PROBE' : 'ADMITTED'}</text>
    </g>

    <g {...partProps('timeout')}>
      <rect x="587" y="149" width="178" height="112" rx="12" className="hit-area" />
      <circle cx="676" cy="175" r="53" className="dial-rim" />
      <circle cx="676" cy="175" r="45" className="dial-face" />
      {Array.from({ length: 13 }, (_, index) => <line key={index} x1="676" y1="129" x2="676" y2={index % 3 === 0 ? '138' : '134'}
        transform={`rotate(${-135 + index * 22.5} 676 175)`} className="dial-tick" />)}
      <line ref={timerNeedle} x1="676" y1="175" x2="676" y2="139" className={`dial-needle ${watched?.attempts.at(-1)?.outcome === 'timeout' ? 'timed-out' : ''}`} />
      <circle cx="676" cy="175" r="4" className="dial-hub" />
      <text ref={timerValue} data-testid="attempt-timer" x="676" y="207" textAnchor="middle" className="svg-readout">— ms</text>
      <text x="593" y="175" textAnchor="end" className="svg-small">TIMEOUT</text>
      <text x="593" y="199" textAnchor="end" className="svg-small">{snapshot.policy.attemptTimeoutMs} ms</text>
      <text ref={timerState} data-testid="attempt-timer-state" x="755" y="177" className="svg-small">IDLE</text>
      <path d="M676 228 V269" className="sense-wire" />
    </g>
    <g className={watched?.attempts.at(-1)?.outcome === 'timeout' ? 'attempt-assembly timeout-stop' : 'attempt-assembly'}>
      <use href="#route-http" className="http-winding" />
      <circle cx="552" cy="300" r="7" className="socket" />
      <circle cx="800" cy="300" r="7" className="socket" />
      <path d="M568 270 H768 M568 330 H768" className="assembly-rails" />
      <text x="674" y="365" textAnchor="middle" className="svg-label">HTTP ATTEMPT</text>
      <text x="674" y="447" textAnchor="middle" className="svg-small">{watched?.attempts.at(-1)?.outcome === 'timeout' ? 'ABORT OBSERVED · HTTP CANCELLED'
        : (watched?.attempts.at(-1)?.index ?? 0) > 1 ? `RETRY ${watched!.attempts.at(-1)!.index - 1} · SAME LOGICAL REQUEST`
        : watched?.probe ? ''
        : ''}</text>
    </g>

    <circle cx="974" cy="236" r="8" className="socket terminal-success" />
    <text x="886" y="206" className="svg-label success-text">SUCCESS</text>
    <circle cx="974" cy="386" r="8" className="socket terminal-failure" />
    <text x="886" y="356" className="svg-label failure-text">FAILURE</text>
    <g {...partProps('retry')}>
      <rect x="454" y="471" width="368" height="107" rx="10" className="hit-area" />
      <path d="M599 503 V537 M614 503 V537" className="capacitor" />
      <text x="610" y="492" textAnchor="middle" className="svg-label retry-text">WAIT / RETRY</text>
      <path d="M480 419 l-6 10 M480 419 l6 10" className="feedback-direction" />
      <text x="808" y="475" className="svg-small">5xx / network / abort</text>
    </g>
    <g {...partProps('rejection')}>
      <rect x="270" y="582" width="733" height="57" rx="8" className="hit-area" />
      <path d="M293 603 l10 18 M303 603 l-10 18" className="reject-symbol" />
      <circle cx="974" cy="612" r="8" className="socket terminal-failure" />
      <text x="877" y="598" className="svg-label failure-text">REJECT</text>
    </g>

    <g className="signals" aria-hidden="true">
      {journeys.map(({ history, stages }, lane) => {
        const stage = stages[0];
        const route = stage.route;
        const origin = reduced ? REDUCED_POSITION[route] : STAGE_ORIGIN[route];
        const trailStyle = reduced ? { opacity: 0 } : undefined;
        return <g key={history.requestId} ref={element => {
          if (element) signals.current.set(history.requestId, element); else signals.current.delete(history.requestId);
        }} style={{ color: history.probe && (route === 'http' || route === 'inlet') ? colors.retry : colors[route] }} data-testid="signal" data-route={route}
          data-probe={history.probe}
          data-lane={lane} data-stage-route={route}
          data-request-id={history.requestId} data-attempt-id={stage.attemptId ?? ''}
          data-attempt-index={stage.index ?? 0}>
          <circle cx={origin.x} cy={origin.y} r={selected === history.requestId ? 6 : 4} fill="currentColor" />
          <circle cx={origin.x} cy={origin.y} r="7" fill="currentColor" filter="url(#signal-glow)" style={trailStyle} />
          <circle cx={origin.x} cy={origin.y} r="3" fill="currentColor" style={trailStyle} />
          <circle cx={origin.x} cy={origin.y} r="2" fill="currentColor" style={trailStyle} />
          <text x={origin.x} y={origin.y - 16 - (lane % 10) * 15} className="signal-id">{shortId(history.requestId)}</text>
        </g>;
      })}
    </g>
    {!focus && <g>
    <path d="M48 652 H1072" className="hairline" />
    <text x="48" y="682" className="svg-small">OBSERVED STAGES</text>
    {journeys.slice(-4).map(({ history, stages }, index) => <g key={history.requestId} role="button" tabIndex={0}
      aria-label={`Trace request ${shortId(history.requestId)}`} className="trace-label"
      onClick={() => onSelect(history.requestId)} onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(history.requestId); }
      }}>
      <text x={260 + index * 203} y="681" className="svg-readout">{shortId(history.requestId)} · A{history.attempts.at(-1)?.index ?? '—'}</text>
      <text x={260 + index * 203} y="706" className="svg-small" style={{ fill: colors[stages[0].route] }}>
        {stages[0].route === 'wait'
          ? `WAIT → RETRY ${history.attempts.length}` : stages[0].route.toUpperCase()}
      </text>
    </g>)}
    </g>}
  </svg>;
}
