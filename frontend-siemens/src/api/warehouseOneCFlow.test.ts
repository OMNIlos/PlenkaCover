import { describe, expect, it } from 'vitest';

import type { WarehouseOneCStockPushPreview, WarehouseOneCStockPushResult } from './warehouse';
import {
  isExactWarehouseOneCConfirmation,
  isValidWarehouseOneCPreview,
  isVerifiedWarehouseOneCResult,
  warehouseOneCReadinessError,
  warehouseOneCSuccessTitle,
} from './warehouseOneCFlow';

const hash = 'a'.repeat(64);
const operationKey = '2c0190d9-4db0-49ff-8358-f6f0a393b44c';

function result(
  overrides: Partial<WarehouseOneCStockPushResult> = {},
): WarehouseOneCStockPushResult {
  return {
    operationKey,
    pushed: 1,
    count: 1,
    totalQty: 42,
    items: [{ materialId: 'rm-1', qty: 42, unit: 'кг' }],
    snapshotHash: hash,
    replayed: false,
    ack: {
      accepted: true,
      count: 1,
      ref: '0000-000001',
      mode: 'http',
      documentCreated: true,
    },
    ...overrides,
  };
}

describe('warehouse demo-1C posting flow', () => {
  it('requires the exact explicit confirmation', () => {
    expect(isExactWarehouseOneCConfirmation('ПРОВЕСТИ')).toBe(true);
    expect(isExactWarehouseOneCConfirmation('провести')).toBe(false);
    expect(isExactWarehouseOneCConfirmation(' ПРОВЕСТИ ')).toBe(true);
  });

  it('accepts only a non-empty, internally consistent server preview', () => {
    const preview: WarehouseOneCStockPushPreview = {
      snapshotHash: hash,
      count: 1,
      totalQty: 42,
      writeReady: true,
      readinessCode: 'ready',
      readinessMessage: 'Демо-1С готова к тестовой записи.',
      items: [{ materialId: 'rm-1', qty: 42, unit: 'кг' }],
    };
    expect(isValidWarehouseOneCPreview(preview)).toBe(true);
    expect(isValidWarehouseOneCPreview({ ...preview, count: 0, items: [] })).toBe(false);
    expect(isValidWarehouseOneCPreview({ ...preview, snapshotHash: 'bad' })).toBe(false);
  });

  it('stops before confirmation when the server write gate is not ready', () => {
    const preview: WarehouseOneCStockPushPreview = {
      snapshotHash: hash,
      count: 1,
      totalQty: 42,
      items: [{ materialId: 'rm-1', qty: 42, unit: 'кг' }],
      writeReady: false,
      readinessCode: 'write_disabled',
      readinessMessage: 'Запись в демо-1С выключена на VPS.',
    };
    expect(isValidWarehouseOneCPreview(preview)).toBe(true);
    expect(warehouseOneCReadinessError(preview)).toBe('Запись в демо-1С выключена на VPS.');
    expect(warehouseOneCReadinessError({ ...preview, writeReady: true })).toBeNull();
  });

  it('binds success to the confirmed hash and rejects mock/noop/incomplete acknowledgements', () => {
    expect(isVerifiedWarehouseOneCResult(result(), operationKey, hash)).toBe(true);
    expect(
      isVerifiedWarehouseOneCResult(
        result({ operationKey: crypto.randomUUID() }),
        operationKey,
        hash,
      ),
    ).toBe(false);
    expect(
      isVerifiedWarehouseOneCResult(result({ snapshotHash: 'b'.repeat(64) }), operationKey, hash),
    ).toBe(false);
    expect(isVerifiedWarehouseOneCResult(result({ count: 2 }), operationKey, hash)).toBe(false);
    expect(
      isVerifiedWarehouseOneCResult(
        result({ ack: { ...result().ack, ref: 'mock-stock-push-1' } }),
        operationKey,
        hash,
      ),
    ).toBe(false);
    expect(
      isVerifiedWarehouseOneCResult(
        result({ ack: { ...result().ack, ref: 'noop' } }),
        operationKey,
        hash,
      ),
    ).toBe(false);
    expect(
      isVerifiedWarehouseOneCResult(result({ pushed: 0, count: 0, items: [] }), operationKey, hash),
    ).toBe(false);
  });

  it('labels a deduplicated replay without claiming a second document', () => {
    expect(warehouseOneCSuccessTitle(result())).toContain('проведён');
    expect(warehouseOneCSuccessTitle(result({ replayed: true }))).toContain('Ранее');
  });
});
