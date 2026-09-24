import {
  mapBalanceRecordWithRefs,
  mapInvoiceRecordWithLines,
  mapNomenclatureRecord,
  mapOrganizationRecord,
  mapPaymentRecordWithBasis,
  mapShipmentRecordWithLines,
  mapWarehouseRecord,
} from './onec-sync.mapper';

const AT = '2026-07-29T08:00:00.000Z';
const NOMENCLATURE_ID = '11111111-1111-1111-1111-111111111111';
const KIND_ID = '22222222-2222-2222-2222-222222222222';
const UNIT_ID = '33333333-3333-3333-3333-333333333333';
const ORGANIZATION_ID = '44444444-4444-4444-4444-444444444444';
const INVOICE_ID = '55555555-5555-5555-5555-555555555555';

describe('onec-sync.mapper (sanitized production OData shapes)', () => {
  it('preserves exact Cyrillic nomenclature identity and resolves dictionaries', () => {
    const fixture = {
      Ref_Key: NOMENCLATURE_ID,
      DataVersion: 'AAAAAQAAAAE=',
      Code: '00-000015',
      Description: 'ПВД 15803-020 short',
      НаименованиеПолное: '  ПВД 15803-020  ',
      Артикул: '',
      ВидНоменклатуры_Key: KIND_ID,
      ЕдиницаИзмерения_Key: UNIT_ID,
      DeletionMark: false,
      ВАрхиве: false,
    };

    const result = mapNomenclatureRecord(
      fixture,
      {
        kinds: new Map([[KIND_ID, 'Сырье']]),
        units: new Map([[UNIT_ID, 'кг']]),
      },
      AT,
    );

    expect(result.externalId).toBe(fixture.Ref_Key);
    expect(result.parsed.name).toBe('ПВД 15803-020');
    expect(result.parsed.fullName).toBe('ПВД 15803-020');
    expect(result.parsed.article).toBeNull();
    expect(result.parsed.kindName).toBe('Сырье');
    expect(result.parsed.unitName).toBe('кг');
  });

  it('falls back to Description without transliterating Cyrillic text', () => {
    const result = mapNomenclatureRecord(
      {
        Ref_Key: NOMENCLATURE_ID,
        Code: '0001',
        Description: 'Плёнка с печатью Ёлка',
        НаименованиеПолное: ' ',
        DeletionMark: false,
        ВАрхиве: false,
      },
      { kinds: new Map(), units: new Map() },
      AT,
    );

    expect(result.parsed.name).toBe('Плёнка с печатью Ёлка');
    expect(result.parsed.fullName).toBeNull();
  });

  it('rejects a missing or zero Ref_Key for identity-bearing records', () => {
    const dictionaries = { kinds: new Map<string, string>(), units: new Map<string, string>() };

    expect(() => mapNomenclatureRecord({ Description: 'Без ключа' }, dictionaries, AT)).toThrow(
      /Ref_Key/,
    );
    expect(() =>
      mapOrganizationRecord(
        {
          Ref_Key: '00000000-0000-0000-0000-000000000000',
          Description: 'Нулевой ключ',
        },
        AT,
      ),
    ).toThrow(/Ref_Key/);
  });

  it('maps organizations and warehouses as source catalogs', () => {
    expect(
      mapOrganizationRecord(
        {
          Ref_Key: ORGANIZATION_ID,
          DataVersion: 'org-v1',
          Code: '0001',
          Description: 'ТД Полимер',
          НаименованиеПолное: 'ООО «ТД Полимер»',
          ИНН: '0000000000',
          КПП: '000000000',
          DeletionMark: false,
        },
        AT,
      ).parsed,
    ).toMatchObject({ name: 'ТД Полимер', fullName: 'ООО «ТД Полимер»' });

    expect(
      mapWarehouseRecord(
        {
          Ref_Key: '66666666-6666-6666-6666-666666666666',
          Code: '000000001',
          Description: 'Основной склад',
          ТипСклада: 'ОптовыйСклад',
          DeletionMark: false,
        },
        AT,
      ).parsed,
    ).toMatchObject({ name: 'Основной склад', warehouseType: 'ОптовыйСклад' });
  });

  it('maps invoice header and its nested goods lines with finite numbers', () => {
    const result = mapInvoiceRecordWithLines(
      {
        Ref_Key: INVOICE_ID,
        DataVersion: 'invoice-v1',
        Number: '00-000001',
        Date: '2026-07-01T00:00:00',
        Posted: true,
        DeletionMark: false,
        Контрагент_Key: '77777777-7777-7777-7777-777777777777',
        Организация_Key: ORGANIZATION_ID,
        ВалютаДокумента_Key: '88888888-8888-8888-8888-888888888888',
        СуммаДокумента: '1250.50',
        Товары: [
          {
            LineNumber: '1',
            Номенклатура: NOMENCLATURE_ID,
            Содержание: 'ПВД 15803-020',
            Количество: '25',
            Цена: '50.02',
            Сумма: '1250.50',
          },
        ],
      },
      AT,
    );

    expect(result.parsed.total).toBe(1250.5);
    expect(result.parsed.lines).toEqual([
      {
        lineNumber: 1,
        nomenclatureExternalId: NOMENCLATURE_ID,
        name: 'ПВД 15803-020',
        quantity: 25,
        price: 50.02,
        amount: 1250.5,
        unitExternalId: null,
      },
    ]);
  });

  it('maps the configured exact order marker and safe invoice tax totals', () => {
    const result = mapInvoiceRecordWithLines(
      {
        Ref_Key: INVOICE_ID,
        Number: '00-000042',
        Posted: true,
        СуммаДокумента: '1200.00',
        СуммаБезНДС: '1000.00',
        СуммаНДС: '200.00',
        КомментарийПлатформы: 'PLENKA_ORDER=ЗК-0042',
        Товары: [
          {
            LineNumber: 1,
            Количество: 20,
            Цена: 60,
            Сумма: 1200,
            СтавкаНДС: '20%',
            СуммаНДС: 200,
          },
        ],
      },
      AT,
      'КомментарийПлатформы',
    );

    expect(result.parsed).toMatchObject({
      orderReference: 'PLENKA_ORDER=ЗК-0042',
      subtotal: 1000,
      taxTotal: 200,
      lines: [
        expect.objectContaining({
          taxRate: '20%',
          taxAmount: 200,
        }),
      ],
    });
  });

  it('links a payment only when its basis type is a customer invoice', () => {
    const linked = mapPaymentRecordWithBasis(
      {
        Ref_Key: '99999999-9999-9999-9999-999999999999',
        Number: 'ПП-1',
        СуммаДокумента: 100,
        ДокументОснование: INVOICE_ID,
        ДокументОснование_Type: 'StandardODATA.Document_СчетНаОплатуПокупателю',
      },
      AT,
    );
    const unrelated = mapPaymentRecordWithBasis(
      {
        Ref_Key: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        Number: 'ПП-2',
        СуммаДокумента: 100,
        ДокументОснование: INVOICE_ID,
        ДокументОснование_Type: 'StandardODATA.Document_РеализацияТоваровУслуг',
      },
      AT,
    );

    expect(linked.parsed.documentBasisExternalId).toBe(INVOICE_ID);
    expect(linked.parsed.invoiceExternalId).toBe(INVOICE_ID);
    expect(unrelated.parsed.documentBasisExternalId).toBe(INVOICE_ID);
    expect(unrelated.parsed.invoiceExternalId).toBeNull();
  });

  it('maps shipment invoice GUID and goods-line nomenclature GUID', () => {
    const result = mapShipmentRecordWithLines(
      {
        Ref_Key: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        Number: 'РТУ-1',
        СуммаДокумента: 90,
        СчетНаОплатуПокупателю_Key: INVOICE_ID,
        Товары: [
          {
            LineNumber: 1,
            Номенклатура_Key: NOMENCLATURE_ID,
            ЕдиницаИзмерения_Key: UNIT_ID,
            Количество: 3,
            Цена: 30,
            Сумма: 90,
          },
        ],
      },
      AT,
    );

    expect(result.parsed.invoiceExternalId).toBe(INVOICE_ID);
    expect(result.parsed.lines?.[0]).toMatchObject({
      nomenclatureExternalId: NOMENCLATURE_ID,
      unitExternalId: UNIT_ID,
    });
  });

  it('finds nomenclature GUID in the typed balance dimensions', () => {
    const result = mapBalanceRecordWithRefs(
      {
        Account_Key: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        Организация_Key: ORGANIZATION_ID,
        ExtDimension1: NOMENCLATURE_ID,
        ExtDimension1_Type: 'StandardODATA.Catalog_Номенклатура',
        ExtDimension2: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        ExtDimension2_Type: 'StandardODATA.Catalog_Склады',
        КоличествоBalance: '39.25',
        СуммаBalance: '12000.10',
      },
      '10.01',
      AT,
    );

    expect(result.parsed).toMatchObject({
      account: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      accountCode: '10.01',
      organizationExternalId: ORGANIZATION_ID,
      nomenclatureExternalId: NOMENCLATURE_ID,
      qty: 39.25,
      amount: 12000.1,
    });
  });
});
