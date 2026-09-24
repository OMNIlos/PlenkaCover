import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
} from '../modules/warehouse-coverage/warehouse-coverage-canonical';
import {
  buildWarehouseCoverageShadowReport,
  runWarehouseCoverageShadow,
  type ShadowWriteSensitiveCounts,
  type WarehouseCoverageShadowAggregates,
  type WarehouseCoverageShadowClient,
} from './warehouse-coverage-shadow';

const GENERATED_AT = '2026-07-25T12:00:00.000Z';

const COUNTS: ShadowWriteSensitiveCounts = {
  reservations: 2,
  tasks: 3,
  facts: 4,
  calculations: 5,
  decisions: 6,
  commands: 7,
  epoch: '8',
};

const VALID_AGGREGATES: WarehouseCoverageShadowAggregates = {
  evaluatedOrders: 1,
  completeOrders: 1,
  skippedOrders: 0,
  byAvailability: {
    verified_full: 0,
    unavailable: 1,
    unknown: 0,
  },
  byReason: {
    no_compatible_rolls: 1,
  },
  errors: 0,
};

const COMPLETE_ORDER = {
  id: 'order-shadow-complete',
  version: 1,
  warehouseCoverageWorkflowVersion: 2,
  counterpartyId: 'counterparty-shadow',
  positions: [
    {
      id: 'position-shadow',
      version: 1,
      rollCount: 1,
      filmType: 'Плёнка ПЭ',
      actualThickness: '80 мкм',
      accountingThickness: '80 мкм',
      widthMm: 1700,
      plannedLengthM: 275,
      baseRawMaterialDefinitionId: 'raw-material-shadow',
      recipeDefinitionVersionId: null,
      spoolType: '76 мм',
      birka: 'А',
      plannedWeightKg: 275,
      recipe: {
        id: 'recipe-shadow',
        version: 'v1',
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            rawMaterialDefinitionId: 'raw-material-shadow',
            shareBasisPoints: 10_000,
          },
        ],
      },
    },
  ],
};

const INCOMPLETE_ORDER = {
  ...COMPLETE_ORDER,
  id: 'order-shadow-incomplete',
  positions: [
    {
      ...COMPLETE_ORDER.positions[0],
      id: 'position-shadow-incomplete',
      plannedWeightKg: null,
    },
  ],
};

interface ShadowHarness {
  client: WarehouseCoverageShadowClient;
  sqlTrace: string[];
}

function stockCandidateWithMismatchedSourceOrder() {
  const spec = canonicalizeRollCoverageSpec({
    rollCode: 'STOCK-SHADOW-001',
    sourceOrderId: 'wrong-stock-order',
    sourcePositionId: 'stock-position-shadow',
    ownerCounterpartyId: null,
    filmType: 'Плёнка ПЭ',
    actualThicknessMilliMicron: 80_000,
    accountingThicknessMilliMicron: 80_000,
    widthMilliMm: 1_700_000,
    plannedLengthMilliM: 275_000,
    birka: 'А',
    spoolType: '76 мм',
    actualWeightMilliKg: 275_000,
    plannedWeightMilliKg: 275_000,
    recipeId: 'recipe-stock-shadow',
    recipeVersion: 'v1',
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    ingredients: [
      {
        rawMaterialDefinitionId: 'raw-material-shadow',
        shareBasisPoints: 10_000,
      },
    ],
    policyVersion: 'warehouse-coverage-policy/v2',
  });
  return {
    id: 'stock-roll-shadow',
    rollCode: spec.rollCode,
    ownerCounterpartyId: null,
    producedForStockOrderId: 'stock-order-shadow',
    producedForOrderId: null,
    producedForStockOrder: {
      requestType: 'stock_reserve',
      positions: [{ id: 'stock-position-shadow' }],
    },
    warehouseStatus: 'received',
    reservedForOrderId: null,
    reservedForPositionId: null,
    reservedByProposalId: null,
    reservedByCoverageDecisionId: null,
    currentCoverageFactId: 'stock-fact-shadow',
    currentCoverageFact: {
      id: 'stock-fact-shadow',
      specVersion: 'warehouse-roll-coverage/v1',
      specFingerprint: fingerprintRollFact(spec),
      spec,
      sourceOrderId: 'stock-order-shadow',
      sourcePositionId: 'stock-position-shadow',
    },
    coverageMemberships: [],
  };
}

