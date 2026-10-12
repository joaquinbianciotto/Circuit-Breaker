import { randomUUID } from 'node:crypto';
import type { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { EngineEvent, Snapshot, SnapshotMessage } from '@resilience/contracts';

export class EventJournal {
  private epoch = randomUUID();
  private sequence = 0;
  private buffer: EngineEvent[] = [];
  private listeners = new Set<(message: MessageEvent) => void>();
  private heartbeatCount = 0;
  private closers = new Set<() => void>();
  constructor(private readonly snapshot: () => Snapshot, private readonly capacity = 1000) {}
  get generation() { return this.epoch; }
  get cursor() { return `${this.epoch}:${this.sequence}`; }
  get events() { return structuredClone(this.buffer); }
  get connections() { return this.listeners.size; }
  get heartbeats() { return this.heartbeatCount; }

  publish(event: Omit<EngineEvent, 'id' | 'epoch' | 'sequence'>): EngineEvent {
    const value: EngineEvent = {
      ...event, epoch: this.epoch, sequence: ++this.sequence, id: this.cursor,
    };
    this.buffer.push(value);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.broadcast({ type: 'engine', id: value.id, data: value });
    return value;
  }
  reset() {
    // Sequence never decreases during this process; UUID fences process restart/reset.
    this.epoch = randomUUID();
    this.buffer = [];
    this.broadcast(this.snapshotMessage('reset'));
  }
  private broadcast(message: MessageEvent) {
    for (const listener of this.listeners) listener(message);
  }
  private snapshotMessage(reason: SnapshotMessage['reason']): MessageEvent {
    const snapshot = this.snapshot();
    return { type: 'snapshot', id: snapshot.cursor, retry: 1000, data: { kind: 'snapshot', reason, snapshot } satisfies SnapshotMessage };
  }
  close() { for (const close of [...this.closers]) close(); }
  stream(cursor?: string, heartbeatMs = 15000): Observable<MessageEvent> {
    return new Observable(subscriber => {
      const send = (message: MessageEvent) => subscriber.next(message);
      // Registration, cursor capture and replay are synchronous: no await/lost-event gap.
      this.listeners.add(send);
      const close = () => subscriber.complete();
      this.closers.add(close);
      const match = cursor?.match(/^([0-9a-f-]{36}):(\d+)$/);
      if (!cursor) send(this.snapshotMessage('initial'));
      else if (!match || !Number.isSafeInteger(Number(match[2]))) send(this.snapshotMessage('invalid'));
      else if (match[1] !== this.epoch) send(this.snapshotMessage('generation'));
      else {
        const sequence = Number(match[2]);
        const earliest = this.buffer[0]?.sequence ?? this.sequence + 1;
        if (sequence > this.sequence) send(this.snapshotMessage('invalid'));
        else if (sequence < earliest - 1) send(this.snapshotMessage('expired'));
        else {
          for (const event of this.buffer) {
            if (event.sequence > sequence) send({ type: 'engine', id: event.id, data: structuredClone(event) });
          }
        }
      }
      this.heartbeatCount++;
      const timer = setInterval(() => {
        // Nest assigns automatic numeric IDs to data messages lacking an id.
        // Comment-only messages bypass that behavior and preserve Last-Event-ID.
        send({ comment: `heartbeat ${Date.now()}` });
      }, heartbeatMs);
      timer.unref();
      return () => {
        clearInterval(timer);
        this.heartbeatCount--;
        this.listeners.delete(send);
        this.closers.delete(close);
      };
    });
  }
}
