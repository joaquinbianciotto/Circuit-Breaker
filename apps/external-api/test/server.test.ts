import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_EXTERNAL_CONFIG, ValidationError, validateExternalPatch } from '@resilience/contracts';
import { createExternalApi } from '../src/server';

let app: ReturnType<typeof createExternalApi>;
let url: string;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function call(path: string, method = 'GET', data?: unknown) {
  const response = await fetch(`${url}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  return { status: response.status, data: await response.json() };
}
beforeEach(async () => {
  app = createExternalApi();
  url = await app.listen({ host: '0.0.0.0', port: 0 });
});
afterEach(async () => { await app.close(); });

describe('real configurable upstream', () => {
  it('binds all interfaces and records correlated completed work', async () => {
    expect((app.server.address() as { address: string }).address).toBe('0.0.0.0');
    expect((await call('/health')).data.ok).toBe(true);
    const response = await fetch(`${url}/work`, { headers: { 'x-request-id': 'request', 'x-attempt-id': 'attempt' } });
    expect(response.status).toBe(200);
    await response.json();
    expect((await call('/metrics')).data).toMatchObject({
      received: 1, completed: 1, active: 0, cancelled: 0,
      logs: [{ requestId: 'request', attemptId: 'attempt', outcome: 'completed', status: 200 }],
    });
  });
  it('validates configs without accepting unknown, fractional, nonnumeric or invalid enum fields', async () => {
    for (const patch of [[], null, { latencyMs: -1 }, { latencyMs: 1.1 }, { latencyMs: '100' }, { errorStatus: 200 }, { failureRate: 1.1 }, { failureRate: null }, { failureRate: '0.5' }, { mode: 'missing' }, { intermittent: 'missing' }, { unknown: true }]) {
      expect((await call('/config', 'PATCH', patch)).status).toBe(400);
    }
    for (const failureRate of [NaN, Infinity, -Infinity]) {
      expect(() => validateExternalPatch({ failureRate }, { ...DEFAULT_EXTERNAL_CONFIG })).toThrow(ValidationError);
    }
    expect((await call('/config')).data).toEqual(DEFAULT_EXTERNAL_CONFIG);
  });
  it('supports ordinary 4xx failures and alternating reproducible retry demonstrations', async () => {
    // Normal traffic must not advance the intermittent sequence.
    await call('/work');
    await call('/config', 'PATCH', { mode: 'intermittent', errorStatus: 429 });
    const statuses = [];
    for (let index = 0; index < 4; index++) statuses.push((await call('/work')).status);
    expect(statuses).toEqual([429, 200, 429, 200]);
    const reset = await call('/reset', 'POST', {});
    expect(reset.data).toMatchObject({ config: DEFAULT_EXTERNAL_CONFIG, metrics: { received: 0, completed: 0, cancelled: 0, active: 0, logs: [] } });
  });
  it('supports configurable seeded probability with deterministic reset', async () => {
    const config = { mode: 'intermittent', intermittent: 'probability', failureRate: 0.5 };
    await call('/config', 'PATCH', config);
    const first = [];
    for (let index = 0; index < 10; index++) first.push((await call('/work')).status);
    await call('/reset', 'POST', {});
    await call('/config', 'PATCH', config);
    const second = [];
    for (let index = 0; index < 10; index++) second.push((await call('/work')).status);
    expect(first).toEqual(second);
    expect(first).toContain(200); expect(first).toContain(503);
    await call('/config', 'PATCH', { failureRate: 1 });
    expect((await call('/work')).status).toBe(503);
    await call('/config', 'PATCH', { failureRate: 0 });
    expect((await call('/work')).status).toBe(200);
  });
  it('slow mode respects an explicit latency and bounds finished correlated logs', async () => {
    await call('/config', 'PATCH', { mode: 'slow', latencyMs: 30 });
    const start = Date.now();
    expect((await call('/work')).status).toBe(200);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(Date.now() - start).toBeLessThan(400);
    await call('/config', 'PATCH', { mode: 'normal', latencyMs: 0 });
    for (let batch = 0; batch < 21; batch++) await Promise.all(Array.from({ length: 10 }, () => call('/work')));
    const metrics = (await call('/metrics')).data;
    expect(metrics.logs).toHaveLength(200);
    expect(metrics).toMatchObject({ received: 211, completed: 211, active: 0, cancelled: 0 });
  });
  it('client abort stops delayed timers and increments cancelled, never completed', async () => {
    await call('/config', 'PATCH', { latencyMs: 500 });
    const controller = new AbortController();
    const request = fetch(`${url}/work`, { signal: controller.signal }).catch(error => error);
    // Wait for real receipt rather than aborting before the server sees the call.
    for (let index = 0; index < 100; index++) {
      if ((await call('/metrics')).data.active === 1) break;
      await sleep(5);
    }
    expect((await call('/metrics')).data.active).toBe(1);
    expect((await call('/reset', 'POST', {})).status).toBe(409);
    controller.abort();
    await request;
    await sleep(50);
    const stats = (await call('/metrics')).data;
    expect(stats).toMatchObject({ received: 1, cancelled: 1, completed: 0, active: 0 });
    expect(stats.logs[0].outcome).toBe('cancelled');
    await sleep(520);
    expect((await call('/metrics')).data.completed).toBe(0);
  });
});
