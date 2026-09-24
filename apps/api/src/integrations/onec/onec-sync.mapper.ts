import type {
  OneCInvoiceLineParsed,
  OneCInvoiceLineSource,
  OneCInvoiceSnapshot,
  OneCNomenclatureSnapshot,
  OneCOrganizationSnapshot,
  OneCPaymentSnapshot,
  OneCShipmentLineParsed,
  OneCShipmentLineSource,
  OneCShipmentSnapshot,
  OneCStockSnapshot,
  OneCWarehouseSnapshot,
} from '@plenka/contracts';

type ODataRecord = Record<string, unknown>;

export interface OneCNomenclatureDictionaries {
  kinds: ReadonlyMap<string, string>;
  units: ReadonlyMap<string, string>;
}

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_INVOICE_TYPE = 'StandardODATA.Document_СчетНаОплатуПокупателю';

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

function optionalGuid(value: unknown): string | null {
  const result = text(value);
  return result && result !== ZERO_GUID && GUID_PATTERN.test(result) ? result : null;
}

function requiredGuid(record: ODataRecord): string {
  const result = optionalGuid(record.Ref_Key);
  if (!result) throw new Error('ONEC_INVALID_REF_KEY: Ref_Key must be a non-zero GUID.');
  return result;
}

function finiteNumber(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '') return 0;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`ONEC_INVALID_NUMBER: ${field}.`);
  return result;
}

function optionalFiniteNumber(value: unknown, field: string): number | null {
  return value === undefined || value === null || value === '' ? null : finiteNumber(value, field);
}

function lineNumber(value: unknown): number {
  const result = finiteNumber(value, 'LineNumber');
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('ONEC_INVALID_LINE_NUMBER: LineNumber must be a safe non-negative integer.');
  }
  return result;
}

function records(value: unknown): ODataRecord[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('ONEC_INVALID_TABULAR_PART: expected an array.');
  return value as ODataRecord[];
}

export function mapNomenclatureRecord(
  record: ODataRecord,
  dictionaries: OneCNomenclatureDictionaries,
  capturedAt: string,
): OneCNomenclatureSnapshot {
  const externalId = requiredGuid(record);
  const fullName = text(record['НаименованиеПолное']);
  const displayName = fullName ?? text(record.Description);
  if (!displayName) throw new Error('ONEC_INVALID_NOMENCLATURE_NAME: name is empty.');
  const kindExternalId = optionalGuid(record['ВидНоменклатуры_Key']);
  const unitExternalId = optionalGuid(record['ЕдиницаИзмерения_Key']);

  return {
    sourceKind: '1C',
    subjectType: 'nomenclature',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      code: text(record.Code) ?? '',
      article: text(record['Артикул']),
      name: displayName,
      fullName,
      kindExternalId,
      kindName: kindExternalId ? (dictionaries.kinds.get(kindExternalId) ?? null) : null,
      unitExternalId,
      unitName: unitExternalId ? (dictionaries.units.get(unitExternalId) ?? null) : null,
      deleted: record.DeletionMark === true,
      archived: record['ВАрхиве'] === true,
    },
    rawPayload: record,
  };
}

export function mapOrganizationRecord(
  record: ODataRecord,
  capturedAt: string,
): OneCOrganizationSnapshot {
  const externalId = requiredGuid(record);
  const name = text(record.Description) ?? text(record['НаименованиеПолное']);
  if (!name) throw new Error('ONEC_INVALID_ORGANIZATION_NAME: name is empty.');

  return {
    sourceKind: '1C',
    subjectType: 'organization',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      code: text(record.Code) ?? '',
      name,
      fullName: text(record['НаименованиеПолное']),
      inn: text(record['ИНН']),
      kpp: text(record['КПП']),
      deleted: record.DeletionMark === true,
    },
    rawPayload: record,
  };
}

export function mapWarehouseRecord(record: ODataRecord, capturedAt: string): OneCWarehouseSnapshot {
  const externalId = requiredGuid(record);
  const name = text(record.Description);
  if (!name) throw new Error('ONEC_INVALID_WAREHOUSE_NAME: name is empty.');

  return {
    sourceKind: '1C',
    subjectType: 'warehouse',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      code: text(record.Code) ?? '',
      name,
      warehouseType: text(record['ТипСклада']),
      deleted: record.DeletionMark === true,
    },
    rawPayload: record,
  };
}

function parseInvoiceLine(record: ODataRecord): OneCInvoiceLineParsed {
  const taxRate = text(record['СтавкаНДС']);
  const taxAmount = optionalFiniteNumber(record['СуммаНДС'], 'СуммаНДС');
  return {
    lineNumber: lineNumber(record.LineNumber),
    nomenclatureExternalId:
      optionalGuid(record['Номенклатура_Key']) ?? optionalGuid(record['Номенклатура']),
    name: text(record['Содержание']),
    quantity: finiteNumber(record['Количество'], 'Количество'),
    price: finiteNumber(record['Цена'], 'Цена'),
    amount: finiteNumber(record['Сумма'], 'Сумма'),
    unitExternalId: optionalGuid(record['ЕдиницаИзмерения_Key']),
    ...(taxRate === null ? {} : { taxRate }),
    ...(taxAmount === null ? {} : { taxAmount }),
  };
}

export function mapInvoiceLineRecord(record: ODataRecord): OneCInvoiceLineSource {
  return {
    invoiceExternalId: requiredGuid(record),
    parsed: parseInvoiceLine(record),
    rawPayload: record,
  };
}

