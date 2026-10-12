import { useState } from 'react';
import type { Snapshot } from '@resilience/contracts';
import { shortId } from './model';

const time = (timestamp: number) => new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false }) + `.${String(timestamp % 1000).padStart(3, '0')}`;
interface Props { snapshot: Snapshot; selected: string | null; onSelect: (id: string | null) => void }
export function Timeline({ snapshot, selected, onSelect }: Props) {
  const [filter, setFilter] = useState('all');
  const events = snapshot.events.filter(event => (!selected || event.requestId === selected || event.requestId === null) &&
    (filter === 'all' || (filter === 'attempts' ? event.type.startsWith('ATTEMPT_') : filter === 'gate' ? event.type.startsWith('CIRCUIT_') : event.type.startsWith('REQUEST_'))))
    .slice(-100).reverse();
  const histories = snapshot.histories.filter(history => !selected || history.requestId === selected).slice(-50).reverse();
  return <section className="record-section" aria-label="Authoritative event timeline and request history">
    <div className="record-heading">
      <div><span className="eyebrow">RECORDER / LIVE EVENTS</span><h2>Every attempt has a trace.</h2></div>
      <div className="record-filter">
        {selected && <button className="text-button" onClick={() => onSelect(null)}>Clear {shortId(selected)} ×</button>}
        <label htmlFor="event-filter" className="sr-only">Filter events</label>
        <select id="event-filter" value={filter} onChange={event => setFilter(event.target.value)}>
          <option value="all">All events</option><option value="requests">Logical operations</option><option value="attempts">HTTP attempts</option><option value="gate">Gate transitions</option>
        </select>
      </div>
    </div>
    <div className="records-grid">
      <div className="event-recorder">
        <div className="record-subheading"><h3>Event timeline</h3><span className="mono">last 100 / buffer 1000</span></div>
        <div className="event-scroll" tabIndex={0} aria-label="Scrollable event timeline" data-testid="event-timeline">
          <table>
            <thead><tr><th>Time</th><th>Observed event</th><th>Request / attempt</th></tr></thead>
            <tbody>{events.map(event => <tr key={event.id} data-event={event.type} data-event-id={event.id} data-request-id={event.requestId ?? ''}
              data-attempt-id={event.attemptId ?? ''} className={event.requestId === selected ? 'selected-row' : ''}>
              <td className="mono timestamp">{time(event.timestamp)}</td>
              <td><span className={`event-name ${event.type.includes('TIMEOUT') || event.type.includes('FAILED') || event.type.includes('REJECTED') ? 'failure-text' : event.type.includes('RETRY') || event.type.includes('HALF_OPEN') ? 'retry-text' : ''}`}>
                {event.type.replaceAll('_', ' ')}</span>
                <span className="event-detail">{event.status ? `HTTP ${event.status} · ` : ''}{event.backoffMs !== undefined ? `${Math.ceil(event.backoffMs)} ms backoff · ` : ''}{event.reason ?? ''}</span></td>
              <td>{event.requestId ? <button className="trace-button mono" title={event.requestId} onClick={() => onSelect(event.requestId)}>
                {shortId(event.requestId)}{event.index ? ` / A${event.index}` : ''}</button> : <span className="text-muted mono">global</span>}
                {event.attemptId && <span className="event-detail mono" title={event.attemptId}>{shortId(event.attemptId)}</span>}</td>
            </tr>)}</tbody>
          </table>
          {!events.length && <div className="empty-state">No observed events yet. Send a request to energize the instrument.</div>}
        </div>
      </div>
      <div className="history-recorder">
        <div className="record-subheading"><h3>Logical operations</h3><span className="mono">last 50 / retained 200</span></div>
        <div className="history-scroll" data-testid="request-history">
          {histories.map(history => <details className="request-record" key={history.requestId} data-request-id={history.requestId}>
            <summary>
              <span className="mono">{shortId(history.requestId)}{history.probe ? ' / PROBE' : ''}</span>
              <span className={`outcome outcome-${history.outcome ?? 'active'}`}>{history.outcome ?? 'active'}</span>
              <span className="mono history-count">{history.attempts.length} attempt{history.attempts.length === 1 ? '' : 's'}</span>
              <span className="mono history-duration">{history.finishedAt === undefined ? 'running' : `${history.finishedAt - history.startedAt} ms`}</span>
            </summary>
            <div className="history-body">
              <button className="text-button" onClick={() => onSelect(history.requestId)}>Trace this request in the machine ↗</button>
              <p className="mono full-id">{history.requestId}</p>
              <p>Started {time(history.startedAt)} · {history.reason ?? 'awaiting outcome'}</p>
              <ol>{history.attempts.map(attempt => <li key={attempt.attemptId}>
                <strong>A{attempt.index}</strong> · {attempt.outcome ?? 'active'}{attempt.status ? ` / HTTP ${attempt.status}` : ''}
                <span className="mono">{attempt.finishedAt === undefined ? 'running' : `${attempt.finishedAt - attempt.startedAt} ms`}</span>
                <small className="mono full-id">{attempt.attemptId}</small>
              </li>)}</ol>
              {!history.attempts.length && <p>No upstream HTTP attempt.</p>}
            </div>
          </details>)}
          {!histories.length && <div className="empty-state">One history per logical request—not per retry.</div>}
        </div>
      </div>
    </div>
  </section>;
}
