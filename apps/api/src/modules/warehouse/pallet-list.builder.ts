import type {
  PalletLabelSnapshotProfile,
  PalletListPayload as SharedPalletListPayload,
  WarehouseIntakeRollView,
  WarehouseIntakeTaskView,
} from '@plenka/contracts';

export type PalletListPayload = SharedPalletListPayload;

export type PalletListScope = {
  palletId: string;
  rollCodes: string[];
  printReady: boolean;
};

export const PALLET_STORAGE_CONDITIONS =
  'Хранение в закрытых, проветриваемых помещениях при температуре 5–35 °C и ' +
  'относительной влажности 40–60 %, не ближе 1,0 м от отопительных приборов. ' +
  'После транспортирования или хранения при минусовых температурах пленка должна быть ' +
  'выдержана перед дальнейшим использованием не менее 12 часов в сухом помещении при +18 °C.';

const unique = <T>(values: T[]): T[] => [...new Set(values)];

const strings = (values: Array<string | null | undefined>): string[] =>
  unique(values.filter((value): value is string => typeof value === 'string' && value.length > 0));

const oneOrNull = (values: string[]): string | null => (values.length === 1 ? values[0] : null);

const round3 = (value: number): number => Number(value.toFixed(3));

const formatDecimal = (value: number): string =>
  Number(value.toFixed(3)).toString().replace('.', ',');

function measurement(
  value: string | null | undefined,
  target: 'micron' | 'millimeter' | 'meter',
): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(',', '.').replace(/[×х]/gu, 'x');
  const source =
    target === 'millimeter' && normalized.includes('x')
      ? (normalized.split('x').at(-1)?.trim() ?? normalized)
      : normalized;
  const match = source.match(/^(\d+(?:\.\d+)?)\s*(мкм|мк|мм|см|м)?$/u);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const unit = match[2] ?? null;
  if (target === 'micron') {
    if (unit && unit !== 'мкм' && unit !== 'мк') return null;
    return `${formatDecimal(parsed)}мкм`;
  }
  if (target === 'millimeter') {
    const millimeters = unit === 'м' ? parsed * 1000 : unit === 'см' ? parsed * 10 : parsed;
    if (unit === 'мкм' || unit === 'мк') return null;
    return `${formatDecimal(millimeters)}мм`;
  }
  const meters = unit === 'мм' ? parsed / 1000 : unit === 'см' ? parsed / 100 : parsed;
  if (unit === 'мкм' || unit === 'мк') return null;
  return `${formatDecimal(meters)}м`;
}

function filmForm(value: string | null | undefined): string | null {
  if (!value) return null;
  const materialWords =
    /(?<![\p{L}\p{N}])(?:пл[её]нка|полиэтиленов(?:ая|ый|ое)|пвд|пнд|псд|pe(?:-?ld)?|ldpe|hdpe)(?![\p{L}\p{N}])/giu;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(materialWords, ' ')
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .replace(/(?:^|\s)-+|-+(?=\s|$)/gu, ' ')
    .trim();
  if (!normalized) return null;
  const knownForms = ['полурукав', 'рукав', 'полотно', 'фальц', 'пакет'];
  const known = knownForms.find((candidate) => normalized.split(/\s+/u).includes(candidate));
  if (known) return known;
  return [...new Set(normalized.split(/\s+/u))].join(' ');
}

const productName = (roll: WarehouseIntakeRollView): string =>
  [
    'Пленка полиэтиленовая',
    filmForm(roll.characteristics?.filmType),
    measurement(roll.characteristics?.actualThickness, 'micron'),
    measurement(roll.characteristics?.sizeMeters, 'millimeter'),
    measurement(roll.characteristics?.lengthMeters, 'meter'),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ');

function productionMonth(value: string): { key: number; label: string } | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const month = date.getUTCMonth() + 1;
  const year = date.getUTCFullYear();
  return { key: year * 100 + month, label: `${String(month).padStart(2, '0')}.${year}` };
}

