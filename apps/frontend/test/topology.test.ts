import { afterEach, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_POLICY, type Snapshot } from '@resilience/contracts';
import { Machine } from '../src/Machine';
import type { Route } from '../src/model';
import { CONDUCTORS, WAIT_POINT } from '../src/topology';

const observed: Snapshot = {
  kind: 'snapshot', epoch: 'a', cursor: 'a:1', serverTime: 1000, state: 'CLOSED',
  openedAt: null, recoveryAt: null, policy: { ...DEFAULT_POLICY }, histories: [], events: [],
  metrics: { completed: 0, succeeded: 0, failed: 0, rejected: 0, active: 0,
    rollingCompleted: 0, rollingFailed: 0, errorPercentage: 0 }, external: null, externalObservedAt: null,
};
const renderStage = (route: Route, reduced: boolean) => {
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  const html = renderToStaticMarkup(createElement(Machine, {
    snapshot: observed, journeys: [{ history: { requestId: 'new-request', startedAt: 1000,
      deadlineAt: 4000, probe: false, attempts: [] }, stages: [{ route }], elapsed: 0, completed: false }],
    selected: null, inspect: 'gate', onInspect: () => {}, onSelect: () => {},
    subscribe: () => () => {}, onVisibility: () => {},
  }));
  return html.match(/<g[^>]*data-testid="signal"[^>]*>([\s\S]*?)<\/g>/)![1];
};
afterEach(() => vi.unstubAllGlobals());

it.each<[Route, number, number]>([
  ['inlet', 86, 300], ['http', 800, 300], ['wait', 614, 520], ['retry', 552, 300],
  ['success', 974, 236], ['failure', 974, 386], ['reject', 974, 612],
])('reduced %s initial/stage render is static before any RAF repair', (route, x, y) => {
  const signal = renderStage(route, true);
  const circles = signal.match(/<circle[^>]*>/g)!;
  expect(circles).toHaveLength(4);
  for (const circle of circles) {
    expect(circle).toContain(`cx="${x}"`);
    expect(circle).toContain(`cy="${y}"`);
  }
  expect(signal).toContain(`<text x="${x}" y="${y - 16}"`);
  expect(circles.slice(1).every(circle => circle.includes('opacity:0'))).toBe(true);
});
it('ordinary HTTP initial rendering still starts at the conductor origin', () => {
  expect(renderStage('http', false)).toContain('<circle cx="410" cy="300"');
});

it('keeps admission at REQUEST IN, HTTP after contacts and rejection on the inlet shunt', () => {
  expect(CONDUCTORS.inlet).toBe('M86 300 H310');
  expect(CONDUCTORS.http).toMatch(/^M410 300/);
  expect(CONDUCTORS.http).toMatch(/H800$/);
  expect(CONDUCTORS.reject).toBe('M256 300 V612 H974');
});
it('returns retries directly to HTTP without traversing admission contacts', () => {
  expect(CONDUCTORS.retry).toMatch(/^M800 300/);
  expect(CONDUCTORS.retry).toMatch(/H552 V300$/);
  expect(CONDUCTORS.retry).not.toMatch(/86|310|410/);
  expect(WAIT_POINT).toEqual({ x: 614, y: 520 });
});
