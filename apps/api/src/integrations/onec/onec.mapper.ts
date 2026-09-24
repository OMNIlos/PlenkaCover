import type {
  OneCCounterpartySnapshot,
  OneCInvoiceSnapshot,
  OneCPaymentSnapshot,
  OneCShipmentSnapshot,
  OneCStockSnapshot,
} from '@plenka/contracts';

/** A raw OData record is an untyped bag of 1С fields (Cyrillic keys). */
type ODataRecord = Record<string, unknown>;

const str = (v: unknown): string | null => (v === undefined || v === null ? null : String(v));
const num = (v: unknown): number => (v === undefined || v === null ? 0 : Number(v));

/** Map an OData `value` array with a per-record mapper. */
export function mapList<TSnap>(
  value: ODataRecord[] | undefined,
  mapper: (rec: ODataRecord, capturedAt: string) => TSnap,
  capturedAt: string,
): TSnap[] {
  return (value ?? []).map((rec) => mapper(rec, capturedAt));
}

export function mapCounterpartyRecord(
  rec: ODataRecord,
  capturedAt: string,
): OneCCounterpartySnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'counterparty',
    externalId: str(rec['Ref_Key']),
    sourceVersion: str(rec['DataVersion']),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      displayName: str(rec['Description']) ?? '',
      legalName: str(rec['НаименованиеПолное']),
      inn: str(rec['ИНН']),
      kpp: str(rec['КПП']),
      code: str(rec['Code']),
      deleted: rec['DeletionMark'] === true,
    },
    rawPayload: rec,
  };
}

export function mapInvoiceRecord(rec: ODataRecord, capturedAt: string): OneCInvoiceSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'invoice',
    externalId: str(rec['Ref_Key']),
    sourceVersion: str(rec['DataVersion']),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      invoiceNo: str(rec['Number']) ?? '',
      date: str(rec['Date']),
      total: num(rec['СуммаДокумента']),
      currency: str(rec['ВалютаДокумента_Key']) ?? 'RUB',
      counterpartyExternalId: str(rec['Контрагент_Key']),
      posted: rec['Posted'] === true,
    },
    rawPayload: rec,
  };
}

export function mapPaymentRecord(rec: ODataRecord, capturedAt: string): OneCPaymentSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'payment',
    externalId: str(rec['Ref_Key']),
    sourceVersion: str(rec['DataVersion']),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      number: str(rec['Number']) ?? '',
      date: str(rec['Date']),
      amount: num(rec['СуммаДокумента']),
      // ПоступлениеНаРасчетныйСчет: counterparty is a COMPOSITE ref → field `Контрагент` (value),
      // not `Контрагент_Key` (which 400s on this doc). Invoice/shipment use `Контрагент_Key`.
      counterpartyExternalId: str(rec['Контрагент']),
      posted: rec['Posted'] === true,
    },
    rawPayload: rec,
  };
}

export function mapShipmentRecord(rec: ODataRecord, capturedAt: string): OneCShipmentSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'shipment',
    externalId: str(rec['Ref_Key']),
    sourceVersion: str(rec['DataVersion']),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      number: str(rec['Number']) ?? '',
      date: str(rec['Date']),
      total: num(rec['СуммаДокумента']),
      counterpartyExternalId: str(rec['Контрагент_Key']),
      posted: rec['Posted'] === true,
    },
    rawPayload: rec,
  };
}

export function mapBalanceRecord(rec: ODataRecord, capturedAt: string): OneCStockSnapshot {
  const subconto = ['ExtDimension1', 'ExtDimension2', 'ExtDimension3']
    .map((k) => str(rec[k]))
    .filter((v): v is string => v !== null);
  return {
    sourceKind: '1C',
    subjectType: 'stock',
    // Balance virtual-table rows have no Ref_Key/DataVersion — externalId/sourceVersion stay null.
    externalId: null,
    sourceVersion: null,
    staleness: 'fresh',
    capturedAt,
    parsed: {
      account: str(rec['Account_Key']),
      qty: num(rec['КоличествоBalance']),
      amount: num(rec['СуммаBalance']),
      subconto,
    },
    rawPayload: rec,
  };
}
