import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FinanceRawMaterialsTable } from './FinanceRawMaterialsSurface';

describe('FinanceRawMaterialsTable', () => {
  it('labels the initial and current facts within each independent BigBag row', () => {
    const html = renderToStaticMarkup(
      <FinanceRawMaterialsTable
        rows={[
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД',
            supplier: 'ООО Гранула',
            batchCode: 'LOT-01',
            receivedAt: '2026-08-01T08:00:00.000Z',
            initialWeightKg: '12.345',
            purchasePricePerKg: '25.00',
            initialValue: '308.63',
            currentWeightKg: '8.100',
            measuredAt: '2026-08-10T10:00:00.000Z',
            currentValue: '202.50',
            consumedWeightKg: '4.245',
            consumedValue: '106.13',
          },
        ]}
      />,
    );

    expect(html).toContain('Изначальные данные');
    expect(html).toContain('Текущие данные');
    expect(html).toContain('aria-label="Финансовое состояние партий BigBag"');
    expect(html).toContain('scope="colgroup"');
    expect(html).toContain('Партия: LOT-01');
    expect(html).toContain('Поставщик: ООО Гранула');
    expect(html).toContain('Цена за кг');
    expect(html).toContain('Первоначальная стоимость');
    expect(html).toContain('Стоимость остатка');
    expect(html).toContain('Измерено');
    expect(html).toContain('Стоимость расхода');
  });

  it('renders a missing purchase price as Нет данных without a misleading unit suffix', () => {
    const html = renderToStaticMarkup(
      <FinanceRawMaterialsTable
        rows={[
          {
            id: 'bag-2',
            code: 'BB-002',
            material: 'ПВД',
            supplier: null,
            batchCode: null,
            receivedAt: null,
            initialWeightKg: '12.345',
            purchasePricePerKg: null,
            initialValue: null,
            currentWeightKg: '8.100',
            measuredAt: null,
            currentValue: null,
            consumedWeightKg: null,
            consumedValue: null,
          },
        ]}
      />,
    );

    expect(html).toContain('Цена за кг');
    expect(html).toContain('Нет данных');
    expect(html).not.toContain('Нет данных / кг');
  });

  it('renders backend financial facts without merging BigBags or turning null into zero', () => {
    const html = renderToStaticMarkup(
      <FinanceRawMaterialsTable
        rows={[
          {
            id: 'bag-1',
            code: 'BB-001',
            material: 'ПВД',
            supplier: 'ООО Гранула',
            batchCode: 'LOT-01',
            receivedAt: '2026-08-01T08:00:00.000Z',
            initialWeightKg: '12.345',
            purchasePricePerKg: '25.00',
            initialValue: '308.63',
            currentWeightKg: '8.100',
            measuredAt: '2026-08-10T10:00:00.000Z',
            currentValue: '202.50',
            consumedWeightKg: '4.245',
            consumedValue: '106.13',
          },
          {
            id: 'bag-2',
            code: 'BB-002',
            material: 'ПВД',
            supplier: null,
            batchCode: 'LOT-02',
            receivedAt: null,
            initialWeightKg: null,
            purchasePricePerKg: null,
            initialValue: null,
            currentWeightKg: null,
            measuredAt: null,
            currentValue: null,
            consumedWeightKg: null,
            consumedValue: null,
          },
        ]}
      />,
    );

    expect(html).toContain('BB-001');
    expect(html).toContain('BB-002');
    expect(html).toContain('308,63 ₽');
    expect(html).toContain('106,13 ₽');
    expect(html).toContain('Поставщик: ООО Гранула');
    expect(html).toContain('Поставщик: Нет данных');
    expect(html).toContain('Нет данных');
    expect(html).not.toContain('Сверка источников');
    expect(html).not.toContain('1С');
  });
});
