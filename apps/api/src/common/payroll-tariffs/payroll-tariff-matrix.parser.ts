import type {
  PayrollTariffAbcBandV1,
  PayrollTariffMatrixV1,
  PayrollTariffOrderFieldError,
  PayrollTariffUrpBandV1,
} from '@plenka/contracts';

type JsonObject = Record<string, unknown>;

const ROOT_KEYS = ['schemaVersion', 'ladders', 'specialRules'] as const;
const LADDER_KEYS = ['urp12h', 'urp24h', 'abc12h', 'abc24h'] as const;
const SPECIAL_RULE_KEYS = ['thinRoll', 'alabuga'] as const;
const URP_BAND_KEYS = [
  'maxInclusiveGrams',
  'primaryRateKopecksPerKg',
  'secondaryRateKopecksPerKg',
] as const;
const ABC_BAND_KEYS = [
  'maxInclusiveGrams',
  'standardRateKopecksPerKg',
  'blackWhiteRateKopecksPerKg',
] as const;
const THIN_ROLL_KEYS = ['enabled', 'maxExclusiveGrams', 'rateKopecksPerKg'] as const;
const ALABUGA_KEYS = [
  'enabled',
  'machineFamily',
  'normalizedLegalName',
  'rateKopecksPerKg',
] as const;

export class PayrollTariffMatrixValidationError extends Error {
  constructor(readonly fieldErrors: PayrollTariffOrderFieldError[]) {
    super('Тарифная матрица не прошла проверку');
    this.name = 'PayrollTariffMatrixValidationError';
  }
}

function issue(
  errors: PayrollTariffOrderFieldError[],
  path: string,
  code: string,
  message: string,
): void {
  errors.push({ path, code, message });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectAt(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): JsonObject {
  if (isObject(value)) return value;
  issue(errors, path, 'invalid_object', 'Ожидался объект');
  return {};
}

function arrayAt(value: unknown, path: string, errors: PayrollTariffOrderFieldError[]): unknown[] {
  if (Array.isArray(value)) return value;
  issue(errors, path, 'invalid_array', 'Ожидался массив диапазонов');
  return [];
}

function rejectUnknownKeys(
  value: JsonObject,
  allowedKeys: readonly string[],
  path: string,
  errors: PayrollTariffOrderFieldError[],
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issue(errors, path.length === 0 ? key : `${path}.${key}`, 'unknown_key', 'Неизвестное поле');
    }
  }
}

function booleanAt(value: unknown, path: string, errors: PayrollTariffOrderFieldError[]): boolean {
  if (typeof value === 'boolean') return value;
  issue(errors, path, 'invalid_boolean', 'Ожидалось логическое значение');
  return false;
}

function kopecksAt(value: unknown, path: string, errors: PayrollTariffOrderFieldError[]): number {
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  issue(errors, path, 'invalid_kopecks', 'Ставка должна быть целым числом копеек не меньше нуля');
  return 0;
}

function positiveGramsAt(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): number {
  if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
  issue(errors, path, 'invalid_threshold', 'Порог должен быть положительным целым числом граммов');
  return 1;
}

function thresholdAt(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): number | null {
  return value === null ? null : positiveGramsAt(value, path, errors);
}

function nonBlankStringAt(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  issue(errors, path, 'invalid_string', 'Ожидалась непустая строка');
  return '';
}

function validateBandOrder(
  sourceRows: readonly unknown[],
  path: string,
  errors: PayrollTariffOrderFieldError[],
): void {
  const thresholds = sourceRows.map((row) => (isObject(row) ? row.maxInclusiveGrams : undefined));
  const openIndexes = thresholds.flatMap((threshold, index) => (threshold === null ? [index] : []));

  if (openIndexes.length !== 1) {
    issue(errors, path, 'open_band_required', 'Нужен ровно один открытый последний диапазон');
  }
  for (const index of openIndexes) {
    if (index !== sourceRows.length - 1) {
      issue(
        errors,
        `${path}[${index}].maxInclusiveGrams`,
        'open_band_not_last',
        'Открытый диапазон должен быть последним',
      );
    }
  }

  let previous: number | null = null;
  thresholds.forEach((threshold, index) => {
    if (!Number.isSafeInteger(threshold) || (threshold as number) <= 0) return;
    if (previous !== null && (threshold as number) <= previous) {
      issue(
        errors,
        `${path}[${index}].maxInclusiveGrams`,
        'threshold_not_increasing',
        'Закрытые пороги должны строго возрастать',
      );
    }
    previous = threshold as number;
  });
}

