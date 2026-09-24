import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWarehouseReserveRoll,
  type WarehouseReserveRoll,
  type WarehouseReserveRollCreateInput,
} from './warehouse';

const input: WarehouseReserveRollCreateInput = {
  operationKey: '018f0b6a-7094-4b54-8c88-cb44c92807eb',
  rollCode: 'RES-001',
  batchCode: 'ПАРТИЯ-1',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  baseRawMaterialDefinitionId: 'material-primary',
};

const roll: WarehouseReserveRoll = {
  id: 'roll-1',
  rollCode: 'RES-001',
  batchCode: 'ПАРТИЯ-1',
  sourceOrderId: 'order-1',
  sourceOrderNumber: 'WR-001',
  filmType: 'Рукав',
  actualThicknessMicron: 80,
  accountingThicknessMicron: 78,
  widthMm: 1_200,
  plannedLengthM: 800,
  grossKg: 41.9,
  spoolKg: 0.7,
  netKg: 41.2,
  plannedNetKg: 41,
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  materialLabel: 'ПВД первичный',
  source: 'platform',
  availability: 'available',
  receivedAt: '2026-08-06T01:00:00.000Z',
  qrReady: true,
};

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('warehouse reserve roll API', () => {
  it('submits one idempotent platform command and accepts the exact safe projection', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(roll));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createWarehouseReserveRoll(input)).resolves.toEqual(roll);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/finished-stock',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(input),
      }),
    );
  });

  it.each([
    { ...roll, rawPayload: { secret: true } },
    { ...roll, qrCode: `prt_${'a'.repeat(64)}` },
    { ...roll, source: '1C' },
    { ...roll, netKg: Number.NaN },
    { ...roll, receivedAt: 'not-a-date' },
  ])('rejects malformed or overexposed server results', async (unsafe) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(unsafe)));

    await expect(createWarehouseReserveRoll(input)).rejects.toThrow(
      'Некорректный ответ регистрации рулона',
    );
  });
});
