import { describe, expect, it, vi } from 'vitest';

import type { WorkObject } from './types';
import {
  decodeWarehouseScanAction,
  isWarehouseScanSection,
  normalizeWarehouseSection,
  replaceObjectSelectionInUrl,
  WAREHOUSE_SCAN_SECTIONS,
  WarehouseScanSubmissionGate,
  warehousePalletScanIntent,
  warehouseObjectMatchesScanSection,
} from './warehouseScan';

function operation(id: string, tag: 'Приемка' | 'Выдача' | 'Отгрузка'): WorkObject {
  return {
    id,
    statusLabel: tag,
    filterTags: [tag],
    workbench: {
      type: 'warehouse',
      mode: tag === 'Приемка' ? 'receiving' : 'delivery',
    },
  } as WorkObject;
}

function coverOperation(): WorkObject {
  return {
    id: 'WH-COVER-order-1',
    kind: 'warehouseJob',
    statusLabel: 'Проверить покрытие',
    filterTags: ['Запасы / резерв', 'Требуют действия'],
    warehouseCoverTask: { orderId: 'order-1' },
  } as WorkObject;
}

describe('warehouse scan section contract', () => {
  it('publishes two canonical scan sections and normalizes the legacy label', () => {
    expect(WAREHOUSE_SCAN_SECTIONS).toEqual(['Приемка', 'Выдача']);
    expect(normalizeWarehouseSection('Отгрузка')).toBe('Выдача');
    expect(normalizeWarehouseSection('Выдача')).toBe('Выдача');
    expect(normalizeWarehouseSection('Склад рулонов')).toBe('Все рулоны');
    expect(normalizeWarehouseSection('Запасы / резерв')).toBe('Все рулоны');
    expect(normalizeWarehouseSection('Сырьё')).toBe('Сырье');
    expect(isWarehouseScanSection('Отгрузка')).toBe(true);
    expect(isWarehouseScanSection('Склад рулонов')).toBe(false);
    expect(isWarehouseScanSection('Запасы и сырьё')).toBe(false);
    expect(isWarehouseScanSection('Все рулоны')).toBe(false);
  });

  it('shows legacy shipment and issue rows together in Выдача', () => {
    expect(warehouseObjectMatchesScanSection(operation('issue-1', 'Выдача'), 'Выдача')).toBe(true);
    expect(warehouseObjectMatchesScanSection(operation('ship-1', 'Отгрузка'), 'Выдача')).toBe(true);
    expect(warehouseObjectMatchesScanSection(operation('ship-1', 'Отгрузка'), 'Отгрузка')).toBe(
      true,
    );
    expect(warehouseObjectMatchesScanSection(operation('receive-1', 'Приемка'), 'Выдача')).toBe(
      false,
    );
  });

  it('routes a pallet QR to delivery only from the Выдача section', () => {
    expect(warehousePalletScanIntent('Выдача')).toBe('delivery');
    expect(warehousePalletScanIntent('Отгрузка')).toBe('delivery');
    expect(warehousePalletScanIntent('Приемка')).toBe('handoff');
    expect(warehousePalletScanIntent('Все рулоны')).toBe('handoff');
  });

  it('never treats a reserve cover task as a receiving operation', () => {
    const cover = coverOperation();

    expect(warehouseObjectMatchesScanSection(cover, 'Приемка')).toBe(false);
    expect(warehouseObjectMatchesScanSection(cover, 'Выдача')).toBe(false);
    expect(warehouseObjectMatchesScanSection(cover, 'Отгрузка')).toBe(false);
  });
});

describe('warehouse scan interaction contract', () => {
  it('decodes the exact payload from an encoded scan action', () => {
    const payload = '{"v":1,"roll":"A-2001-roll-1"}';
    const action = `warehouse.scan:intake-t1:${encodeURIComponent(payload)}`;
    expect(decodeWarehouseScanAction(action)).toBe(payload);
    expect(decodeWarehouseScanAction('warehouse.scan:intake-t1')).toBeNull();
  });

  it('adds and removes object selection without losing role and section', () => {
    const selected = replaceObjectSelectionInUrl(
      'http://localhost/?role=warehouse&section=Приемка',
      'intake-t1',
    );
    expect(selected.searchParams.get('object')).toBe('intake-t1');

    const cleared = replaceObjectSelectionInUrl(selected.toString(), null);
    expect(cleared.searchParams.get('role')).toBe('warehouse');
    expect(cleared.searchParams.get('section')).toBe('Приемка');
    expect(cleared.searchParams.has('object')).toBe(false);
  });

  it('coalesces two rapid submissions into one request', async () => {
    const gate = new WarehouseScanSubmissionGate();
    let resolve!: (value: boolean) => void;
    const submit = vi.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );

    const first = gate.run('QR-1', submit);
    const second = gate.run('QR-1', submit);

    expect(first).toBe(second);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('QR-1');
    resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it('queues distinct rapid scans in order without waiting for the scanner', async () => {
    const gate = new WarehouseScanSubmissionGate();
    let resolveFirst!: (value: boolean) => void;
    const submit = vi.fn((payload: string) =>
      payload === 'QR-1'
        ? new Promise<boolean>((resolve) => {
            resolveFirst = resolve;
          })
        : Promise.resolve(true),
    );

    const first = gate.run('QR-1', submit);
    const second = gate.run('QR-2', submit);

    expect(second).not.toBe(first);
    expect(submit).toHaveBeenCalledTimes(1);
    resolveFirst(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(submit.mock.calls.map(([payload]) => payload)).toEqual(['QR-1', 'QR-2']);
  });
});
