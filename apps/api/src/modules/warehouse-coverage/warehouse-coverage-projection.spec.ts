import type {
  WarehouseCoverageCalculation as PersistedCoverageCalculation,
  WarehouseCoverageState as PersistedCoverageState,
} from '@prisma/client';
import {
  WAREHOUSE_COVERAGE_ACTIONS,
  type WarehouseCoverageAction,
  type WarehouseCoverageAvailability,
  type WarehouseCoverageReasonCode,
  type WarehouseCoverageState,
} from '@plenka/contracts';
import {
  effectiveCoverageRoutingReason,
  projectWarehouseCoverage,
  type CoverageProjectionContext,
} from './warehouse-coverage-projection';

const NOW = new Date('2026-07-25T08:30:00.000Z');
const ALL_ACTIONS = [...WAREHOUSE_COVERAGE_ACTIONS];

function calculation(
  availability: WarehouseCoverageAvailability,
  reasonCodes: readonly WarehouseCoverageReasonCode[] = [],
  overrides: Partial<PersistedCoverageCalculation> = {},
): PersistedCoverageCalculation {
  return {
    id: 'calculation-2',
    orderId: 'order-1',
    generation: 2,
    orderVersion: 7,
    positionVersions: [],
    orderFingerprint: 'a'.repeat(64),
    inventoryEpoch: 17n,
    inventoryFingerprint: 'b'.repeat(64),
    inputFingerprint: 'c'.repeat(64),
    algorithmVersion: 'warehouse-coverage-matching/v1',
    policyVersion: 'warehouse-coverage-policy/v2',
    availability,
    reasonCodes: [...reasonCodes],
    requiredRollCount: 4,
    matchedRollCount: availability === 'verified_full' ? 4 : 0,
    uncertainRollCount: availability === 'unknown' ? 2 : 0,
    verifiedCandidateRollIds: [],
    uncertainCandidateRollIds: [],
    systemActorKey: 'warehouse_coverage_engine',
    calculatedAt: NOW,
    ...overrides,
  };
}

function state(
  value: WarehouseCoverageState,
  hasCalculation = value !== 'calculating',
  overrides: Partial<PersistedCoverageState> = {},
): PersistedCoverageState {
  return {
    orderId: 'order-1',
    state: value,
    stateVersion: 5,
    generation: hasCalculation ? 2 : 0,
    currentCalculationId: hasCalculation ? 'calculation-2' : null,
    currentDecisionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function context(
  stateValue: WarehouseCoverageState,
  availability: WarehouseCoverageAvailability | null,
  reasonCodes: readonly WarehouseCoverageReasonCode[] = [],
  reserveTaskStatus: CoverageProjectionContext['reserveTaskStatus'] = null,
  overrides: Partial<CoverageProjectionContext> = {},
): CoverageProjectionContext {
  const persistedCalculation =
    availability === null ? null : calculation(availability, reasonCodes);
  return {
    workflowVersion: 2,
    state: state(stateValue, persistedCalculation !== null),
    calculation: persistedCalculation,
    currentInventoryEpoch: 17n,
    orderCancellationStatus: 'active',
    productionOrderExists: false,
    currentDecisionKind:
      stateValue === 'production_required' || stateValue === 'stale'
        ? 'auto_produce_all'
        : stateValue === 'warehouse_reserved'
          ? 'use_warehouse'
          : null,
    reserveTaskStatus,
    permittedActions: ALL_ACTIONS,
    ...overrides,
  };
}

function uniquePermutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) return [[]];
  const result = new Map<string, T[]>();
  values.forEach((value, index) => {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of uniquePermutations(remaining)) {
      const permutation = [value, ...suffix];
      result.set(JSON.stringify(permutation), permutation);
    }
  });
  return [...result.values()];
}

