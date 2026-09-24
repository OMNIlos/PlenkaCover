import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './logger';

export interface PendingCommandResult {
  commandId: string;
  leaseToken: string;
  result: Record<string, unknown>;
  enqueuedAt: string;
}

export type ResultDeliveryDecision = 'ack' | 'quarantine';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function isPendingCommandResult(value: unknown): value is PendingCommandResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PendingCommandResult>;
  return (
    typeof record.commandId === 'string' &&
    record.commandId.length > 0 &&
    typeof record.leaseToken === 'string' &&
    record.leaseToken.length > 0 &&
    typeof record.enqueuedAt === 'string' &&
    !!record.result &&
    typeof record.result === 'object' &&
    !Array.isArray(record.result)
  );
}

/**
 * Durable command-result journal. A device command is never executed again merely because
 * the platform acknowledgement was lost: its result is saved here first, then retried with
 * the original server lease until acknowledged or explicitly rejected as terminal.
 */
export class ResultOutbox {
  private results: PendingCommandResult[] = [];

  constructor(private readonly file: string) {}

  load(): void {
    this.results = [];
    if (!fs.existsSync(this.file)) {
      this.persist();
      return;
    }

    const corrupt: string[] = [];
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isPendingCommandResult(parsed)) throw new Error('invalid result record');
        const existing = this.results.find((item) => item.commandId === parsed.commandId);
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(parsed)) corrupt.push(line);
          continue;
        }
        this.results.push(parsed);
      } catch {
        corrupt.push(line);
      }
    }

    if (corrupt.length > 0) {
      this.appendSecure(`${this.file}.corrupt`, corrupt.join('\n') + '\n');
      this.persist();
      log.warn('result outbox quarantined corrupt records', { count: corrupt.length });
    } else {
      fs.chmodSync(this.file, 0o600);
    }
    if (this.results.length > 0) {
      log.info('result outbox loaded pending acknowledgements', { count: this.results.length });
    }
  }

  get pending(): readonly PendingCommandResult[] {
    return this.results;
  }

  has(commandId: string): boolean {
    return this.results.some((item) => item.commandId === commandId);
  }

  enqueue(
    commandId: string,
    leaseToken: string,
    result: Record<string, unknown>,
  ): PendingCommandResult {
    const existing = this.results.find((item) => item.commandId === commandId);
    if (existing) {
      if (
        existing.leaseToken !== leaseToken ||
        canonicalJson(existing.result) !== canonicalJson(result)
      ) {
        throw new Error(`conflicting local result for gateway command ${commandId}`);
      }
      return existing;
    }

    const stored = {
      commandId,
      leaseToken,
      result,
      enqueuedAt: new Date().toISOString(),
    } satisfies PendingCommandResult;
    this.results.push(stored);
    this.persist();
    return stored;
  }

  async flush(
    send: (result: PendingCommandResult) => Promise<ResultDeliveryDecision>,
  ): Promise<{ sent: number; quarantined: number; remaining: number }> {
    let sent = 0;
    let quarantined = 0;
    while (this.results.length > 0) {
      const current = this.results[0];
      let decision: ResultDeliveryDecision;
      try {
        decision = await send(current);
      } catch {
        break;
      }
      if (decision === 'quarantine') {
        this.appendSecure(`${this.file}.quarantine`, `${JSON.stringify(current)}\n`);
        quarantined += 1;
      } else {
        sent += 1;
      }
      this.results.shift();
      this.persist();
    }
    return { sent, quarantined, remaining: this.results.length };
  }

  private persist(): void {
    const directory = path.dirname(this.file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    const data = this.results.map((item) => `${JSON.stringify(item)}\n`).join('');
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
