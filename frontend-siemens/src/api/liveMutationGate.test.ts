import { describe, expect, it, vi } from 'vitest';

import { LiveMutationGate } from './liveMutationGate';

describe('LiveMutationGate', () => {
  it('rejects a duplicate key while the first mutation is pending and unlocks afterwards', async () => {
    let resolve!: (value: string) => void;
    const mutation = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const gate = new LiveMutationGate();

    const first = gate.start('operator:roll-1:qr-print', mutation);
    const duplicate = gate.start('operator:roll-1:qr-print', mutation);

    expect(first).not.toBeNull();
    expect(duplicate).toBeNull();
    expect(mutation).toHaveBeenCalledTimes(1);
    resolve('printed');
    await first;

    expect(gate.start('operator:roll-1:qr-print', () => Promise.resolve('reprint'))).not.toBeNull();
  });

  it('allows independent role/object/action keys to run concurrently', () => {
    const gate = new LiveMutationGate();
    const task = () => new Promise<void>(() => undefined);

    expect(gate.start('finance:order-1:payment', task)).not.toBeNull();
    expect(gate.start('warehouse:task-1:pallet', task)).not.toBeNull();
  });
});
