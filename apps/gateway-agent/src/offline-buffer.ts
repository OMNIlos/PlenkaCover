import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';

export interface BufferedEvent {
  eventId: string;
  kind: 'weight' | 'scan' | 'status' | 'heartbeat';
  payload?: Record<string, unknown>;
  rawPayload?: unknown;
  enqueuedAt: string;
}

export type BufferableEvent = Omit<BufferedEvent, 'eventId' | 'enqueuedAt'> & { eventId?: string };

/**
 * File-backed store-and-forward buffer for ingest events (`events.jsonl`, one JSON per
 * line). The eventId is assigned ONCE at enqueue time and persisted, so a re-sent event
 * carries the same id and the platform dedupes it (GatewayEvent @@unique postId+eventId)
 * — retries after an outage are idempotent by construction.
 */
export class OfflineBuffer {
  private events: BufferedEvent[] = [];

  constructor(
    private readonly file: string,
    private readonly maxEvents = 1000,
  ) {}

  load(): void {
    this.events = [];
    if (!fs.existsSync(this.file)) {
      this.persist();
      return;
    }
    const corrupt: string[] = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<BufferedEvent>;
        if (
          typeof parsed.eventId !== 'string' ||
          !['weight', 'scan', 'status', 'heartbeat'].includes(String(parsed.kind))
        ) {
          throw new Error('invalid buffered event');
        }
        this.events.push({
          ...(parsed as BufferedEvent),
          enqueuedAt:
            typeof parsed.enqueuedAt === 'string' ? parsed.enqueuedAt : new Date(0).toISOString(),
        });
      } catch {
        corrupt.push(line);
      }
    }
    if (corrupt.length > 0) {
      this.appendSecure(`${this.file}.corrupt`, `${corrupt.join('\n')}\n`);
      this.persist();
      log.warn('offline buffer: quarantined corrupt records', { count: corrupt.length });
    } else {
      fs.chmodSync(this.file, 0o600);
    }
    if (this.events.length > 0) {
      log.info('offline buffer loaded pending events', { count: this.events.length });
    }
  }

  get pending(): readonly BufferedEvent[] {
    return this.events;
  }

  enqueue(event: BufferableEvent): BufferedEvent {
    const stored: BufferedEvent = {
      ...event,
      eventId: event.eventId ?? `evt-${randomUUID()}`,
      enqueuedAt: new Date().toISOString(),
    };
    this.events.push(stored);
    if (this.events.length > this.maxEvents) {
      // Bounded buffer: a dead backend must not fill the post's disk. Oldest events go
      // first — they are diagnostics, not business facts of record.
      const dropped = this.events.length - this.maxEvents;
      this.events.splice(0, dropped);
      log.warn('offline buffer overflow — dropped oldest events', { dropped });
    }
    this.persist();
    return stored;
  }

  /**
   * Deliver pending events in order; stops on the first failure (backend still down) and
   * keeps everything undelivered for the next flush.
   */
  async flush(send: (event: BufferedEvent) => Promise<void>): Promise<{
    sent: number;
    remaining: number;
  }> {
    let sent = 0;
    while (this.events.length > 0) {
      try {
        await send(this.events[0]);
      } catch {
        break;
      }
      this.events.shift();
      sent += 1;
    }
    if (sent > 0) this.persist();
    return { sent, remaining: this.events.length };
  }

  private persist(): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    const data = this.events.map((event) => `${JSON.stringify(event)}\n`).join('');
    const descriptor = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(descriptor, data, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, this.file);
    fs.chmodSync(this.file, 0o600);
    this.fsyncDirectory(directory);
  }

  private appendSecure(file: string, data: string): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const descriptor = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeFileSync(descriptor, data, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(file, 0o600);
    this.fsyncDirectory(directory);
  }

  private fsyncDirectory(directory: string): void {
    try {
      const descriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch {
      // Some Windows filesystems cannot fsync directory handles; the file itself is fsynced.
    }
  }
}
