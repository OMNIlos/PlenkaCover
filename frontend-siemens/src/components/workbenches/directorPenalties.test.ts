import { describe, expect, it, vi } from 'vitest';

import {
  executePenaltyCreate,
  type PenaltyCreateLock,
  type PenaltyFormPayload,
} from './directorPenalties';

const payload = {
  employeeId: 'operator-1',
  employeeName: 'Оператор 1',
  employeeRole: 'Оператор',
  amountLabel: '2 000 ₽',
  reason: 'Нарушение техпроцесса',
  scopeObjectId: 'production-order-1',
  productionOrderId: 'production-order-1',
  author: 'Зав. производства',
} satisfies PenaltyFormPayload;

describe('penalty create submission', () => {
  it('coalesces rapid submits and unlocks after the request settles', async () => {
    let resolve!: (created: boolean) => void;
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue(true);
    const lock: PenaltyCreateLock = { current: null };

    const first = executePenaltyCreate(payload, create, lock);
    const second = executePenaltyCreate(payload, create, lock);

    expect(second).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    resolve(true);
    await first;

    await executePenaltyCreate(payload, create, lock);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
