import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, apiGet: mocks.apiGet };
});

import { fetchOperatorOrderMass, parseOperatorOrderMass } from './operator';

const valid = {
  orderPlannedNetKg: 30,
  weighedPlannedNetKg: 10,
  actualNetKg: 11.25,
  deviationKg: 1.25,
  weighedRollCount: 1,
  totalRollCount: 2,
};

describe('operator order mass API', () => {
  beforeEach(() => mocks.apiGet.mockReset());

  it('parses the exact six-field safe aggregate', () => {
    expect(parseOperatorOrderMass(valid)).toEqual(valid);
  });

  it.each([
    null,
    { ...valid, unknown: 1 },
    { ...valid, actualNetKg: Number.NaN },
    { ...valid, actualNetKg: -1 },
    { ...valid, actualNetKg: 1.2345 },
    { ...valid, weighedPlannedNetKg: 31 },
    { ...valid, weighedRollCount: 0, weighedPlannedNetKg: 10 },
    { ...valid, weighedRollCount: 1.5 },
    { ...valid, weighedRollCount: 3 },
    {
      ...valid,
      weighedRollCount: 2,
      weighedPlannedNetKg: 29,
      actualNetKg: 30.25,
    },
    { ...valid, deviationKg: 1.251 },
    {
      ...valid,
      totalRollCount: 0,
      weighedRollCount: 0,
      orderPlannedNetKg: 30,
      weighedPlannedNetKg: 0,
      actualNetKg: 0,
      deviationKg: 0,
    },
    { ...valid, deviationKg: Number.POSITIVE_INFINITY },
  ])('rejects malformed or contradictory payload %#', (payload) => {
    expect(() => parseOperatorOrderMass(payload)).toThrow('Некорректная масса заказа.');
  });

  it('URI-encodes the order and forwards the abort signal to the pure GET', async () => {
    const controller = new AbortController();
    mocks.apiGet.mockResolvedValue(valid);

    await expect(fetchOperatorOrderMass('ЗАКАЗ / 7', controller.signal)).resolves.toEqual(valid);

    expect(mocks.apiGet).toHaveBeenCalledWith(
      '/api/operator/orders/%D0%97%D0%90%D0%9A%D0%90%D0%97%20%2F%207/mass-summary',
      { signal: controller.signal },
    );
  });
});