export function mapInvoiceRecordWithLines(
  record: ODataRecord,
  capturedAt: string,
  orderReferenceField?: string | null,
): OneCInvoiceSnapshot {
  const externalId = requiredGuid(record);
  const currencyExternalId = optionalGuid(record['ВалютаДокумента_Key']);
  const subtotal = optionalFiniteNumber(record['СуммаБезНДС'], 'СуммаБезНДС');
  const taxTotal = optionalFiniteNumber(record['СуммаНДС'], 'СуммаНДС');

  return {
    sourceKind: '1C',
    subjectType: 'invoice',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      invoiceNo: text(record.Number) ?? '',
      date: text(record.Date),
      total: finiteNumber(record['СуммаДокумента'], 'СуммаДокумента'),
      currency: currencyExternalId ?? 'RUB',
      counterpartyExternalId: optionalGuid(record['Контрагент_Key']),
      ...(orderReferenceField ? { orderReference: text(record[orderReferenceField]) } : {}),
      ...(subtotal === null ? {} : { subtotal }),
      ...(taxTotal === null ? {} : { taxTotal }),
      organizationExternalId: optionalGuid(record['Организация_Key']),
      currencyExternalId,
      posted: record.Posted === true,
      deleted: record.DeletionMark === true,
      lines: records(record['Товары']).map(parseInvoiceLine),
    },
    rawPayload: record,
  };
}

export function mapPaymentRecordWithBasis(
  record: ODataRecord,
  capturedAt: string,
): OneCPaymentSnapshot {
  const externalId = requiredGuid(record);
  const documentBasisExternalId = optionalGuid(record['ДокументОснование']);
  const documentBasisType = text(record['ДокументОснование_Type']);

  return {
    sourceKind: '1C',
    subjectType: 'payment',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      number: text(record.Number) ?? '',
      date: text(record.Date),
      amount: finiteNumber(record['СуммаДокумента'], 'СуммаДокумента'),
      counterpartyExternalId:
        optionalGuid(record['Контрагент_Key']) ?? optionalGuid(record['Контрагент']),
      organizationExternalId: optionalGuid(record['Организация_Key']),
      documentBasisExternalId,
      documentBasisType,
      invoiceExternalId:
        documentBasisType === CUSTOMER_INVOICE_TYPE ? documentBasisExternalId : null,
      posted: record.Posted === true,
      deleted: record.DeletionMark === true,
    },
    rawPayload: record,
  };
}

function parseShipmentLine(record: ODataRecord): OneCShipmentLineParsed {
  return {
    lineNumber: lineNumber(record.LineNumber),
    nomenclatureExternalId: optionalGuid(record['Номенклатура_Key']),
    name: text(record['Содержание']),
    quantity: finiteNumber(record['Количество'], 'Количество'),
    price: finiteNumber(record['Цена'], 'Цена'),
    amount: finiteNumber(record['Сумма'], 'Сумма'),
    unitExternalId: optionalGuid(record['ЕдиницаИзмерения_Key']),
  };
}

export function mapShipmentLineRecord(record: ODataRecord): OneCShipmentLineSource {
  return {
    shipmentExternalId: requiredGuid(record),
    parsed: parseShipmentLine(record),
    rawPayload: record,
  };
}

export function mapShipmentRecordWithLines(
  record: ODataRecord,
  capturedAt: string,
): OneCShipmentSnapshot {
  const externalId = requiredGuid(record);

  return {
    sourceKind: '1C',
    subjectType: 'shipment',
    externalId,
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      number: text(record.Number) ?? '',
      date: text(record.Date),
      total: finiteNumber(record['СуммаДокумента'], 'СуммаДокумента'),
      counterpartyExternalId: optionalGuid(record['Контрагент_Key']),
      organizationExternalId: optionalGuid(record['Организация_Key']),
      invoiceExternalId: optionalGuid(record['СчетНаОплатуПокупателю_Key']),
      posted: record.Posted === true,
      deleted: record.DeletionMark === true,
      lines: records(record['Товары']).map(parseShipmentLine),
    },
    rawPayload: record,
  };
}

export function mapBalanceRecordWithRefs(
  record: ODataRecord,
  accountCode: '10.01' | '41.01',
  capturedAt: string,
): OneCStockSnapshot {
  const nomenclatureExternalId = [1, 2, 3]
    .map((index) => ({
      externalId: optionalGuid(record[`ExtDimension${index}`]),
      type: text(record[`ExtDimension${index}_Type`]),
    }))
    .find((item) => item.type === 'StandardODATA.Catalog_Номенклатура')?.externalId;

  return {
    sourceKind: '1C',
    subjectType: 'stock',
    externalId: null,
    sourceVersion: null,
    staleness: 'fresh',
    capturedAt,
    parsed: {
      account: optionalGuid(record.Account_Key),
      accountCode,
      organizationExternalId: optionalGuid(record['Организация_Key']),
      nomenclatureExternalId: nomenclatureExternalId ?? null,
      qty: finiteNumber(record['КоличествоBalance'], 'КоличествоBalance'),
      amount: finiteNumber(record['СуммаBalance'], 'СуммаBalance'),
      subconto: [1, 2, 3]
        .map((index) => optionalGuid(record[`ExtDimension${index}`]))
        .filter((value): value is string => value !== null),
    },
    rawPayload: record,
  };
}
