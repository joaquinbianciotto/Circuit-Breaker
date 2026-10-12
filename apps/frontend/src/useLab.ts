import { useCallback, useEffect, useRef, useState } from 'react';
import type { EngineEvent, Snapshot, SnapshotMessage } from '@resilience/contracts';
import { api } from './api';
import { acceptSnapshot, advance, createStore, ingest, liveCatchUp, snapshotTicket, type Store } from './model';

export type ClockListener = (store: Store, target: number) => void;
export function useLab() {
  const model = useRef(createStore());
  const [store, setStore] = useState(model.current);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const settings = useRef({ speed, paused });
  settings.current = { speed, paused };
  const anchor = useRef({ server: 0, local: performance.now() });
  const listeners = useRef(new Set<ClockListener>());
  const observers = useRef(new Set<(store: Store) => void>());
  const alive = useRef(true);
  const fetchRevision = useRef(0);
  const targetTime = useCallback(() => Math.max(model.current.live?.serverTime ?? 0,
    anchor.current.server + performance.now() - anchor.current.local), []);
  const publish = useCallback((next: Store) => {
    if (!alive.current || next === model.current) return;
    model.current = next;
    setStore(next);
    for (const observer of observers.current) observer(next);
  }, []);
  const restore = useCallback((snapshot: Snapshot, reason: string, ticket?: ReturnType<typeof snapshotTicket>) => {
    const next = acceptSnapshot(model.current, snapshot, reason, ticket);
    if (next === model.current) return;
    anchor.current = { server: Math.max(snapshot.serverTime, targetTime()), local: performance.now() };
    publish(next);
  }, [publish, targetTime]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const ticket = snapshotTicket(model.current);
    const revision = ++fetchRevision.current;
    const snapshot = await api.snapshot(signal);
    if (alive.current && revision === fetchRevision.current) restore(snapshot, 'refresh', ticket);
  }, [restore]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refresh(controller.signal).catch(error => {
          if (!controller.signal.aborted) setError(String(error.message));
        });
      }, 120);
    };
    // Native EventSource owns reconnection and Last-Event-ID, including named snapshots.
    const source = new EventSource('/api/events');
    source.onopen = () => { setConnected(navigator.onLine); if (navigator.onLine) setError(''); };
    source.onerror = () => {
      setConnected(false);
      setError('Event stream disconnected. Native reconnect is active; controls are held.');
    };
    const offline = () => {
      setConnected(false);
      setError('Browser is offline. Controls are held; admitted backend work is not cancelled.');
    };
    const online = () => {
      // Browser offline can leave an existing SSE TCP connection apparently OPEN.
      // Verify the real API once on reconnect, rather than trusting navigator alone.
      void refresh(controller.signal).then(() => {
        if (alive.current && source.readyState === EventSource.OPEN) { setConnected(true); setError(''); }
      }).catch(error => { if (!controller.signal.aborted) setError(`Reconnect verification failed: ${error.message}`); });
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    if (!navigator.onLine) offline();
    source.addEventListener('snapshot', message => {
      try {
        const { snapshot, reason } = JSON.parse((message as MessageEvent).data) as SnapshotMessage;
        restore(snapshot, reason);
      } catch { setError('Invalid snapshot received. Reload to reconnect safely.'); setConnected(false); }
    });
    source.addEventListener('engine', message => {
      try {
        const event = JSON.parse((message as MessageEvent).data) as EngineEvent;
        const next = ingest(model.current, event);
        publish(next);
        if (next.gap || event.epoch !== next.live?.epoch || event.type === 'REQUEST_FINISHED' || event.type.startsWith('CIRCUIT_')) scheduleRefresh();
      } catch { setError('Invalid engine event received; controls are held.'); setConnected(false); }
    });
    void refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(`Snapshot unavailable: ${error.message}`);
    });
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, Math.max(0, now - previous));
      previous = now;
      const target = targetTime();
      const before = model.current;
      const next = advance(before, dt, settings.current.speed, settings.current.paused, target);
      model.current = next;
      // React commits only on event boundaries. Moving SVG/readout refs use this same clock.
      if (next.view !== before.view) setStore(next);
      for (const listener of listeners.current) listener(next, target);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      alive.current = false;
      fetchRevision.current++;
      controller.abort();
      source.close();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      if (refreshTimer) clearTimeout(refreshTimer);
      cancelAnimationFrame(frame);
    };
  }, [publish, refresh, restore, targetTime]);

  const subscribe = useCallback((listener: ClockListener) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);
  const catchUp = useCallback(() => {
    setPaused(false);
    setSpeed(1);
    publish(liveCatchUp(model.current, targetTime()));
  }, [publish, targetTime]);
  const waitForProbe = useCallback((signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (model.current.live?.state === 'HALF_OPEN') { resolve(); return; }
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => { observers.current.delete(check); signal.removeEventListener('abort', abort); clearTimeout(timer); };
    const check = (next: Store) => { if (next.live?.state === 'HALF_OPEN') { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new DOMException('Demo stopped', 'AbortError')); };
    observers.current.add(check);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => { cleanup(); reject(new Error('No authoritative HALF_OPEN event arrived within 65 seconds.')); }, 65000);
    if (signal.aborted) abort();
  }), []);
  return { store, model, connected: connected && !!store.live && !store.gap, error, setError,
    speed, setSpeed, paused, setPaused, subscribe, catchUp, restore, refresh, waitForProbe };
}
