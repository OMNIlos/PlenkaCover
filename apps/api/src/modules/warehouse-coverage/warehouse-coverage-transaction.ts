import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { UuidString } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { compareOpaqueIdsBinary } from './warehouse-coverage-canonical';

export const COVERAGE_RETRY_POLICY = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 40,
  retryableCodes: ['P2034', '40001', '40P01'],
} as const;

export const COVERAGE_LOCK_HIERARCHY = [
  'command_advisory_key',
  'business_scope_advisories',
  'inventory_epoch',
  'coverage_state',
  'commercial_order',
  'current_calculation',
  'current_decision',
  'production_order',
  'recheck_case',
  'warehouse_task',
  'scan_row',
  'warehouse_rolls_binary',
] as const;

export interface CoverageRetryRuntime {
  sleep(delayMs: number): Promise<void>;
  random(): number;
}

export type CoverageConflictCode = 'P2034' | '40001' | '40P01' | 'coverage_conflict';

export interface CoverageTerminalConflictHook {
  increment(code: CoverageConflictCode): void;
}

export const COVERAGE_TERMINAL_CONFLICT_HOOK = Symbol('COVERAGE_TERMINAL_CONFLICT_HOOK');

@Injectable()
export class NoopCoverageTerminalConflictHook implements CoverageTerminalConflictHook {
  increment(_code: CoverageConflictCode): void {}
}

const productionRetryRuntime: CoverageRetryRuntime = {
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  random: () => Math.random(),
};
const heldCommandAdvisories = new WeakMap<object, Set<bigint>>();

type RetryableCoverageCode = (typeof COVERAGE_RETRY_POLICY.retryableCodes)[number];

export async function runCoverageSerializable<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient, attempt: number) => Promise<T>,
  runtime: CoverageRetryRuntime = productionRetryRuntime,
  terminalConflictHook: CoverageTerminalConflictHook = new NoopCoverageTerminalConflictHook(),
  timeout?: number,
): Promise<T> {
  for (let attempt = 1; attempt <= COVERAGE_RETRY_POLICY.maxAttempts; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => operation(tx, attempt), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(timeout === undefined ? {} : { timeout }),
      });
    } catch (error) {
      const retryCode = coverageRetryCode(error);
      if (retryCode === null) {
        if (isCoverageDomainConflict(error)) {
          terminalConflictHook.increment('coverage_conflict');
        }
        throw error;
      }
      if (attempt === COVERAGE_RETRY_POLICY.maxAttempts) {
        terminalConflictHook.increment(retryCode);
        throw exhaustedCoverageConflict();
      }
      const cap = Math.min(
        COVERAGE_RETRY_POLICY.maxDelayMs,
        COVERAGE_RETRY_POLICY.baseDelayMs * 2 ** (attempt - 1),
      );
      const floor = Math.floor(cap / 2);
      const random = clampRandom(runtime.random());
      await runtime.sleep(floor + Math.floor(random * (cap - floor)));
    }
  }
  throw new Error('unreachable');
}

@Injectable()
export class WarehouseCoverageTransaction {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(COVERAGE_TERMINAL_CONFLICT_HOOK)
    private readonly terminalConflictHook: CoverageTerminalConflictHook,
  ) {}

  run<T>(
    operation: (tx: Prisma.TransactionClient, attempt: number) => Promise<T>,
    runtime?: CoverageRetryRuntime,
    timeout?: number,
  ): Promise<T> {
    return runCoverageSerializable(
      this.prisma,
      operation,
      runtime,
      this.terminalConflictHook,
      timeout,
    );
  }
}

export interface CoverageLockTargets {
  clientRequestId?: UuidString;
  businessAdvisoryScopes?: readonly string[];
  orderId: string;
  calculationId?: string;
  decisionId?: string;
  productionOrderId?: string;
  caseId?: string;
  taskId?: string;
  scanRowId?: string;
  rollIds?: readonly string[];
  resolveRollIdsAfterCoreLocks?: (tx: Prisma.TransactionClient) => Promise<readonly string[]>;
}

export const COVERAGE_LOCKS_HELD = Symbol('COVERAGE_LOCKS_HELD');

export interface CoverageLocksHeld {
  readonly [COVERAGE_LOCKS_HELD]: true;
  readonly orderId: string;
  readonly acquiredLevels: readonly (typeof COVERAGE_LOCK_HIERARCHY)[number][];
  readonly rollIds: readonly string[];
}

