import { describe, expect, it } from 'vitest';

import {
  isWarehouseInventorySection,
  normalizeWarehouseNotificationUrl,
  normalizeWarehouseSectionUrl,
  resolveWarehouseSection,
  WAREHOUSE_SECTION_REGISTRY,
  WAREHOUSE_STOCK_SECTION,
  WAREHOUSE_VISIBLE_SECTIONS,
  warehouseInventoryCategoryForSection,
} from './warehouseSections';

describe('warehouse section registry', () => {
  it('publishes one exact visible order without legacy duplicate sections', () => {
    expect(WAREHOUSE_SECTION_REGISTRY.map(({ label }) => label)).toEqual([
      'Приемка',
      'Прием брака',
      'Отгрузка брака',
      'Все рулоны',
      'Выдача',
      'Сырье',
      'Расходники',
      'Движения',
    ]);
    expect(WAREHOUSE_VISIBLE_SECTIONS).toEqual([
      'Приемка',
      'Прием брака',
      'Отгрузка брака',
      'Все рулоны',
      'Выдача',
      'Сырье',
    ]);
    expect(WAREHOUSE_STOCK_SECTION).toBe('Все рулоны');
    expect(WAREHOUSE_VISIBLE_SECTIONS).not.toContain('Склад рулонов');
    expect(WAREHOUSE_VISIBLE_SECTIONS).not.toContain('Запасы / резерв');
    expect(WAREHOUSE_VISIBLE_SECTIONS).not.toContain('Расходники');
    expect(WAREHOUSE_VISIBLE_SECTIONS).not.toContain('Движения');
  });

  it('resolves stock aliases before interpreting or cleaning their legacy params', () => {
    expect(
      resolveWarehouseSection(
        'Склад рулонов',
        new URLSearchParams('stockBucket=processed&view=processed'),
      ),
    ).toMatchObject({
      section: WAREHOUSE_STOCK_SECTION,
      inventoryView: 'rolls',
      categoryId: 'rolls',
    });
    expect(resolveWarehouseSection('Запасы / резерв')).toMatchObject({
      section: WAREHOUSE_STOCK_SECTION,
      inventoryView: 'rolls',
      categoryId: 'rolls',
    });
    expect(
      resolveWarehouseSection('Запасы / резерв', new URLSearchParams('stockBucket=processed')),
    ).toMatchObject({
      section: WAREHOUSE_STOCK_SECTION,
      inventoryView: 'processed',
      categoryId: 'reserve',
    });
    expect(
      resolveWarehouseSection(WAREHOUSE_STOCK_SECTION, new URLSearchParams('view=processed')),
    ).toMatchObject({
      section: WAREHOUSE_STOCK_SECTION,
      inventoryView: 'processed',
      categoryId: 'reserve',
    });
    expect(
      resolveWarehouseSection(WAREHOUSE_STOCK_SECTION, new URLSearchParams('view=unknown')),
    ).toMatchObject({
      inventoryView: 'rolls',
      categoryId: 'rolls',
    });
  });

  it('keeps the raw-material section separate while normalizing its spelling alias', () => {
    expect(resolveWarehouseSection('Сырьё')).toMatchObject({
      section: 'Сырье',
      inventoryView: null,
      categoryId: 'raw',
    });
    expect(resolveWarehouseSection('Отгрузка')).toMatchObject({
      section: 'Выдача',
      inventoryView: null,
      categoryId: null,
    });
    expect(warehouseInventoryCategoryForSection('Сырьё')).toBe('raw');
    expect(isWarehouseInventorySection('Сырьё')).toBe(true);
    expect(isWarehouseInventorySection('Приемка')).toBe(false);
  });
});

describe('warehouse section URL migration', () => {
  it('preserves unrelated params and converts the processed legacy alias atomically', () => {
    const url = normalizeWarehouseSectionUrl(
      'http://localhost/?role=warehouse&section=%D0%97%D0%B0%D0%BF%D0%B0%D1%81%D1%8B+%2F+%D1%80%D0%B5%D0%B7%D0%B5%D1%80%D0%B2&stockBucket=processed&availability=available&object=roll-1&debug=1',
    );

    expect(url.searchParams.get('role')).toBe('warehouse');
    expect(url.searchParams.get('section')).toBe(WAREHOUSE_STOCK_SECTION);
    expect(url.searchParams.get('view')).toBe('processed');
    expect(url.searchParams.get('object')).toBe('roll-1');
    expect(url.searchParams.get('debug')).toBe('1');
    expect(url.searchParams.has('stockBucket')).toBe(false);
    expect(url.searchParams.has('availability')).toBe(false);
  });

  it('lets the legacy reserve alias choose rolls unless stockBucket explicitly says processed', () => {
    const url = normalizeWarehouseSectionUrl(
      'http://localhost/?role=warehouse&section=%D0%97%D0%B0%D0%BF%D0%B0%D1%81%D1%8B+%2F+%D1%80%D0%B5%D0%B7%D0%B5%D1%80%D0%B2&stockBucket=available&view=processed&debug=1',
    );

    expect(url.searchParams.get('section')).toBe(WAREHOUSE_STOCK_SECTION);
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.has('stockBucket')).toBe(false);
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('does not carry a stale stock view into the separate raw-material section', () => {
    const url = normalizeWarehouseSectionUrl(
      'http://localhost/?role=warehouse&section=%D0%A1%D1%8B%D1%80%D1%8C%D1%91&view=processed&debug=1',
    );

    expect(url.searchParams.get('section')).toBe('Сырье');
    expect(url.searchParams.has('view')).toBe(false);
    expect(url.searchParams.get('debug')).toBe('1');
  });

  it('clears stale inventory filters and cursor for notification navigation', () => {
    const url = normalizeWarehouseNotificationUrl(
      'http://localhost/?role=warehouse&section=%D0%97%D0%B0%D0%BF%D0%B0%D1%81%D1%8B+%2F+%D1%80%D0%B5%D0%B7%D0%B5%D1%80%D0%B2&stockBucket=processed&view=processed&q=film&batch=B-1&minAgeDays=1&maxAgeDays=30&status=reserved&counterparty=C-1&sort=age&direction=desc&cursor=next&limit=50&page=3&size=50&table=stock&from=2026-08-01&to=2026-08-07&f.status=ready&object=notice-1&debug=1',
    );

    expect(url.searchParams.get('section')).toBe(WAREHOUSE_STOCK_SECTION);
    expect(url.searchParams.get('role')).toBe('warehouse');
    expect(url.searchParams.get('object')).toBe('notice-1');
    expect(url.searchParams.get('debug')).toBe('1');
    for (const key of [
      'stockBucket',
      'view',
      'q',
      'batch',
      'minAgeDays',
      'maxAgeDays',
      'status',
      'counterparty',
      'sort',
      'direction',
      'cursor',
      'limit',
      'page',
      'size',
      'table',
      'from',
      'to',
      'f.status',
    ]) {
      expect(url.searchParams.has(key), key).toBe(false);
    }
  });
});
