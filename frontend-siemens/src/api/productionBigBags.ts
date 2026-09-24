import { apiGet } from './client';

export type ProductionBigBagClassification =
  | 'in_use'
  | 'idle_required'
  | 'idle_not_required'
  | 'idle_unclassified';

export type ProductionBigBagSummaryItem = {
  id: string;
  code: string;
  material: string;
  materialDefinitionId: string | null;
  status: 'available' | 'in_use' | 'consumed';
  currentKg: number | null;
  classification: ProductionBigBagClassification;
};

export type ProductionBigBagSummary = {
  counts: {
    total: number;
    inUse: number;
    idle: number;
    notRequired: number;
  };
  bags: ProductionBigBagSummaryItem[];
  returnCandidates: ProductionBigBagSummaryItem[];
  generatedAt: string;
};

type JsonRecord = Record<string, unknown>;

function fail(): never {
  throw new Error('Некорректная сводка Big-Bag производства.');
}

function exactRecord(value: unknown, fields: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail();
  }
  const record = value as JsonRecord;
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    !keys.every((key) => fields.includes(key))
  ) {
    return fail();
  }
  return record;
}

function identity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    return fail();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return fail();
  }
  return value;
}

function parseItem(value: unknown): ProductionBigBagSummaryItem {
  const record = exactRecord(value, [
    'id',
    'code',
    'material',
    'materialDefinitionId',
    'status',
    'currentKg',
    'classification',
  ]);
  if (
    record.materialDefinitionId !== null &&
    typeof record.materialDefinitionId !== 'string'
  ) {
    return fail();
  }
  if (
    record.currentKg !== null &&
    (typeof record.currentKg !== 'number' ||
      !Number.isFinite(record.currentKg) ||
      record.currentKg < 0)
  ) {
    return fail();
  }
  const statuses: ProductionBigBagSummaryItem['status'][] = [
    'available',
    'in_use',
    'consumed',
  ];
  const classifications: ProductionBigBagClassification[] = [
    'in_use',
    'idle_required',
    'idle_not_required',
    'idle_unclassified',
  ];
  if (
    typeof record.status !== 'string' ||
    !statuses.includes(record.status as ProductionBigBagSummaryItem['status']) ||
    typeof record.classification !== 'string' ||
    !classifications.includes(
      record.classification as ProductionBigBagClassification,
    )
  ) {
    return fail();
  }
  if (
    (record.classification === 'in_use') !== (record.status === 'in_use') ||
    (record.materialDefinitionId === null &&
      record.classification !== 'idle_unclassified' &&
      record.classification !== 'in_use')
  ) {
    return fail();
  }
  return {
    id: identity(record.id),
    code: identity(record.code),
    material: identity(record.material),
    materialDefinitionId:
      record.materialDefinitionId === null
        ? null
        : identity(record.materialDefinitionId),
    status: record.status as ProductionBigBagSummaryItem['status'],
    currentKg: record.currentKg as number | null,
    classification: record.classification as ProductionBigBagClassification,
  };
}

export function parseProductionBigBagSummary(
  value: unknown,
): ProductionBigBagSummary {
  const record = exactRecord(value, [
    'counts',
    'bags',
    'returnCandidates',
    'generatedAt',
  ]);
  const countsRecord = exactRecord(record.counts, [
    'total',
    'inUse',
    'idle',
    'notRequired',
  ]);
  if (!Array.isArray(record.bags) || !Array.isArray(record.returnCandidates)) {
    return fail();
  }
  const bags = record.bags.map(parseItem);
  const returnCandidates = record.returnCandidates.map(parseItem);
  const counts = {
    total: nonNegativeInteger(countsRecord.total),
    inUse: nonNegativeInteger(countsRecord.inUse),
    idle: nonNegativeInteger(countsRecord.idle),
    notRequired: nonNegativeInteger(countsRecord.notRequired),
  };
  const generatedAt = identity(record.generatedAt);
  if (!Number.isFinite(Date.parse(generatedAt))) {
    return fail();
  }
  const bagById = new Map(bags.map((bag) => [bag.id, bag]));
  const candidateIds = new Set(returnCandidates.map((bag) => bag.id));
  if (
    bagById.size !== bags.length ||
    candidateIds.size !== returnCandidates.length ||
    returnCandidates.some((candidate) => {
      const source = bagById.get(candidate.id);
      return (
        source?.classification !== 'idle_not_required' ||
        JSON.stringify(source) !== JSON.stringify(candidate)
      );
    })
  ) {
    return fail();
  }
  const actualInUse = bags.filter(
    (bag) => bag.classification === 'in_use',
  ).length;
  const actualNotRequired = bags.filter(
    (bag) => bag.classification === 'idle_not_required',
  ).length;
  if (
    counts.total !== bags.length ||
    counts.inUse !== actualInUse ||
    counts.idle !== bags.length - actualInUse ||
    counts.notRequired !== actualNotRequired ||
    counts.notRequired !== returnCandidates.length
  ) {
    return fail();
  }
  return { counts, bags, returnCandidates, generatedAt };
}

export async function fetchProductionBigBagSummary(): Promise<ProductionBigBagSummary> {
  return parseProductionBigBagSummary(
    await apiGet<unknown>('/api/production/big-bags/summary'),
  );
}
