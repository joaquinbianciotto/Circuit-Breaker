import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import { Engine } from '../src/engine';
import { EventJournal } from '../src/events';
import { createExternalApi } from '../../external-api/src/server';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let engine: Engine;
let upstream: ReturnType<typeof createExternalApi>;
let url: string;
beforeEach(async () => {
  upstream = createExternalApi();
  url = await upstream.listen({ host: '127.0.0.1', port: 0 });
  engine = new Engine(url);
});
afterEach(async () => { engine.shutdown(); await upstream.close(); });
function smallJournal(capacity = 3) {
  const journal: EventJournal = new EventJournal(() => ({
    ...engine.snapshot(), epoch: journal.generation, cursor: journal.cursor, events: journal.events,
  }), capacity);
  return journal;
}
function publish(journal: EventJournal) {
  journal.publish({ type: 'CIRCUIT_HALF_OPEN', timestamp: Date.now(), requestId: null, state: 'HALF_OPEN' });
}

describe('bounded replay protocol', () => {
  it('replays exclusively after the cursor and joins live events without duplicate IDs', () => {
    const journal = smallJournal();
    publish(journal);
    const cursor = journal.cursor;
    publish(journal); publish(journal);
    const messages: MessageEvent[] = [];
    const subscription = journal.stream(cursor).subscribe(message => messages.push(message));
    publish(journal);
    expect(messages.map(message => message.id)).toEqual(journal.events.map(event => event.id));
    expect(new Set(messages.map(message => message.id)).size).toBe(3);
    subscription.unsubscribe();
    expect(journal.connections).toBe(0);
    expect(journal.heartbeats).toBe(0);
  });
  it('expired cursor returns one authoritative gap snapshot at the current cursor', () => {
    const journal = smallJournal();
    const expired = journal.cursor;
    for (let index = 0; index < 6; index++) publish(journal);
    const messages: MessageEvent[] = [];
    const subscription = journal.stream(expired).subscribe(message => messages.push(message));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: journal.cursor, type: 'snapshot', data: { reason: 'expired' } });
    expect((messages[0].data as any).snapshot.events).toHaveLength(3);
    publish(journal);
    expect(messages[1].type).toBe('engine');
    subscription.unsubscribe();
  });
  it('reset sends a generation snapshot to existing clients, with a non-decreasing sequence', () => {
    const journal = smallJournal();
    publish(journal);
    const oldEpoch = journal.generation;
    const messages: MessageEvent[] = [];
    const subscription = journal.stream(journal.cursor).subscribe(message => messages.push(message));
    journal.reset();
    expect(journal.generation).not.toBe(oldEpoch);
    expect(messages[0]).toMatchObject({ type: 'snapshot', data: { reason: 'reset' } });
    publish(journal);
    expect(journal.events[0].sequence).toBe(2);
    expect(journal.events[0].epoch).toBe(journal.generation);
    subscription.unsubscribe();
  });
  it('restart or foreign generations always return a snapshot rather than stale replay', () => {
    const previous = engine.snapshot().cursor;
    const replacement = new Engine(url);
    const messages: MessageEvent[] = [];
    const subscription = replacement.journal.stream(previous).subscribe(message => messages.push(message));
    expect(messages[0]).toMatchObject({ type: 'snapshot', data: { reason: 'generation' } });
    expect((messages[0].data as any).snapshot.epoch).not.toBe(engine.snapshot().epoch);
    subscription.unsubscribe(); replacement.shutdown();
  });
  it.each(['malformed', 'future', 'unsafe'])('invalid %s cursor returns a typed snapshot', kind => {
    const journal = smallJournal();
    const cursor = kind === 'malformed' ? 'not-a-cursor' : `${journal.generation}:${kind === 'future' ? 100 : '999999999999999999999'}`;
    const messages: MessageEvent[] = [];
    const subscription = journal.stream(cursor).subscribe(message => messages.push(message));
    expect(messages[0]).toMatchObject({ type: 'snapshot', data: { kind: 'snapshot', reason: 'invalid' } });
    subscription.unsubscribe();
  });
  it('heartbeat has no cursor and Observable teardown clears listeners/timers', async () => {
    const journal = smallJournal();
    const messages: MessageEvent[] = [];
    const subscription = journal.stream(undefined, 15).subscribe(message => messages.push(message));
    await sleep(40);
    expect(messages[0].type).toBe('snapshot');
    expect(messages.some(message => message.comment?.startsWith('heartbeat ') && message.id === undefined)).toBe(true);
    subscription.unsubscribe();
    const count = messages.length;
    await sleep(40);
    expect(messages).toHaveLength(count);
    expect(journal.connections).toBe(0);
    expect(journal.heartbeats).toBe(0);
  });
  it('early unsubscribe during external refresh never registers a connection', async () => {
    const subscription = engine.events().subscribe();
    subscription.unsubscribe();
    await sleep(50);
    expect(engine.journal.connections).toBe(0);
    expect(engine.journal.heartbeats).toBe(0);
  });
  it('shutdown completes subscribers and prevents delayed refresh from registering a new stream', async () => {
    let completed = false;
    engine.events(undefined, 15).subscribe({ complete: () => { completed = true; } });
    engine.shutdown();
    await sleep(60);
    expect(completed).toBe(true);
    expect(engine.journal.connections).toBe(0);
    expect(engine.journal.heartbeats).toBe(0);
  });
  it('refresh-to-registration race is covered by authoritative initial state and exclusive replay', async () => {
    const cursor = engine.snapshot().cursor;
    const messages: MessageEvent[] = [];
    const subscription = engine.events(cursor).subscribe(message => messages.push(message));
    await engine.run();
    await sleep(30);
    expect(messages.filter(message => message.type === 'engine')).toHaveLength(4);
    expect(new Set(messages.map(message => message.id)).size).toBe(4);
    subscription.unsubscribe();
    const initialMessages: MessageEvent[] = [];
    const initial = engine.events().subscribe(message => initialMessages.push(message));
    await sleep(30);
    const snapshot = (initialMessages[0].data as any).snapshot;
    expect(snapshot.metrics.completed).toBe(1);
    expect(snapshot.histories).toHaveLength(1);
    expect(snapshot.cursor).toBe(cursor.replace(/:0$/, ':4'));
    expect(snapshot.external.metrics.received).toBe(1);
    initial.unsubscribe();
  });
  it('keeps only 200 finished histories and 1000 events while retaining lifetime metrics', async () => {
    for (let batch = 0; batch < 30; batch++) {
      await Promise.all(Array.from({ length: 10 }, () => engine.run()));
    }
    const snapshot = engine.snapshot();
    expect(snapshot.histories).toHaveLength(200);
    expect(snapshot.events).toHaveLength(1000);
    expect(snapshot.metrics).toMatchObject({ completed: 300, active: 0, succeeded: 300, rollingCompleted: 300 });
    expect(new Set(snapshot.events.map(event => event.id)).size).toBe(1000);
    engine.shutdown();
    expect(engine.journal.connections).toBe(0);
  });
});