describe('warehouse coverage safe projection', () => {
  it.each([
    {
      label: 'calculating',
      context: context('calculating', null),
      nextOwner: 'system',
      availableActions: [],
    },
    {
      label: 'fresh verified full',
      context: context('awaiting_finance', 'verified_full', ['full_cover_available']),
      nextOwner: 'finance',
      availableActions: ['use_warehouse', 'produce_all', 'request_recheck'],
    },
    {
      label: 'explicit stale',
      context: context('stale', 'unavailable', ['inventory_changed']),
      nextOwner: 'system',
      availableActions: ['refresh'],
    },
    {
      label: 'incomplete order specification',
      context: context('unknown', 'unknown', ['order_spec_incomplete']),
      nextOwner: 'commercial',
      availableActions: ['correct_order_spec'],
    },
    {
      label: 'incomplete roll facts',
      context: context('unknown', 'unknown', ['roll_facts_incomplete']),
      nextOwner: 'finance',
      availableActions: ['request_recheck'],
    },
    {
      label: 'pending warehouse recheck',
      context: context('recheck_requested', 'unknown', ['roll_facts_incomplete']),
      nextOwner: 'warehouse',
      availableActions: ['resolve_recheck'],
    },
    {
      label: 'production required before materialization',
      context: context('production_required', 'unavailable'),
      nextOwner: 'system',
      availableActions: ['request_recheck'],
    },
    {
      label: 'production required after materialization',
      context: context('production_required', 'unavailable', [], null, {
        productionOrderExists: true,
      }),
      nextOwner: 'system',
      availableActions: [],
    },
    {
      label: 'warehouse reservation with an open task',
      context: context('warehouse_reserved', 'verified_full', ['full_cover_available'], 'open'),
      nextOwner: 'warehouse',
      availableActions: [],
    },
    {
      label: 'warehouse reservation with a partial task',
      context: context('warehouse_reserved', 'verified_full', ['full_cover_available'], 'partial'),
      nextOwner: 'warehouse',
      availableActions: [],
    },
    {
      label: 'warehouse reservation with a closed task',
      context: context('warehouse_reserved', 'verified_full', ['full_cover_available'], 'closed'),
      nextOwner: 'system',
      availableActions: [],
    },
    {
      label: 'unsupported policy',
      context: context('unknown', 'unknown', ['unsupported_policy_version']),
      nextOwner: 'system',
      availableActions: [],
    },
  ] as const)('routes $label exactly', ({ context: input, nextOwner, availableActions }) => {
    expect(projectWarehouseCoverage(input)).toMatchObject({
      nextOwner,
      availableActions,
    });
  });

  it('returns exact nullable fields and zero counts before the first calculation', () => {
    expect(projectWarehouseCoverage(context('calculating', null))).toEqual({
      workflowVersion: 2,
      state: 'calculating',
      stateVersion: 5,
      generation: null,
      availability: null,
      reasonCodes: [],
      nextOwner: 'system',
      availableActions: [],
      requiredRollCount: 0,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: null,
      stale: false,
    });
  });

  it.each([
    {
      reasons: ['roll_facts_incomplete', 'order_spec_incomplete'] as const,
      effectiveReason: 'order_spec_incomplete',
      nextOwner: 'commercial',
      availableActions: ['correct_order_spec'],
      publicReasons: ['order_spec_incomplete', 'roll_facts_incomplete'],
    },
    {
      reasons: [
        'order_spec_incomplete',
        'unsupported_policy_version',
        'roll_facts_incomplete',
      ] as const,
      effectiveReason: 'unsupported_policy_version',
      nextOwner: 'system',
      availableActions: [],
      publicReasons: [
        'order_spec_incomplete',
        'roll_facts_incomplete',
        'unsupported_policy_version',
      ],
    },
    {
      reasons: [
        'roll_ownership_unverified',
        'roll_facts_incomplete',
        'roll_ownership_unverified',
      ] as const,
      effectiveReason: 'roll_ownership_unverified',
      nextOwner: 'finance',
      availableActions: ['request_recheck'],
      publicReasons: ['roll_facts_incomplete', 'roll_ownership_unverified'],
    },
  ])(
    'routes mixed unknown reasons independently of order and duplicates: $reasons',
    ({ reasons, effectiveReason, nextOwner, availableActions, publicReasons }) => {
      for (const permutation of uniquePermutations(reasons)) {
        const input = context('unknown', 'unknown', permutation);
        expect(effectiveCoverageRoutingReason(permutation)).toBe(effectiveReason);
        expect(projectWarehouseCoverage(input)).toMatchObject({
          reasonCodes: publicReasons,
          nextOwner,
          availableActions,
        });
      }
    },
  );

  it('does not let unknown reasons override a fixed terminal route', () => {
    expect(
      projectWarehouseCoverage(
        context(
          'warehouse_reserved',
          'verified_full',
          ['order_spec_incomplete', 'unsupported_policy_version'],
          'open',
        ),
      ),
    ).toMatchObject({ nextOwner: 'warehouse', availableActions: [] });
  });

  it('keeps both roll-fact reasons on the same safe route for order and duplicate variants', () => {
    for (const reasons of [
      ['roll_facts_incomplete', 'roll_ownership_unverified'],
      ['roll_ownership_unverified', 'roll_facts_incomplete'],
      ['roll_ownership_unverified', 'roll_facts_incomplete', 'roll_ownership_unverified'],
    ] as const) {
      expect(projectWarehouseCoverage(context('unknown', 'unknown', reasons))).toMatchObject({
        reasonCodes: ['roll_facts_incomplete', 'roll_ownership_unverified'],
        nextOwner: 'finance',
        availableActions: ['request_recheck'],
      });
    }
  });

  it('intersects every route action with the permitted action set', () => {
    const verified = context('awaiting_finance', 'verified_full', ['full_cover_available'], null, {
      permittedActions: ['use_warehouse', 'produce_all'],
    });
    expect(projectWarehouseCoverage(verified).availableActions).toEqual([
      'use_warehouse',
      'produce_all',
    ]);

    const commercial = context('unknown', 'unknown', ['order_spec_incomplete'], null, {
      permittedActions: [],
    });
    expect(projectWarehouseCoverage(commercial).availableActions).toEqual([]);

    const warehouse = context('recheck_requested', 'unknown', [], null, {
      permittedActions: ['resolve_recheck'],
    });
    expect(projectWarehouseCoverage(warehouse).availableActions).toEqual(['resolve_recheck']);
  });

  it('offers pre-production request_recheck only when permitted and never after materialization', () => {
    const before = context('production_required', 'unavailable', [], null, {
      permittedActions: ['request_recheck'],
    });
    expect(projectWarehouseCoverage(before).availableActions).toEqual(['request_recheck']);
    for (const permittedActions of [
      [],
      ['correct_order_spec'],
      ['resolve_recheck'],
      ['report_physical_exception'],
    ] as WarehouseCoverageAction[][]) {
      expect(projectWarehouseCoverage({ ...before, permittedActions }).availableActions).toEqual(
        [],
      );
    }
    expect(
      projectWarehouseCoverage({
        ...before,
        productionOrderExists: true,
      }).availableActions,
    ).toEqual([]);
  });

  it('projects an epoch mismatch as stale without mutating the persisted snapshot', () => {
    const input = context('awaiting_finance', 'verified_full', ['full_cover_available'], null, {
      currentInventoryEpoch: 18n,
    });
    const stateBefore = { ...input.state };
    const calculationBefore = {
      ...input.calculation,
      reasonCodes: [...((input.calculation?.reasonCodes as unknown[]) ?? [])],
    };

    expect(projectWarehouseCoverage(input)).toMatchObject({
      state: 'stale',
      stale: true,
      reasonCodes: ['inventory_changed'],
      nextOwner: 'system',
      availableActions: ['refresh'],
    });
    expect(input.state).toEqual(stateBefore);
    expect(input.calculation).toEqual(calculationBefore);
  });

  it('projects a decisionless order-spec invalidation as refreshable without inventing inventory change', () => {
    const input = context(
      'order_spec_changed' as WarehouseCoverageState,
      'unavailable',
      ['no_compatible_rolls'],
      null,
      { currentDecisionKind: null },
    );

    expect(projectWarehouseCoverage(input)).toMatchObject({
      state: 'order_spec_changed',
      stale: true,
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'system',
      availableActions: ['refresh'],
    });
  });

  it('fails closed on refresh when order-spec invalidation retains committed facts', () => {
    const input = context(
      'order_spec_changed' as WarehouseCoverageState,
      'unavailable',
      ['no_compatible_rolls'],
      null,
      {
        currentDecisionKind: 'auto_produce_all',
        productionOrderExists: true,
      },
    );

    expect(projectWarehouseCoverage(input)).toMatchObject({
      state: 'order_spec_changed',
      stale: true,
      nextOwner: 'system',
      availableActions: [],
    });
  });

  it('fails closed on refresh for a cancelled order-spec invalidation', () => {
    const input = context(
      'order_spec_changed' as WarehouseCoverageState,
      'unavailable',
      ['no_compatible_rolls'],
      null,
      {
        currentDecisionKind: null,
        orderCancellationStatus: 'cancelled',
      },
    );

    expect(projectWarehouseCoverage(input)).toMatchObject({
      state: 'order_spec_changed',
      stale: true,
      nextOwner: 'system',
      availableActions: [],
    });
  });

  it('keeps material terminal routes stable after their own epoch-changing writes', () => {
    expect(
      projectWarehouseCoverage(
        context('warehouse_reserved', 'verified_full', ['full_cover_available'], 'open', {
          currentInventoryEpoch: 18n,
        }),
      ),
    ).toMatchObject({ state: 'warehouse_reserved', stale: false, nextOwner: 'warehouse' });
    expect(
      projectWarehouseCoverage(
        context('production_required', 'unavailable', [], null, {
          currentInventoryEpoch: 18n,
          productionOrderExists: true,
        }),
      ),
    ).toMatchObject({ state: 'production_required', stale: false, availableActions: [] });
  });

  it('keeps an explicit produce-all decision terminal when inventory changes', () => {
    expect(
      projectWarehouseCoverage(
        context('production_required', 'verified_full', ['full_cover_available'], null, {
          currentInventoryEpoch: 18n,
          currentDecisionKind: 'produce_all',
        }),
      ),
    ).toMatchObject({
      state: 'production_required',
      stale: false,
      nextOwner: 'system',
      availableActions: [],
    });
  });

  it.each([
    {
      label: 'negative required count',
      overrides: { requiredRollCount: -1 },
    },
    {
      label: 'fractional matched count',
      overrides: { matchedRollCount: 0.5 },
    },
    {
      label: 'matched count above required count',
      overrides: { requiredRollCount: 1, matchedRollCount: 2 },
    },
    {
      label: 'negative uncertain count',
      overrides: { uncertainRollCount: -1 },
    },
  ])('fails closed for $label', ({ overrides }) => {
    const input = context('unknown', 'unknown', ['roll_facts_incomplete']);
    input.calculation = calculation('unknown', ['roll_facts_incomplete'], overrides);
    expect(() => projectWarehouseCoverage(input)).toThrow(
      'Warehouse coverage projection invariant',
    );
  });

  it.each([
    context('awaiting_finance', 'unavailable'),
    context('unknown', 'verified_full', ['full_cover_available']),
    context('unknown', 'unknown', ['only_partial_cover']),
    context('warehouse_reserved', 'verified_full', ['full_cover_available'], null),
    context('production_required', 'unavailable', [], null, {
      currentDecisionKind: 'produce_all',
    }),
    context('production_required', 'verified_full', ['full_cover_available'], null, {
      currentDecisionKind: 'auto_produce_all',
    }),
  ])('fails closed for an unsupported state tuple', (input) => {
    expect(() => projectWarehouseCoverage(input)).toThrow(
      'Warehouse coverage projection invariant',
    );
  });
});
