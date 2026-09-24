import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { liveRawMaterialsToWorkObject } from '../../api/warehouse';
import { DetailView } from './workObjectSurfaces';

vi.mock('../../api/liveContours', () => ({
  isLiveContour: (role: string) => role === 'finance',
}));

const cachedWarehouseObject = liveRawMaterialsToWorkObject([
  {
    id: 'cached-stock',
    rawMaterialId: 'cached-material',
    label: 'Устаревший складской остаток',
    materialKind: 'primary',
    qty: 999,
    actualQty: 999,
    unit: 'кг',
    source: 'warehouse_fact',
    sourceOfTruthStatus: 'актуально',
    updatedAt: '2026-08-09T08:00:00.000Z',
  },
]);

const requiredProps = {
  role: 'finance' as const,
  templateCatalog: [],
  templateVersions: [],
  onTemplateSelect: vi.fn(),
  activeSection: 'Сырье',
};

describe('finance live raw-material boundary', () => {
  it.each([
    ['fresh session', null],
    ['warehouse cache present', cachedWarehouseObject],
  ] as const)('loads only the finance projection and ignores warehouse cache: %s', (_, object) => {
    const html = renderToStaticMarkup(<DetailView {...requiredProps} object={object} />);

    expect(html).toContain('Финансовый учёт BigBag');
    expect(html).toContain('Загружаем финансовые факты BigBag');
    expect(html).not.toContain('Устаревший складской остаток');
    expect(html).not.toContain('Обновить учетную цену');
    expect(html).not.toContain('aria-label="Модуль сырья"');
  });
});