function productionDate(rolls: WarehouseIntakeRollView[]): string | null {
  const months = new Map<number, string>();
  for (const roll of rolls) {
    if (!roll.producedAt) continue;
    const month = productionMonth(roll.producedAt);
    if (month) months.set(month.key, month.label);
  }
  const labels = [...months.entries()].sort(([a], [b]) => a - b).map(([, label]) => label);
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels[0]}–${labels[labels.length - 1]}`;
}

function commonString(values: Array<string | null | undefined>): string | null {
  return oneOrNull(strings(values));
}

function commonNumber(values: Array<number | null | undefined>): number | null {
  if (values.length === 0 || values.some((value) => value === null || value === undefined)) {
    return null;
  }
  const normalized = unique(values as number[]);
  return normalized.length === 1 ? normalized[0] : null;
}

export function buildPalletListPayload(
  task: WarehouseIntakeTaskView,
  actorName: string | null,
  createdAt: string,
  scope?: PalletListScope,
  profile: PalletLabelSnapshotProfile = 'pallet-100x150-v1',
): PalletListPayload {
  const rolls = scopedRolls(task.rolls, scope);
  const rows = rolls.map((roll, index) => ({
    seq: index + 1,
    rollCode: roll.rollCode,
    orderId: roll.orderId,
    orderNumber: roll.orderNumber,
    customerAlias: roll.customerAlias,
    productName: productName(roll),
    netKg: roll.netKg,
    grossKg: roll.grossKg,
    planKg: roll.planKg,
    status: roll.scanStatus,
  }));
  const orderIds = strings(rolls.map((roll) => roll.orderId));
  if (scope && orderIds.length > 1) {
    throw new Error('Physical pallet cannot contain multiple orders');
  }
  const orderNumbers = strings(rolls.map((roll) => roll.orderNumber));
  const customerAliases = strings(rolls.map((roll) => roll.customerAlias));
  const products = strings(rows.map((row) => row.productName));
  const collectors = strings(rolls.map((roll) => roll.scannedByName));
  const marks = strings(rolls.map((roll) => roll.characteristics?.materialMark));
  const allGrossKnown = rows.length > 0 && rows.every((row) => row.grossKg !== null);
  const grossKg = allGrossKnown
    ? round3(rows.reduce((sum, row) => sum + (row.grossKg ?? 0), 0))
    : null;
  const netKg = round3(rows.reduce((sum, row) => sum + (row.netKg ?? 0), 0));
  const labelBase = {
    palletId: scope?.palletId ?? task.operationCode ?? task.taskId,
    materialMark: marks.length > 0 ? marks.join(' / ') : 'PE-LD',
    productNames: products,
    article: commonString(rolls.map((roll) => roll.characteristics?.article)),
    rollCount: rows.length,
    packagingMaterial: commonString(rolls.map((roll) => roll.characteristics?.packagingMaterial)),
    packagingCount: commonNumber(rolls.map((roll) => roll.characteristics?.packagingCount)),
    netKg,
    grossKg,
    productionDate: productionDate(rolls),
    shelfLifeMonths: 12 as const,
    deliveryDate: commonString(rolls.map((roll) => roll.characteristics?.deliveryDate)),
    storageConditions: PALLET_STORAGE_CONDITIONS,
    orderNumbers,
    customerAliases,
    createdAt,
  };
  const label =
    profile === 'pallet-100x100-square-v4' ||
    profile === 'pallet-100x100-safe-v5' ||
    profile === 'pallet-100x100-extended-v6' ||
    profile === 'pallet-100x100-configurable-v7'
      ? {
          templateVersion: profile,
          ...labelBase,
          rollCodes: rows.map((row) => row.rollCode),
        }
      : { templateVersion: profile, ...labelBase };

  return {
    templateVersion: profile,
    palletId: scope?.palletId ?? task.operationCode ?? task.taskId,
    operationCode: task.operationCode,
    orderIds,
    orderNumbers,
    customerAliases,
    products,
    orderNumber: oneOrNull(orderNumbers),
    customerAlias: oneOrNull(customerAliases),
    scannedCount: scope ? rows.length : task.accepted,
    expectedCount: scope ? rows.length : task.accepted + task.expected,
    printReady: scope?.printReady ?? (task.status === 'accepted' || task.closable),
    rows,
    totals: {
      rollCount: rows.length,
      plannedKg: round3(rows.reduce((sum, row) => sum + (row.planKg ?? 0), 0)),
      netKg,
      grossKg,
    },
    receivedBy: actorName,
    collectedBy: collectors.length > 0 ? collectors.join(', ') : null,
    date: createdAt,
    label,
  };
}

function scopedRolls(
  taskRolls: WarehouseIntakeRollView[],
  scope: PalletListScope | undefined,
): WarehouseIntakeRollView[] {
  if (!scope) return taskRolls;
  if (new Set(scope.rollCodes).size !== scope.rollCodes.length) {
    throw new Error('Pallet scope contains a duplicate roll');
  }

  const byCode = new Map(taskRolls.map((roll) => [roll.rollCode, roll]));
  return scope.rollCodes.map((rollCode) => {
    const roll = byCode.get(rollCode);
    if (!roll) throw new Error('Pallet scope contains an unknown roll');
    return roll;
  });
}