function createHarness(
  candidates: readonly ReturnType<typeof stockCandidateWithMismatchedSourceOrder>[] = [],
): ShadowHarness {
  const sqlTrace: string[] = [];
  const tx = {
    $executeRawUnsafe: async (sql: string) => {
      sqlTrace.push(sql);
      return 0;
    },
    $queryRaw: async () => {
      sqlTrace.push('candidate_ids');
      return candidates.map(({ id }) => ({ id }));
    },
    commercialOrder: {
      findMany: async () => {
        sqlTrace.push('orders');
        return [COMPLETE_ORDER, INCOMPLETE_ORDER];
      },
    },
    warehouseRoll: {
      count: async () => {
        sqlTrace.push('reservations');
        return COUNTS.reservations;
      },
      findMany: async () => candidates,
    },
    warehouseAcceptanceTask: {
      count: async () => {
        sqlTrace.push('tasks');
        return COUNTS.tasks;
      },
    },
    warehouseRollCoverageFact: {
      count: async () => {
        sqlTrace.push('facts');
        return COUNTS.facts;
      },
    },
    warehouseCoverageCalculation: {
      count: async () => {
        sqlTrace.push('calculations');
        return COUNTS.calculations;
      },
    },
    warehouseCoverageDecision: {
      count: async () => {
        sqlTrace.push('decisions');
        return COUNTS.decisions;
      },
    },
    warehouseCoverageCommand: {
      count: async () => {
        sqlTrace.push('commands');
        return COUNTS.commands;
      },
    },
    warehouseCoverageInventoryEpoch: {
      findUnique: async () => {
        sqlTrace.push('epoch');
        return { epoch: BigInt(COUNTS.epoch) };
      },
    },
  };
  return {
    sqlTrace,
    client: {
      $transaction: async (callback) => callback(tx as never),
    },
  };
}

describe('warehouse coverage shadow runner', () => {
  let directory: string;
  let outputPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'warehouse-coverage-shadow-'));
    outputPath = join(directory, 'report.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('sets the transaction read-only before querying orders', async () => {
    const harness = createHarness();

    await runWarehouseCoverageShadow(harness.client, outputPath, () => new Date(GENERATED_AT));

    expect(harness.sqlTrace[0]).toBe('SET TRANSACTION READ ONLY');
  });

  it('writes only reconciled aggregates and no business identifiers', async () => {
    const harness = createHarness();

    const report = await runWarehouseCoverageShadow(
      harness.client,
      outputPath,
      () => new Date(GENERATED_AT),
    );
    const persisted = JSON.parse(await readFile(outputPath, 'utf8')) as unknown;

    expect(report).toEqual({
      schemaVersion: 'warehouse-coverage-shadow-report/v1',
      generatedAt: GENERATED_AT,
      evaluatedOrders: 2,
      completeOrders: 1,
      skippedOrders: 1,
      byAvailability: {
        verified_full: 0,
        unavailable: 1,
        unknown: 0,
      },
      byReason: {
        no_compatible_rolls: 1,
        order_spec_incomplete: 1,
      },
      errors: 0,
      before: COUNTS,
      after: COUNTS,
      passed: true,
    });
    expect(persisted).toEqual(report);
    expect(report.evaluatedOrders).toBe(report.completeOrders + report.skippedOrders);
    expect(report.before).toEqual(report.after);
    expect(JSON.stringify(report)).not.toMatch(
      /roll(Id|Code)|counterparty|order(Number|Id)|positionId|coverageFactId/u,
    );
    expect(await readdir(directory)).toEqual(['report.json']);
  });

  it('keeps provenance-inconsistent company stock uncertain in the shadow calculation', async () => {
    const harness = createHarness([stockCandidateWithMismatchedSourceOrder()]);

    const report = await runWarehouseCoverageShadow(
      harness.client,
      outputPath,
      () => new Date(GENERATED_AT),
    );

    expect(report.byAvailability).toEqual({
      verified_full: 0,
      unavailable: 0,
      unknown: 1,
    });
    expect(report.byReason).toEqual(
      expect.objectContaining({
        roll_facts_incomplete: 1,
      }),
    );
  });

  it('fails closed when evaluated totals do not reconcile', () => {
    const report = buildWarehouseCoverageShadowReport(
      COUNTS,
      COUNTS,
      {
        ...VALID_AGGREGATES,
        evaluatedOrders: 2,
      },
      new Date(GENERATED_AT),
    );

    expect(report.passed).toBe(false);
  });

  it('fails closed when a write-sensitive count changes', () => {
    const report = buildWarehouseCoverageShadowReport(
      COUNTS,
      { ...COUNTS, epoch: '9' },
      VALID_AGGREGATES,
      new Date(GENERATED_AT),
    );

    expect(report.passed).toBe(false);
  });

  it('fails closed and removes unsupported reason keys', () => {
    const report = buildWarehouseCoverageShadowReport(
      COUNTS,
      COUNTS,
      {
        ...VALID_AGGREGATES,
        byReason: {
          ...VALID_AGGREGATES.byReason,
          internal_roll_identifier: 1,
        },
      },
      new Date(GENERATED_AT),
    );

    expect(report.passed).toBe(false);
    expect(report.byReason).toEqual({ no_compatible_rolls: 1 });
    expect(JSON.stringify(report)).not.toContain('internal_roll_identifier');
  });

  it('fails closed when an order evaluation reports an error', () => {
    const report = buildWarehouseCoverageShadowReport(
      COUNTS,
      COUNTS,
      {
        ...VALID_AGGREGATES,
        evaluatedOrders: 1,
        completeOrders: 0,
        skippedOrders: 1,
        byAvailability: {
          verified_full: 0,
          unavailable: 0,
          unknown: 0,
        },
        byReason: {},
        errors: 1,
      },
      new Date(GENERATED_AT),
    );

    expect(report.passed).toBe(false);
  });
});
