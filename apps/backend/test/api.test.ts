import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@resilience/contracts';
import { createExternalApi } from '../../external-api/src/server';

// Exercise tsc output, not esbuild's decorator transform. Build before this suite.
const require = createRequire(import.meta.url);
const { createBackend } = require('../dist/app.js') as typeof import('../src/app');
const policy: Policy = {
  ...DEFAULT_POLICY, attemptTimeoutMs: 200, retries: 0, minimumVolume: 1,
  operationDeadlineMs: 700, recoveryMs: 500,
};
let upstream: ReturnType<typeof createExternalApi>;
let backend: Awaited<ReturnType<typeof createBackend>>;
let base: string;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Condition did not become true');
    await sleep(5);
  }
}
async function json(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
interface WireEvent { id?: string; type: string; data: any; comment?: string }
async function connect(query = '', lastEventId?: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events${query}`, {
    signal: controller.signal, headers: lastEventId ? { 'last-event-id': lastEventId } : {},
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  async function next(): Promise<WireEvent> {
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const fields: Record<string, string> = {};
          for (const line of frame.split('\n')) {
            const colon = line.indexOf(':');
            if (colon >= 0) fields[line.slice(0, colon)] = line.slice(colon + 1).trimStart();
          }
          if (!fields.data) {
            if (fields['']) return { type: 'comment', id: fields.id, data: null, comment: fields[''] };
            continue;
          }
          return { type: fields.event, id: fields.id, data: JSON.parse(fields.data) };
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE ended before expected message');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    } finally { clearTimeout(timer); }
  }
  async function close() { controller.abort(); await reader.cancel().catch(() => {}); }
  return { next, close };
}

beforeEach(async () => {
  upstream = createExternalApi();
  const externalUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
  backend = await createBackend({ externalUrl, policy });
  await backend.app.listen(0, '0.0.0.0');
  const address = backend.app.getHttpServer().address();
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => { await backend.app.close(); await upstream.close(); });

describe('compiled Nest REST and real SSE transport', () => {
  it('starts compiled Nest on all interfaces and serves authoritative contracts', async () => {
    expect(backend.app.getHttpServer().address().address).toBe('0.0.0.0');
    expect(await json('/api/health')).toMatchObject({ status: 200, data: { ok: true, state: 'CLOSED' } });
    expect((await json('/api/config')).data).toEqual(policy);
    expect((await json('/api/external')).data.mode).toBe('normal');
    const snapshot = (await json('/api/snapshot')).data;
    expect(snapshot).toMatchObject({ kind: 'snapshot', state: 'CLOSED', external: { metrics: { received: 0 } } });
    expect(snapshot.serverTime).toBeGreaterThan(0);
    expect(snapshot.cursor).toBe(`${snapshot.epoch}:0`);
  });
  it('returns expected logical failures/rejections in a batch, not transport errors', async () => {
    expect((await json('/api/external', 'PATCH', { mode: 'fail' })).status).toBe(200);
    const first = await json('/api/requests', 'POST', { count: 1 });
    expect(first.status).toBe(201);
    expect(first.data.results[0].outcome).toBe('failure');
    const batch = await json('/api/requests', 'POST', { count: 10 });
    expect(batch.status).toBe(201);
    expect(batch.data.results.every((result: any) => result.outcome === 'rejected' && result.attempts === 0)).toBe(true);
    const snapshot = (await json('/api/snapshot')).data;
    expect(snapshot.external.metrics.received).toBe(1);
    expect(snapshot.metrics).toMatchObject({ completed: 1, failed: 1, rejected: 10, rollingCalls: 10, rollingCompleted: 0, rollingFailed: 0 });
  });
  it('strict config and count errors return 400 without changing policy', async () => {
    for (const count of [0, 11, 1.1, '2', null]) {
      expect((await json('/api/requests', 'POST', { count })).status).toBe(400);
    }
    expect((await json('/api/requests', 'POST', { count: 1, extra: true })).status).toBe(400);
    for (const patch of [{ retries: 3 }, { minimumVolume: 0 }, { recoveryMs: 0.5 }, { unknown: 1 }]) {
      expect((await json('/api/config', 'PATCH', patch)).status).toBe(400);
    }
    expect((await json('/api/external', 'PATCH', { mode: 'unknown' })).status).toBe(400);
    expect((await json('/api/config')).data).toEqual(policy);
    expect((await json('/api/config', 'POST', { retries: 1 })).data.retries).toBe(1);
  });
  it('policy/reset/external mutation return 409 while a real HTTP action is pending', async () => {
    await json('/api/external', 'PATCH', { latencyMs: 100 });
    const request = json('/api/requests', 'POST', { count: 1 });
    await until(() => backend.engine.snapshot().metrics.active === 1);
    expect((await json('/api/config', 'PATCH', { retries: 1 })).status).toBe(409);
    expect((await json('/api/reset', 'POST', {})).status).toBe(409);
    expect((await json('/api/external', 'PATCH', { mode: 'fail' })).status).toBe(409);
    expect((await request).data.results[0].outcome).toBe('success');
    expect((await json('/api/reset', 'POST', {})).status).toBe(201);
  });
  it('initial snapshot, correlated events, header replay and live join have no duplicate IDs', async () => {
    const stream = await connect();
    const initial = await stream.next();
    expect(initial.type).toBe('snapshot');
    expect(initial.data.reason).toBe('initial');
    await json('/api/requests', 'POST', { count: 2 });
    const events = [];
    for (let index = 0; index < 8; index++) events.push(await stream.next());
    expect(events.every(event => event.type === 'engine' && event.id === event.data.id)).toBe(true);
    expect(events.map(event => event.data.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(events.map(event => event.id)).size).toBe(8);
    const requestIds = new Set(events.map(event => event.data.requestId));
    expect(requestIds.size).toBe(2);
    expect(events.filter(event => event.data.attemptId)).toHaveLength(4);
    await stream.close();
    await until(() => backend.engine.journal.connections === 0);
    const reconnect = await connect(`?cursor=${encodeURIComponent(initial.id!)}`, events[2].id);
    const replay = [];
    for (let index = 0; index < 5; index++) replay.push(await reconnect.next());
    expect(replay.map(event => event.id)).toEqual(events.slice(3).map(event => event.id));
    await json('/api/requests', 'POST', { count: 1 });
    for (let index = 0; index < 4; index++) replay.push(await reconnect.next());
    expect(new Set(replay.map(event => event.id)).size).toBe(9);
    expect(replay.at(-1)!.data.sequence).toBe(12);
    await reconnect.close();
    await until(() => backend.engine.journal.connections === 0);
    expect(backend.engine.journal.heartbeats).toBe(0);
  });
  it('Nest heartbeats are comments without fabricated IDs that overwrite the replay cursor', async () => {
    const events = backend.engine.events.bind(backend.engine);
    backend.engine.events = cursor => events(cursor, 20);
    const stream = await connect();
    const snapshot = await stream.next();
    expect(snapshot.type).toBe('snapshot');
    const heartbeat = await stream.next();
    expect(heartbeat.id).toBeUndefined();
    expect(heartbeat.type).toBe('comment');
    expect(heartbeat.comment).toMatch(/^heartbeat \d+$/);
    await stream.close();
    await until(() => backend.engine.journal.connections === 0);
    expect(backend.engine.journal.heartbeats).toBe(0);
  });
  it('query cursor replay and reset generation snapshot work on the wire', async () => {
    await json('/api/requests', 'POST', { count: 1 });
    const old = backend.engine.snapshot();
    const stream = await connect(`?cursor=${encodeURIComponent(old.cursor)}`);
    await until(() => backend.engine.journal.connections === 1);
    const reset = await json('/api/reset', 'POST', {});
    const message = await stream.next();
    expect(message).toMatchObject({ type: 'snapshot', data: { reason: 'reset' } });
    expect(message.data.snapshot.epoch).toBe(reset.data.epoch);
    expect(message.data.snapshot.epoch).not.toBe(old.epoch);
    await json('/api/requests', 'POST', { count: 1 });
    const next = await stream.next();
    expect(next.data.sequence).toBe(5);
    expect(next.data.epoch).toBe(reset.data.epoch);
    await stream.close();
    const reconnect = await connect(`?cursor=${encodeURIComponent(old.cursor)}`);
    expect((await reconnect.next()).data.reason).toBe('generation');
    await reconnect.close();
  });
  it('expired replay cursor produces a gap snapshot rather than an incomplete event tail', async () => {
    const old = backend.engine.snapshot().cursor;
    for (let batch = 0; batch < 26; batch++) {
      await json('/api/requests', 'POST', { count: 10 });
    }
    const stream = await connect(`?cursor=${encodeURIComponent(old)}`);
    const message = await stream.next();
    expect(message).toMatchObject({ type: 'snapshot', data: { reason: 'expired' } });
    expect(message.data.snapshot.metrics.completed).toBe(260);
    expect(message.data.snapshot.events).toHaveLength(1000);
    expect(message.id).toBe(message.data.snapshot.cursor);
    await stream.close();
  });
});
