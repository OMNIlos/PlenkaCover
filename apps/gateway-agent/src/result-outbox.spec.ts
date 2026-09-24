import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResultOutbox } from './result-outbox';

let dir: string;
const file = () => path.join(dir, 'command-results.jsonl');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-results-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ResultOutbox — execute once, deliver until acknowledged', () => {
  it('directory-fsyncs a newly appended evidence journal entry itself', () => {
    const outbox = new ResultOutbox(file());
    const directorySync = jest.spyOn(
      outbox as unknown as { fsyncDirectory(directory: string): void },
      'fsyncDirectory',
    );

    (outbox as unknown as { appendSecure(target: string, data: string): void }).appendSecure(
      `${file()}.quarantine`,
      '{"evidence":true}\n',
    );

    expect(directorySync).toHaveBeenCalledTimes(1);
    expect(directorySync).toHaveBeenCalledWith(dir);
  });

  it('persists a result before delivery and reloads the same lease after restart', () => {
    const outbox = new ResultOutbox(file());
    outbox.load();
    outbox.enqueue('cmd-1', 'lease-1', { ok: true, grossKg: 2.5 });

    const reloaded = new ResultOutbox(file());
    reloaded.load();

    expect(reloaded.has('cmd-1')).toBe(true);
    expect(reloaded.pending).toEqual([
      expect.objectContaining({
        commandId: 'cmd-1',
        leaseToken: 'lease-1',
        result: { ok: true, grossKg: 2.5 },
      }),
    ]);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('dedupes an identical enqueue but rejects conflicting local results', () => {
    const outbox = new ResultOutbox(file());
    outbox.load();
    outbox.enqueue('cmd-1', 'lease-1', { ok: true });
    outbox.enqueue('cmd-1', 'lease-1', { ok: true });

    expect(outbox.pending).toHaveLength(1);
    expect(() => outbox.enqueue('cmd-1', 'lease-2', { ok: false })).toThrow(/conflicting/i);
  });

  it('keeps an unacknowledged result and removes only an acknowledged result', async () => {
    const outbox = new ResultOutbox(file());
    outbox.load();
    outbox.enqueue('cmd-1', 'lease-1', { ok: true });

    await expect(
      outbox.flush(async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).resolves.toEqual({ sent: 0, quarantined: 0, remaining: 1 });

    await expect(outbox.flush(async () => 'ack')).resolves.toEqual({
      sent: 1,
      quarantined: 0,
      remaining: 0,
    });
    expect(fs.readFileSync(file(), 'utf8')).toBe('');
  });

  it('quarantines a terminal API rejection instead of retrying forever', async () => {
    const outbox = new ResultOutbox(file());
    outbox.load();
    outbox.enqueue('cmd-1', 'lease-stale', { ok: true });
    const directorySync = jest.spyOn(
      outbox as unknown as { fsyncDirectory(directory: string): void },
      'fsyncDirectory',
    );
    directorySync.mockClear();

    await expect(outbox.flush(async () => 'quarantine')).resolves.toEqual({
      sent: 0,
      quarantined: 1,
      remaining: 0,
    });
    expect(fs.readFileSync(`${file()}.quarantine`, 'utf8')).toContain('"commandId":"cmd-1"');
    expect(directorySync).toHaveBeenCalledWith(dir);
  });

  it('quarantines corrupt disk records without losing valid records', () => {
    fs.writeFileSync(
      file(),
      [
        JSON.stringify({
          commandId: 'cmd-1',
          leaseToken: 'lease-1',
          result: { ok: true },
          enqueuedAt: new Date().toISOString(),
        }),
        'not-json',
        '',
      ].join('\n'),
      { encoding: 'utf8', mode: 0o600 },
    );

    const outbox = new ResultOutbox(file());
    const directorySync = jest.spyOn(
      outbox as unknown as { fsyncDirectory(directory: string): void },
      'fsyncDirectory',
    );
    outbox.load();

    expect(outbox.pending).toHaveLength(1);
    expect(fs.readFileSync(`${file()}.corrupt`, 'utf8')).toContain('not-json');
    expect(directorySync).toHaveBeenCalledWith(dir);
  });
});
