import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { liveRawMaterialsToWorkObject } from '../../api/warehouse';
import { DetailView } from './workObjectSurfaces';

const legacyWarehouseFixture = liveRawMaterialsToWorkObject([
  {
    id: 'legacy-stock',
    rawMaterialId: 'legacy-material',
    label: 'Выдуманный demo-остаток',
    materialKind: 'primary',
    qty: 999,
    actualQty: 999,
    unit: 'кг',
    source: 'warehouse_fact',
    sourceOfTruthStatus: 'актуально',
    updatedAt: '2026-07-17T08:00:00.000Z',
  },
]);

const requiredProps = {
  object: legacyWarehouseFixture,
  templateCatalog: [],
  templateVersions: [],
  onTemplateSelect: vi.fn(),
  activeSection: 'Сырье',
};

describe('commercial/production/director raw-material route boundary', () => {
  it.each(['commercial', 'production', 'director'] as const)(
    'uses the same simple Big-Bag register for %s instead of legacy inventory logic',
    (role) => {
      const html = renderToStaticMarkup(<DetailView {...requiredProps} role={role} />);

      expect(html).toContain('aria-label="Реестр Big-Bag"');
      expect(html).toContain('Загружаем Big-Bag');
      expect(html).not.toContain('Выдуманный demo-остаток');
      expect(html).not.toContain('aria-label="Модуль сырья"');
      expect(html).not.toContain('aria-label="Big-Bag в производстве"');
      expect(html).not.toContain('aria-label="Сырье: складской учёт"');
      if (role === 'production') {
        expect(html).toContain('aria-label="Приход шпуль"');
      } else {
        expect(html).not.toContain('aria-label="Приход шпуль"');
      }
    },
  );

  it('reuses the roll registry for the director without warehouse-only filters or mutations', () => {
    const html = renderToStaticMarkup(
      <DetailView
        {...requiredProps}
        role="director"
        object={null}
        activeSection="Все рулоны"
        effectiveCapabilities={['warehouse_inventory:read']}
      />,
    );

    expect(html).toContain('aria-label="Все рулоны"');
    expect(html).toContain('Рулоны на складе');
    expect(html).toContain('aria-label="Поиск рулонов"');
    expect(html).toContain('aria-label="Статус"');
    expect(html).toContain('aria-label="Контрагент"');
    expect(html).not.toContain('aria-label="Партия"');
    expect(html).not.toContain('aria-label="Возраст от, дней"');
    expect(html).not.toContain('aria-label="Возраст до, дней"');
    expect(html).not.toContain('+ Добавить рулон');
  });
});
