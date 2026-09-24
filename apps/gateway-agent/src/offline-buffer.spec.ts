import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { OfflineBuffer } from './offline-buffer';

let dir: string;
const file = () => path.join(dir, 'events.jsonl');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-buffer-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OfflineBuffer — persistence & idempotency', () => {
  it('directory-fsyncs a newly appended corrupt-evidence entry itself', () => {
    const buffer = new OfflineBuffer(file());
    const directorySync = jest.spyOn(
      buffer as unknown as { fsyncDirectory(directory: string): void },
      'fsyncDirectory',
    );

    (buffer as unknown as { appendSecure(target: string, data: string): void }).appendSecure(
      `${file()}.corrupt`,
      'corrupt-evidence\n',
    );

    expect(directorySync).toHaveBeenCalledTimes(1);
    expect(directorySync).toHaveBeenCalledWith(dir);
  });

  it('assigns a stable eventId at enqueue time and persists it to disk', () => {
    const buffer = new OfflineBuffer(file());
    buffer.load();
    const stored = buffer.enqueue({ kind: 'status', payload: { deviceId: 'dev-scale-1' } });
    expect(stored.eventId).toMatch(/^evt-/);
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);

    // A restarted agent sees the SAME eventId — retries dedupe on the platform.
    const reloaded = new OfflineBuffer(file());
    reloaded.load();
    expect(reloaded.pending).toHaveLength(1);
    expect(reloaded.pending[0].eventId).toBe(stored.eventId);
  });

  it('keeps a caller-provided eventId untouched', () => {
    const buffer = new OfflineBuffer(file());
    buffer.load();
    const stored = buffer.enqueue({ kind: 'weight', eventId: 'evt-fixed' });
    expect(stored.eventId).toBe('evt-fixed');
  });

  it('skips corrupt lines on load instead of dying', () => {
    fs.writeFileSync(file(), '{"eventId":"evt-1","kind":"status"}\nNOT-JSON\n', 'utf8');
    const buffer = new OfflineBuffer(file());
    const directorySync = jest.spyOn(
      buffer as unknown as { fsyncDirectory(directory: string): void },
      'fsyncDirectory',
    );
    buffer.load();
    expect(buffer.pending).toHaveLength(1);
    expect(buffer.pending[0].eventId).toBe('evt-1');
    expect(fs.readFileSync(`${file()}.corrupt`, 'utf8')).toContain('NOT-JSON');
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('NOT-JSON');
    expect(directorySync).toHaveBeenCalledWith(dir);
  });
});

describe('OfflineBuffer — flush & retry', () => {
  it('delivers pending events in order and clears the file', async () => {
    const buffer = new OfflineBuffer(file());
    buffer.load();
    buffer.enqueue({ kind: 'status', eventId: 'evt-1' });
    buffer.enqueue({ kind: 'weight', eventId: 'evt-2' });

    const sent: string[] = [];
    const r = await buffer.flush(async (e) => {
      sent.push(e.eventId);
    });
    expect(r).toEqual({ sent: 2, remaining: 0 });
    expect(sent).toEqual(['evt-1', 'evt-2']);
    expect(fs.readFileSync(file(), 'utf8')).toBe('');
  });

  it('keeps everything when the backend is down; a later retry re-sends the SAME events', async () => {
    const buffer = new OfflineBuffer(file());
    buffer.load();
    buffer.enqueue({ kind: 'status', eventId: 'evt-1' });

    const down = await buffer.flush(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(down).toEqual({ sent: 0, remaining: 1 });

    const sent: string[] = [];
    const up = await buffer.flush(async (e) => {
      sent.push(e.eventId);
    });
    expect(up).toEqual({ sent: 1, remaining: 0 });
    expect(sent).toEqual(['evt-1']);
  });

  it('stops at the first failure and keeps the undelivered tail (order preserved)', async () => {
    const buffer = new OfflineBuffer(file());
    buffer.load();
    buffer.enqueue({ kind: 'status', eventId: 'evt-1' });
    buffer.enqueue({ kind: 'status', eventId: 'evt-2' });
    buffer.enqueue({ kind: 'status', eventId: 'evt-3' });

    let calls = 0;
    const r = await buffer.flush(async () => {
      calls += 1;
      if (calls === 2) throw new Error('flaky');
    });
    expect(r).toEqual({ sent: 1, remaining: 2 });
    expect(buffer.pending.map((e) => e.eventId)).toEqual(['evt-2', 'evt-3']);

    // The remaining events survive a restart too.
    const reloaded = new OfflineBuffer(file());
    reloaded.load();
    expect(reloaded.pending.map((e) => e.eventId)).toEqual(['evt-2', 'evt-3']);
  });

  it('bounds the buffer by dropping the oldest events', () => {
    const buffer = new OfflineBuffer(file(), 2);
    buffer.load();
    buffer.enqueue({ kind: 'status', eventId: 'evt-1' });
    buffer.enqueue({ kind: 'status', eventId: 'evt-2' });
    buffer.enqueue({ kind: 'status', eventId: 'evt-3' });
    expect(buffer.pending.map((e) => e.eventId)).toEqual(['evt-2', 'evt-3']);
  });
});
