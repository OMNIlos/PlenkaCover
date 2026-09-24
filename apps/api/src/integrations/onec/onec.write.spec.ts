import { buildGoodsPostingBody, onecDateTime } from './onec.write';

const refs = { orgKey: 'ORG', warehouseKey: 'WH', accountKey: 'ACC', nomenclatureKey: 'NOM' };

describe('onec.write (goods-posting body builder)', () => {
  it('builds header + one Товары line per stock item', () => {
    const body = buildGoodsPostingBody(
      [
        { materialId: 'm1', qty: 100, unit: 'кг' },
        { materialId: 'm2', qty: 5, unit: 'кг' },
      ],
      refs,
      '2026-07-03T12:00:00',
    ) as any;
    expect(body.Date).toBe('2026-07-03T12:00:00');
    expect(body.Организация_Key).toBe('ORG');
    expect(body.Склад_Key).toBe('WH');
    expect(body.Товары).toHaveLength(2);
    expect(body.Товары[0]).toMatchObject({
      LineNumber: '1',
      Номенклатура_Key: 'NOM',
      Количество: 100,
      Сумма: 100,
      СчетУчета_Key: 'ACC',
    });
    expect(body.Товары[1]).toMatchObject({ LineNumber: '2', Количество: 5, Сумма: 5 });
  });

  it('onecDateTime drops the timezone suffix', () => {
    expect(onecDateTime(new Date('2026-07-03T12:00:00.000Z'))).toBe('2026-07-03T12:00:00');
  });
});
