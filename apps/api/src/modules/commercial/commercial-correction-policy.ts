import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type CorrectionRollCandidate = {
  completedAt: Date | null;
  status: string;
  characteristicsSnapshot: Prisma.JsonValue;
  operatorLine: {
    spoolKg: number | null;
    grossKg: number | null;
    netKg: number | null;
    warehouseState: string;
    weightCaptures: Array<{
      kind: string;
      grossKg: number | null;
      netKg: number | null;
    }>;
  } | null;
};

export function hasConsumedMaterialFacts(item: CorrectionRollCandidate) {
  const line = item.operatorLine;
  return (
    Boolean(item.completedAt) ||
    ['ready_for_warehouse', 'done'].includes(item.status) ||
    line?.spoolKg != null ||
    line?.grossKg != null ||
    line?.netKg != null ||
    (line != null && line.warehouseState !== 'not_ready') ||
    (line?.weightCaptures.length ?? 0) > 0
  );
}

export function correctionSnapshot(value: Prisma.JsonValue) {
  if (value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('Roll characteristics snapshot has an invalid JSON shape.');
  }
  return value as Record<string, Prisma.JsonValue>;
}

export function recipeVersionNumber(version: string) {
  const match = /^v([1-9]\d*)$/.exec(version);
  if (!match) throw new ConflictException(`Unsupported recipe version ${version}`);
  return Number(match[1]);
}
