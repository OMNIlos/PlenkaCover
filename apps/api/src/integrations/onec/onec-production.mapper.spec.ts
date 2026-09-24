import {
  mapProductionMaterialLineRecord,
  mapProductionOutputLineRecord,
  mapProductionReportRecord,
} from './onec-production.mapper';

const REPORT_ID = '11111111-1111-1111-1111-111111111111';
const NOMENCLATURE_ID = '22222222-2222-2222-2222-222222222222';
const UNIT_ID = '33333333-3333-3333-3333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-4444-444444444444';
const ORGANIZATION_ID = '55555555-5555-5555-5555-555555555555';
const WAREHOUSE_ID = '66666666-6666-6666-6666-666666666666';
const DEPARTMENT_ID = '77777777-7777-7777-7777-777777777777';

const dictionaries = {
  kinds: new Map<string, string>(),
  units: new Map([[UNIT_ID, 'кг']]),
};
const invalidNumericValues: unknown[] = [undefined, null, '', ' ', [], {}, false, NaN, Infinity];

describe('onec-production.mapper', () => {
  it('maps a production report and interprets the offset-free date as Moscow time', () => {
    const result = mapProductionReportRecord(
      {
        Ref_Key: REPORT_ID,
        DataVersion: 'AAAAAQAAAAE=',
        Number: '000000001',
        Date: '2026-06-30T13:00:00',
        Posted: true,
        DeletionMark: false,
        Организация_Key: ORGANIZATION_ID,
        Склад_Key: WAREHOUSE_ID,
        ПодразделениеОрганизации_Key: DEPARTMENT_ID,
      },
      '2026-07-29T12:00:00.000Z',
    );

    expect(result).toMatchObject({
      subjectType: 'production_report',
      externalId: REPORT_ID,
      sourceVersion: 'AAAAAQAAAAE=',
      parsed: {
        number: '000000001',
        date: '2026-06-30T10:00:00.000Z',
        posted: true,
        deleted: false,
      },
    });
  });

  it('rejects a non-finite production quantity', () => {
    expect(() =>
      mapProductionOutputLineRecord(
        {
          Ref_Key: REPORT_ID,
          LineNumber: 1,
          Номенклатура_Key: NOMENCLATURE_ID,
          ЕдиницаИзмерения_Key: UNIT_ID,
          Количество: 'not-a-number',
        },
        dictionaries,
      ),
    ).toThrow('ONEC_INVALID_NUMBER');
  });

  it('rejects a missing production quantity instead of normalizing it to zero', () => {
    expect(() =>
      mapProductionOutputLineRecord({ Ref_Key: REPORT_ID, LineNumber: 1 }, dictionaries),
    ).toThrow('ONEC_INVALID_NUMBER');
  });

  it.each(invalidNumericValues)('rejects an invalid production quantity value: %p', (quantity) => {
    expect(() =>
      mapProductionOutputLineRecord(
        { Ref_Key: REPORT_ID, LineNumber: 1, Количество: quantity },
        dictionaries,
      ),
    ).toThrow('ONEC_INVALID_NUMBER');
  });

  it('rejects a missing line number instead of normalizing it to zero', () => {
    expect(() =>
      mapProductionOutputLineRecord({ Ref_Key: REPORT_ID, Количество: 1 }, dictionaries),
    ).toThrow('ONEC_INVALID_NUMBER');
  });

  it.each(invalidNumericValues)('rejects an invalid line number value: %p', (value) => {
    expect(() =>
      mapProductionOutputLineRecord(
        { Ref_Key: REPORT_ID, LineNumber: value, Количество: 1 },
        dictionaries,
      ),
    ).toThrow('ONEC_INVALID_NUMBER');
  });

  it('preserves numeric string zero for a production line', () => {
    expect(
      mapProductionOutputLineRecord(
        { Ref_Key: REPORT_ID, LineNumber: '0', Количество: '0' },
        dictionaries,
      ).parsed,
    ).toMatchObject({ lineNumber: 0, quantity: 0 });
  });

  it('preserves an explicit source timezone instead of applying Moscow twice', () => {
    const result = mapProductionReportRecord(
      {
        Ref_Key: REPORT_ID,
        Date: '2026-06-30T13:00:00Z',
        Posted: true,
        DeletionMark: false,
      },
      '2026-07-29T12:00:00.000Z',
    );

    expect(result.parsed.date).toBe('2026-06-30T13:00:00.000Z');
  });

  it('maps output lines with their resolved source unit', () => {
    expect(
      mapProductionOutputLineRecord(
        {
          Ref_Key: REPORT_ID,
          LineNumber: '1',
          Номенклатура_Key: NOMENCLATURE_ID,
          ЕдиницаИзмерения_Key: UNIT_ID,
          Количество: '12.5',
        },
        dictionaries,
      ),
    ).toMatchObject({
      reportExternalId: REPORT_ID,
      parsed: {
        lineNumber: 1,
        nomenclatureExternalId: NOMENCLATURE_ID,
        unitExternalId: UNIT_ID,
        unitName: 'кг',
        quantity: 12.5,
      },
    });
  });

  it('maps a signed material correction and its product reference', () => {
    expect(
      mapProductionMaterialLineRecord(
        {
          Ref_Key: REPORT_ID,
          LineNumber: 2,
          Номенклатура_Key: NOMENCLATURE_ID,
          Продукция_Key: PRODUCT_ID,
          ЕдиницаИзмерения_Key: UNIT_ID,
          Количество: '-0.75',
        },
        dictionaries,
      ),
    ).toMatchObject({
      reportExternalId: REPORT_ID,
      parsed: {
        lineNumber: 2,
        nomenclatureExternalId: NOMENCLATURE_ID,
        productExternalId: PRODUCT_ID,
        unitExternalId: UNIT_ID,
        unitName: 'кг',
        quantity: -0.75,
      },
    });
  });

  it('rejects malformed dates and invalid line numbers instead of silently normalizing them', () => {
    expect(() =>
      mapProductionReportRecord(
        { Ref_Key: REPORT_ID, Date: '2026-06-30' },
        '2026-07-29T12:00:00.000Z',
      ),
    ).toThrow('ONEC_INVALID_DATE');
    expect(() =>
      mapProductionOutputLineRecord(
        { Ref_Key: REPORT_ID, LineNumber: -1, Количество: 1 },
        dictionaries,
      ),
    ).toThrow('ONEC_INVALID_LINE_NUMBER');
  });
});
