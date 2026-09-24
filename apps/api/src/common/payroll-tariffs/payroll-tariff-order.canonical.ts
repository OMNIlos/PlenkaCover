import { createHash } from 'node:crypto';
import type { PayrollTariffMatrixV1 } from '@plenka/contracts';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON supports only JSON values');
}

export function canonicalPayrollTariffJson(value: unknown): string {
  return canonicalJson(value);
}

export function hashPayrollTariffMatrix(matrix: PayrollTariffMatrixV1): string {
  return createHash('sha256').update(canonicalPayrollTariffJson(matrix)).digest('hex');
}
