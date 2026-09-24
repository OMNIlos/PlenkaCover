import type {
  OneCProductionMaterialLineSource,
  OneCProductionOutputLineSource,
  OneCProductionReportSnapshot,
} from '@plenka/contracts';
import type { OneCNomenclatureDictionaries } from './onec-sync.mapper';

type ODataRecord = Record<string, unknown>;

const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

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
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new Error(`ONEC_INVALID_NUMBER: ${field}.`);
  }

  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`ONEC_INVALID_NUMBER: ${field}.`);
  return result;
}

function lineNumber(value: unknown): number {
  const result = finiteNumber(value, 'LineNumber');
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error('ONEC_INVALID_LINE_NUMBER: LineNumber must be a safe non-negative integer.');
  }
  return result;
}

function oneCMoscowDateTime(value: unknown): string | null {
  const result = text(value);
  if (!result) return null;

  const match = ISO_DATE_TIME_PATTERN.exec(result);
  if (!match) throw new Error('ONEC_INVALID_DATE: expected an ISO date-time.');

  const [, year, month, day, hour, minute, second, , offset] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  const [yearValue, monthValue, dayValue, hourValue, minuteValue, secondValue] = numeric;
  const calendarDate = new Date(Date.UTC(yearValue, monthValue - 1, dayValue));
  const validCalendarDate =
    calendarDate.getUTCFullYear() === yearValue &&
    calendarDate.getUTCMonth() === monthValue - 1 &&
    calendarDate.getUTCDate() === dayValue;
  const validTime = hourValue <= 23 && minuteValue <= 59 && secondValue <= 59;
  const validOffset =
    !offset ||
    offset === 'Z' ||
    (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);

  if (!validCalendarDate || !validTime || !validOffset) {
    throw new Error('ONEC_INVALID_DATE: expected an ISO date-time.');
  }

  const date = new Date(offset ? result : `${result}+03:00`);
  if (Number.isNaN(date.getTime()))
    throw new Error('ONEC_INVALID_DATE: expected an ISO date-time.');
  return date.toISOString();
}

export function mapProductionReportRecord(
  record: ODataRecord,
  capturedAt: string,
): OneCProductionReportSnapshot {
  return {
    sourceKind: '1C',
    subjectType: 'production_report',
    externalId: requiredGuid(record),
    sourceVersion: text(record.DataVersion),
    staleness: 'fresh',
    capturedAt,
    parsed: {
      number: text(record.Number) ?? '',
      date: oneCMoscowDateTime(record.Date),
      posted: record.Posted === true,
      deleted: record.DeletionMark === true,
      organizationExternalId: optionalGuid(record['Организация_Key']),
      warehouseExternalId: optionalGuid(record['Склад_Key']),
      departmentExternalId: optionalGuid(record['ПодразделениеОрганизации_Key']),
    },
    rawPayload: record,
  };
}

export function mapProductionOutputLineRecord(
  record: ODataRecord,
  dictionaries: OneCNomenclatureDictionaries,
): OneCProductionOutputLineSource {
  const unitExternalId = optionalGuid(record['ЕдиницаИзмерения_Key']);

  return {
    reportExternalId: requiredGuid(record),
    parsed: {
      lineNumber: lineNumber(record.LineNumber),
      nomenclatureExternalId: optionalGuid(record['Номенклатура_Key']),
      unitExternalId,
      unitName: unitExternalId ? (dictionaries.units.get(unitExternalId) ?? null) : null,
      quantity: finiteNumber(record['Количество'], 'Количество'),
    },
    rawPayload: record,
  };
}

export function mapProductionMaterialLineRecord(
  record: ODataRecord,
  dictionaries: OneCNomenclatureDictionaries,
): OneCProductionMaterialLineSource {
  const unitExternalId = optionalGuid(record['ЕдиницаИзмерения_Key']);

  return {
    reportExternalId: requiredGuid(record),
    parsed: {
      lineNumber: lineNumber(record.LineNumber),
      nomenclatureExternalId: optionalGuid(record['Номенклатура_Key']),
      productExternalId: optionalGuid(record['Продукция_Key']),
      unitExternalId,
      unitName: unitExternalId ? (dictionaries.units.get(unitExternalId) ?? null) : null,
      quantity: finiteNumber(record['Количество'], 'Количество'),
    },
    rawPayload: record,
  };
}