export async function lockCoverageResources(
  tx: Prisma.TransactionClient,
  targets: CoverageLockTargets,
): Promise<CoverageLocksHeld> {
  if (targets.rollIds !== undefined && targets.resolveRollIdsAfterCoreLocks !== undefined) {
    throw new Error('choose static or lazy roll IDs');
  }

  const acquiredLevels: (typeof COVERAGE_LOCK_HIERARCHY)[number][] = [];
  if (targets.clientRequestId !== undefined) {
    assertCanonicalUuid(targets.clientRequestId);
    await lockCoverageCommandAdvisory(tx, targets.clientRequestId);
    acquiredLevels.push('command_advisory_key');
  }

  const businessScopes = binaryUnique(targets.businessAdvisoryScopes ?? []);
  if (businessScopes.length > 0) {
    for (const scope of businessScopes) {
      await acquireAdvisory(tx, advisoryKey('warehouse-coverage-business', scope));
    }
    acquiredLevels.push('business_scope_advisories');
  }

  await lockCoverageInventoryEpoch(tx);
  acquiredLevels.push('inventory_epoch');
  await lockOne(
    tx,
    Prisma.sql`SELECT "orderId" FROM "warehouse_coverage_states"
               WHERE "orderId" = ${targets.orderId} FOR UPDATE`,
    'coverage_state',
  );
  acquiredLevels.push('coverage_state');
  await lockCommercialOrderAggregate(tx, targets.orderId);
  acquiredLevels.push('commercial_order');

  if (targets.calculationId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT calculation."id"
                 FROM "warehouse_coverage_calculations" AS calculation
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = calculation."orderId"
                 WHERE calculation."id" = ${targets.calculationId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND coverage_state."orderId" = ${targets.orderId}
                   AND coverage_state."currentCalculationId" = calculation."id"
                 FOR UPDATE OF calculation`,
      'current_calculation',
    );
    acquiredLevels.push('current_calculation');
  }
  if (targets.decisionId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT decision."id"
                 FROM "warehouse_coverage_decisions" AS decision
                 JOIN "warehouse_coverage_calculations" AS calculation
                   ON decision."calculationId" = calculation."id"
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = decision."orderId"
                 WHERE decision."id" = CAST(${targets.decisionId} AS UUID)
                   AND decision."orderId" = ${targets.orderId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND coverage_state."orderId" = ${targets.orderId}
                   AND coverage_state."currentCalculationId" = calculation."id"
                   AND coverage_state."currentDecisionId" = decision."id"
                   ${exactCalculationPredicate('decision', targets.calculationId)}
                 FOR UPDATE OF decision`,
      'current_decision',
    );
    acquiredLevels.push('current_decision');
  }
  if (targets.productionOrderId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT production_order."id"
                 FROM "production_orders" AS production_order
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = production_order."commercialOrderId"
                 JOIN "warehouse_coverage_calculations" AS calculation
                   ON calculation."id" = production_order."sourceCoverageCalculationId"
                 JOIN "warehouse_coverage_decisions" AS decision
                   ON decision."id" = production_order."sourceCoverageDecisionId"
                 WHERE production_order."id" = ${targets.productionOrderId}
                   AND production_order."commercialOrderId" = ${targets.orderId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND decision."orderId" = ${targets.orderId}
                   AND decision."calculationId" = calculation."id"
                   AND production_order."sourceCoverageCalculationId" =
                       coverage_state."currentCalculationId"
                   AND production_order."sourceCoverageDecisionId" =
                       coverage_state."currentDecisionId"
                   ${exactCalculationPredicate('production_order', targets.calculationId)}
                   ${exactDecisionPredicate('production_order', targets.decisionId)}
                 FOR UPDATE OF production_order`,
      'production_order',
    );
    acquiredLevels.push('production_order');
  }
  if (targets.caseId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT coverage_case."id"
                 FROM "order_resolution_cases" AS coverage_case
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = coverage_case."orderId"
                 JOIN "warehouse_coverage_calculations" AS calculation
                   ON calculation."id" = coverage_case."sourceCoverageCalculationId"
                 LEFT JOIN "warehouse_coverage_decisions" AS decision
                   ON decision."id" = coverage_case."sourceCoverageDecisionId"
                 WHERE coverage_case."id" = ${targets.caseId}
                   AND coverage_case."orderId" = ${targets.orderId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND coverage_case."sourceCoverageCalculationId" =
                       coverage_state."currentCalculationId"
                   AND coverage_case."sourceCoverageDecisionId" IS NOT DISTINCT FROM
                       coverage_state."currentDecisionId"
                   AND (
                     decision."id" IS NULL
                     OR (
                       decision."orderId" = ${targets.orderId}
                       AND decision."calculationId" = calculation."id"
                     )
                   )
                   ${exactCalculationPredicate('coverage_case', targets.calculationId)}
                   ${exactDecisionPredicate('coverage_case', targets.decisionId)}
                 FOR UPDATE OF coverage_case`,
      'recheck_case',
    );
    acquiredLevels.push('recheck_case');
  }
  if (targets.taskId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT acceptance_task."id"
                 FROM "warehouse_acceptance_tasks" AS acceptance_task
                 JOIN "warehouse_coverage_decisions" AS decision
                   ON acceptance_task."coverageDecisionId" = decision."id"
                 JOIN "warehouse_coverage_calculations" AS calculation
                   ON decision."calculationId" = calculation."id"
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = acceptance_task."orderId"
                 WHERE acceptance_task."id" = ${targets.taskId}
                   AND acceptance_task."orderId" = ${targets.orderId}
                   AND decision."orderId" = ${targets.orderId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND coverage_state."currentCalculationId" = calculation."id"
                   AND coverage_state."currentDecisionId" = decision."id"
                   ${exactCalculationPredicate('calculation', targets.calculationId)}
                   ${exactDecisionPredicate('decision', targets.decisionId)}
                 FOR UPDATE OF acceptance_task`,
      'warehouse_task',
    );
    acquiredLevels.push('warehouse_task');
  }
  if (targets.scanRowId !== undefined) {
    await lockOne(
      tx,
      Prisma.sql`SELECT scan_row."id"
                 FROM "scan_rows" AS scan_row
                 JOIN "warehouse_acceptance_tasks" AS acceptance_task
                   ON scan_row."taskId" = acceptance_task."id"
                 JOIN "warehouse_coverage_decisions" AS decision
                   ON acceptance_task."coverageDecisionId" = decision."id"
                 JOIN "warehouse_coverage_calculations" AS calculation
                   ON decision."calculationId" = calculation."id"
                 JOIN "warehouse_coverage_states" AS coverage_state
                   ON coverage_state."orderId" = acceptance_task."orderId"
                 WHERE scan_row."id" = ${targets.scanRowId}
                   AND acceptance_task."orderId" = ${targets.orderId}
                   AND decision."orderId" = ${targets.orderId}
                   AND calculation."orderId" = ${targets.orderId}
                   AND coverage_state."currentCalculationId" = calculation."id"
                   AND coverage_state."currentDecisionId" = decision."id"
                   ${exactTaskPredicate(targets.taskId)}
                   ${exactCalculationPredicate('calculation', targets.calculationId)}
                   ${exactDecisionPredicate('decision', targets.decisionId)}
                 FOR UPDATE OF scan_row`,
      'scan_row',
    );
    acquiredLevels.push('scan_row');
  }

  const resolvedRollIds =
    targets.resolveRollIdsAfterCoreLocks === undefined
      ? (targets.rollIds ?? [])
      : await targets.resolveRollIdsAfterCoreLocks(tx);
  const rollIds = binaryUnique(resolvedRollIds);
  if (rollIds.length > 0) {
    const lockedRolls = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "warehouse_rolls"
                 WHERE "id" IN (${Prisma.join(rollIds)})
                 ORDER BY "id" COLLATE "C" FOR UPDATE`,
    );
    if (
      lockedRolls.length !== rollIds.length ||
      lockedRolls.some((row, index) => row.id !== rollIds[index])
    ) {
      throw missingLockTarget('warehouse_rolls_binary');
    }
    acquiredLevels.push('warehouse_rolls_binary');
  }

  return Object.freeze({
    [COVERAGE_LOCKS_HELD]: true as const,
    orderId: targets.orderId,
    acquiredLevels: Object.freeze(acquiredLevels),
    rollIds: Object.freeze(rollIds),
  });
}