function parseUrpBands(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): PayrollTariffUrpBandV1[] {
  const rows = arrayAt(value, path, errors);
  if (rows.length === 0) {
    issue(errors, path, 'empty_ladder', 'Лестница должна содержать диапазоны');
  }

  const result = rows.map((value, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectAt(value, rowPath, errors);
    rejectUnknownKeys(row, URP_BAND_KEYS, rowPath, errors);
    return {
      maxInclusiveGrams: thresholdAt(row.maxInclusiveGrams, `${rowPath}.maxInclusiveGrams`, errors),
      primaryRateKopecksPerKg: kopecksAt(
        row.primaryRateKopecksPerKg,
        `${rowPath}.primaryRateKopecksPerKg`,
        errors,
      ),
      secondaryRateKopecksPerKg: kopecksAt(
        row.secondaryRateKopecksPerKg,
        `${rowPath}.secondaryRateKopecksPerKg`,
        errors,
      ),
    };
  });
  validateBandOrder(rows, path, errors);
  return result;
}

function parseAbcBands(
  value: unknown,
  path: string,
  errors: PayrollTariffOrderFieldError[],
): PayrollTariffAbcBandV1[] {
  const rows = arrayAt(value, path, errors);
  if (rows.length === 0) {
    issue(errors, path, 'empty_ladder', 'Лестница должна содержать диапазоны');
  }

  const result = rows.map((value, index) => {
    const rowPath = `${path}[${index}]`;
    const row = objectAt(value, rowPath, errors);
    rejectUnknownKeys(row, ABC_BAND_KEYS, rowPath, errors);
    return {
      maxInclusiveGrams: thresholdAt(row.maxInclusiveGrams, `${rowPath}.maxInclusiveGrams`, errors),
      standardRateKopecksPerKg: kopecksAt(
        row.standardRateKopecksPerKg,
        `${rowPath}.standardRateKopecksPerKg`,
        errors,
      ),
      blackWhiteRateKopecksPerKg: kopecksAt(
        row.blackWhiteRateKopecksPerKg,
        `${rowPath}.blackWhiteRateKopecksPerKg`,
        errors,
      ),
    };
  });
  validateBandOrder(rows, path, errors);
  return result;
}

function deepFreeze<T>(value: T): T {
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function parsePayrollTariffMatrix(value: unknown): PayrollTariffMatrixV1 {
  const errors: PayrollTariffOrderFieldError[] = [];
  const root = objectAt(value, '', errors);
  rejectUnknownKeys(root, ROOT_KEYS, '', errors);
  if (root.schemaVersion !== 1) {
    issue(errors, 'schemaVersion', 'invalid_literal', 'Поддерживается только schemaVersion = 1');
  }

  const ladders = objectAt(root.ladders, 'ladders', errors);
  rejectUnknownKeys(ladders, LADDER_KEYS, 'ladders', errors);
  const specialRules = objectAt(root.specialRules, 'specialRules', errors);
  rejectUnknownKeys(specialRules, SPECIAL_RULE_KEYS, 'specialRules', errors);

  const thinRoll = objectAt(specialRules.thinRoll, 'specialRules.thinRoll', errors);
  rejectUnknownKeys(thinRoll, THIN_ROLL_KEYS, 'specialRules.thinRoll', errors);
  const alabuga = objectAt(specialRules.alabuga, 'specialRules.alabuga', errors);
  rejectUnknownKeys(alabuga, ALABUGA_KEYS, 'specialRules.alabuga', errors);

  const matrix: PayrollTariffMatrixV1 = {
    schemaVersion: 1,
    ladders: {
      urp12h: parseUrpBands(ladders.urp12h, 'ladders.urp12h', errors),
      urp24h: parseUrpBands(ladders.urp24h, 'ladders.urp24h', errors),
      abc12h: parseAbcBands(ladders.abc12h, 'ladders.abc12h', errors),
      abc24h: parseAbcBands(ladders.abc24h, 'ladders.abc24h', errors),
    },
    specialRules: {
      thinRoll: {
        enabled: booleanAt(thinRoll.enabled, 'specialRules.thinRoll.enabled', errors),
        maxExclusiveGrams: positiveGramsAt(
          thinRoll.maxExclusiveGrams,
          'specialRules.thinRoll.maxExclusiveGrams',
          errors,
        ),
        rateKopecksPerKg: kopecksAt(
          thinRoll.rateKopecksPerKg,
          'specialRules.thinRoll.rateKopecksPerKg',
          errors,
        ),
      },
      alabuga: {
        enabled: booleanAt(alabuga.enabled, 'specialRules.alabuga.enabled', errors),
        machineFamily: 'abc_new',
        normalizedLegalName: nonBlankStringAt(
          alabuga.normalizedLegalName,
          'specialRules.alabuga.normalizedLegalName',
          errors,
        ),
        rateKopecksPerKg: kopecksAt(
          alabuga.rateKopecksPerKg,
          'specialRules.alabuga.rateKopecksPerKg',
          errors,
        ),
      },
    },
  };

  if (alabuga.machineFamily !== 'abc_new') {
    issue(
      errors,
      'specialRules.alabuga.machineFamily',
      'invalid_literal',
      'Правило Алабуги применимо только к abc_new',
    );
  }
  if (errors.length > 0) throw new PayrollTariffMatrixValidationError(errors);
  return deepFreeze(matrix);
}
