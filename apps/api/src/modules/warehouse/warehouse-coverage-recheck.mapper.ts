import { BadRequestException, ConflictException } from '@nestjs/common';
import type { WarehouseCoverageReasonCode } from '@plenka/contracts';
import {
  canonicalDimension,
  canonicalizeRollCoverageSpec,
  normalizeCoverageText,
  normalizeIngredients,
  normalizeSpool,
  parseKgToMilliKg,
  parseThicknessMilliMicron,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
  type CanonicalRollCoverageSpec,
} from '../warehouse-coverage/warehouse-coverage-canonical';
import type {
  CanonicalWarehouseCoverageCorrectionCommand,
  CanonicalWarehouseCoverageCorrectionCommandSpec,
} from '../warehouse-coverage/warehouse-coverage-command.service';
import type { CanonicalWarehouseFactCorrection } from '../warehouse-coverage/warehouse-roll-coverage-fact.service';
import type {
  ResolveWarehouseCoverageRecheckDto,
  WarehouseCoverageFactCorrectionSpec,
} from './dto/warehouse-coverage-recheck.dto';

export interface WarehouseCoverageRecheckMemberProjection {
  membershipId: string;
  rollCode: string;
  sourceKind: 'verified_candidate' | 'uncertain_candidate' | 'decision_match';
  reasonCodes: WarehouseCoverageReasonCode[];
  currentFactVersion: number | null;
  ownerVerified: boolean;
  currentSpec: WarehouseCoverageFactCorrectionSpec | null;
}

export interface WarehouseCoverageRecheckItem {
  caseId: string;
  coverageOrigin: 'finance_request' | 'decision_linked_physical_exception';
  caseVersion: number;
  generation: number;
  stateVersion: number;
  reasonCodes: WarehouseCoverageReasonCode[];
  members: WarehouseCoverageRecheckMemberProjection[];
}

export interface WarehouseCoverageCorrectionContext {
  rollId: string;
  rollCode: string;
  sourceOrderId: string | null;
  sourcePositionId: string | null;
  currentOwnerCounterpartyId: string | null;
  currentSpec: CanonicalRollCoverageSpec | null;
}

export function canonicalizeWarehouseCoverageCorrectionCommand(
  input: ResolveWarehouseCoverageRecheckDto['corrections'][number],
): CanonicalWarehouseCoverageCorrectionCommand {
  try {
    const common = {
      membershipId: opaqueId(input.membershipId, 'membershipId'),
      expectedFactVersion: nullablePositiveInteger(
        input.expectedFactVersion,
        'expectedFactVersion',
      ),
    };
    const owner =
      input.ownerCounterpartyId === undefined
        ? {}
        : {
            ownerCounterpartyId: opaqueId(input.ownerCounterpartyId, 'ownerCounterpartyId'),
          };
    const spec = input.spec === undefined ? {} : { spec: canonicalCommandSpec(input.spec) };
    if (Object.keys(owner).length === 0 && Object.keys(spec).length === 0) {
      throw new Error('owner or spec correction required');
    }
    return {
      ...common,
      ...owner,
      ...spec,
    } as CanonicalWarehouseCoverageCorrectionCommand;
  } catch (error) {
    throw badCorrection(error);
  }
}

export function mapWarehouseCoverageCorrection(
  input: CanonicalWarehouseCoverageCorrectionCommand,
  context: WarehouseCoverageCorrectionContext,
  reason: string,
): CanonicalWarehouseFactCorrection {
  const canonicalReason = reason.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (canonicalReason.length < 3 || canonicalReason.length > 500) {
    throw new BadRequestException('reason must contain 3 to 500 characters');
  }
  if (input.spec === undefined && input.ownerCounterpartyId === undefined) {
    throw new BadRequestException('owner or spec correction required');
  }
  if (input.spec === undefined && context.currentSpec === null) {
    throw new ConflictException('full specification required');
  }

  const businessSpec = input.spec ?? context.currentSpec;
  if (businessSpec === null) throw new ConflictException('full specification required');
  const ownerCounterpartyId = input.ownerCounterpartyId ?? context.currentOwnerCounterpartyId;
  const nextSpec =
    input.spec === undefined
      ? {
          ...businessSpec,
          rollCode: context.rollCode,
          sourceOrderId: context.sourceOrderId,
          sourcePositionId: context.sourcePositionId,
          ownerCounterpartyId,
          policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
        }
      : {
          rollCode: context.rollCode,
          sourceOrderId: context.sourceOrderId,
          sourcePositionId: context.sourcePositionId,
          ownerCounterpartyId,
          ...businessSpec,
          policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
        };

  try {
    return {
      rollId: context.rollId,
      expectedFactVersion: input.expectedFactVersion,
      reason: canonicalReason,
      nextSpec: canonicalizeRollCoverageSpec(nextSpec),
    };
  } catch {
    throw new ConflictException('full specification required');
  }
}

function canonicalCommandSpec(
  input: WarehouseCoverageFactCorrectionSpec,
): CanonicalWarehouseCoverageCorrectionCommandSpec {
  return {
    filmType: normalizeCoverageText(input.filmType),
    actualThicknessMilliMicron: parseThicknessMilliMicron(input.actualThickness),
    accountingThicknessMilliMicron: parseThicknessMilliMicron(input.accountingThickness),
    widthMilliMm: requireCanonicalDimension(input.widthMm, 'widthMm'),
    plannedLengthMilliM: requireCanonicalDimension(input.plannedLengthM, 'plannedLengthM'),
    birka: normalizeCoverageText(input.birka),
    spoolType: normalizeSpool(input.spoolType),
    actualWeightMilliKg: parseKgToMilliKg(input.actualWeightKg),
    plannedWeightMilliKg: parseKgToMilliKg(input.plannedWeightKg),
    recipeId: nullableOpaqueId(input.recipeId, 'recipeId'),
    recipeVersion: nullableOpaqueId(input.recipeVersion, 'recipeVersion'),
    recipeDefinitionId: nullableOpaqueId(input.recipeDefinitionId, 'recipeDefinitionId'),
    recipeDefinitionVersionId: nullableOpaqueId(
      input.recipeDefinitionVersionId,
      'recipeDefinitionVersionId',
    ),
    recipeVersionNumber: nullablePositiveInteger(input.recipeVersionNumber, 'recipeVersionNumber'),
    ingredients: normalizeIngredients(input.ingredients),
  };
}

function requireCanonicalDimension(value: unknown, field: string): number {
  const canonical = canonicalDimension(value);
  if (canonical === null) throw new Error(`${field} must be positive and finite`);
  return canonical;
}

function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${field} must be a non-empty canonical ID`);
  }
  return value;
}

function nullableOpaqueId(value: unknown, field: string): string | null {
  return value === null ? null : opaqueId(value, field);
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer or null`);
  }
  return value as number;
}

function badCorrection(error: unknown): BadRequestException {
  return new BadRequestException(error instanceof Error ? error.message : 'invalid correction');
}