export async function lockCoverageInventoryEpoch(tx: Prisma.TransactionClient): Promise<void> {
  await lockOne(
    tx,
    Prisma.sql`SELECT "id" FROM "warehouse_coverage_inventory_epochs"
               WHERE "id" = 1 FOR UPDATE`,
    'inventory_epoch',
  );
}

export async function lockCommercialOrderAggregate(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<void> {
  await lockOne(
    tx,
    Prisma.sql`SELECT "id" FROM "commercial_orders"
               WHERE "id" = ${orderId} FOR UPDATE`,
    'commercial_order',
  );
}

export function coverageCommandAdvisoryKey(clientRequestId: UuidString): bigint {
  assertCanonicalUuid(clientRequestId);
  return advisoryKey('warehouse-coverage-command', clientRequestId);
}

export async function lockCoverageCommandAdvisory(
  tx: Prisma.TransactionClient,
  clientRequestId: UuidString,
): Promise<void> {
  const key = coverageCommandAdvisoryKey(clientRequestId);
  const held = heldCommandAdvisories.get(tx as object);
  if (held?.has(key)) return;
  await acquireAdvisory(tx, key);
  if (held) {
    held.add(key);
  } else {
    heldCommandAdvisories.set(tx as object, new Set([key]));
  }
}

function coverageRetryCode(error: unknown): RetryableCoverageCode | null {
  const source = asRecord(error);
  if (source?.code === 'P2034') return 'P2034';
  if (source?.code === '40001' || source?.code === '40P01') return source.code;
  const meta = asRecord(source?.meta);
  if (source?.code === 'P2010' && (meta?.code === '40001' || meta?.code === '40P01')) {
    return meta.code;
  }
  return null;
}

function isCoverageDomainConflict(error: unknown): boolean {
  if (!(error instanceof ConflictException)) return false;
  const response = asRecord(error.getResponse());
  return typeof response?.code === 'string' && response.code.startsWith('warehouse_coverage_');
}

function exhaustedCoverageConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'warehouse_coverage_concurrent_state_conflict',
    message: 'Warehouse coverage changed concurrently. Retry with fresh state.',
  });
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1 - Number.EPSILON));
}

function advisoryKey(namespace: string, value: string): bigint {
  const digest = createHash('sha256').update(namespace).update('\0').update(value).digest();
  return digest.readBigInt64BE(0);
}

async function acquireAdvisory(tx: Prisma.TransactionClient, key: bigint): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${key})`);
}

async function lockOne(
  tx: Prisma.TransactionClient,
  query: Prisma.Sql,
  level: (typeof COVERAGE_LOCK_HIERARCHY)[number],
): Promise<void> {
  const rows = await tx.$queryRaw<unknown[]>(query);
  if (rows.length !== 1) throw missingLockTarget(level);
}

function missingLockTarget(level: (typeof COVERAGE_LOCK_HIERARCHY)[number]): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'warehouse_coverage_lock_target_missing',
    message: `Warehouse coverage lock target is no longer current: ${level}`,
  });
}

function binaryUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareOpaqueIdsBinary);
}

function exactCalculationPredicate(
  tableAlias: 'calculation' | 'decision' | 'production_order' | 'coverage_case',
  calculationId: string | undefined,
): Prisma.Sql {
  if (calculationId === undefined) return Prisma.sql``;
  switch (tableAlias) {
    case 'calculation':
      return Prisma.sql`AND calculation."id" = ${calculationId}`;
    case 'decision':
      return Prisma.sql`AND decision."calculationId" = ${calculationId}`;
    case 'production_order':
      return Prisma.sql`AND production_order."sourceCoverageCalculationId" = ${calculationId}`;
    case 'coverage_case':
      return Prisma.sql`AND coverage_case."sourceCoverageCalculationId" = ${calculationId}`;
  }
}

function exactDecisionPredicate(
  tableAlias: 'decision' | 'production_order' | 'coverage_case',
  decisionId: string | undefined,
): Prisma.Sql {
  if (decisionId === undefined) return Prisma.sql``;
  switch (tableAlias) {
    case 'decision':
      return Prisma.sql`AND decision."id" = CAST(${decisionId} AS UUID)`;
    case 'production_order':
      return Prisma.sql`AND production_order."sourceCoverageDecisionId" =
                        CAST(${decisionId} AS UUID)`;
    case 'coverage_case':
      return Prisma.sql`AND coverage_case."sourceCoverageDecisionId" =
                        CAST(${decisionId} AS UUID)`;
  }
}

function exactTaskPredicate(taskId: string | undefined): Prisma.Sql {
  return taskId === undefined ? Prisma.sql`` : Prisma.sql`AND acceptance_task."id" = ${taskId}`;
}

function assertCanonicalUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('clientRequestId must be a canonical UUID');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
