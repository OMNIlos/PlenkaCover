import {
  calculateRollProductionCost,
  fingerprintAllocationDenominator,
  fingerprintProductionOrderSealProof,
  normalizeSpoolTypeKey,
  selectEffectiveSpoolPrice,
  type AllocationDenominator,
  type ProductionOrderSealProof,
  type RecipeReferenceMaterialBasis,
  type RollProductionCostCalculationInput,
} from './production-cost-calculator';

const PRODUCED_AT = new Date('2026-08-02T10:00:00.000Z');
const KNOWN_SPOOL_LABELS = ['втулка 76', 'Шпуля 76 мм', '76 мм'];

function recipe(): RecipeReferenceMaterialBasis {
  return {
    kind: 'recipe_reference',
    components: [
      {
        rawMaterialDefinitionId: 'material-1',
        label: 'ПНД',
        shareBasisPoints: 10_000,
        prices: [
          {
            id: 'material-price-1',
            priceKopecksPerKg: 2_000,
            source: 'Счёт поставщика',
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          },
        ],
      },
    ],
  };
}

function calculation(
  overrides: Partial<RollProductionCostCalculationInput> = {},
): RollProductionCostCalculationInput {
  return {
    basis: { kind: 'actual', weightGrams: 10_000 },
    producedAt: PRODUCED_AT,
    materialBasis: recipe(),
    spool: {
      label: 'Шпуля 76 мм',
      knownTypeLabels: KNOWN_SPOOL_LABELS,
      widthMicrometers: 1_500_000,
      prices: [
        {
          id: 'spool-price-1',
          spoolTypeKey: 'шпуля 76 мм',
          spoolTypeLabel: 'Шпуля 76 мм',
          priceKopecksPerMeter: 6_000,
          source: 'Прайс шпуль',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        },
      ],
    },
    payroll: {
      tariffOrderId: 'payroll-order-v1',
      tariffOrderName: 'Приказ № 1',
      effectiveFrom: new Date('2025-09-28T21:00:00.000Z'),
      rateKopecksPerKg: 400,
      basisLabel: 'базовая ставка',
    },
    additionalCosts: [],
    ...overrides,
  };
}

function allocationDenominator(rows: AllocationDenominator['rows']): AllocationDenominator {
  return {
    sealed: true,
    algorithmVersion: 'largest-remainder-v1',
    rows,
  };
}

function orderSeal(denominator: AllocationDenominator): {
  productionOrderId: string;
  sealProof: ProductionOrderSealProof;
  sealFingerprint: string;
} {
  const sealProof: ProductionOrderSealProof = {
    sealed: true,
    algorithmVersion: 'production-order-terminal-leaves-v1',
    productionOrderId: 'production-order-1',
    rows: denominator.rows.map((row) => ({
      rollDispatchItemId: row.rollDispatchItemId,
      status: 'done',
      replacementAttemptId: null,
      canonicalCaptureId: row.canonicalCaptureId,
      weightGrams: row.weightGrams,
      hasDefect: false,
    })),
  };
  return {
    productionOrderId: sealProof.productionOrderId,
    sealProof,
    sealFingerprint: fingerprintProductionOrderSealProof(sealProof),
  };
}

describe('authoritative exact-integer production cost calculator', () => {
  it('calculates 10 kg × 10% × 20 RUB/kg as exactly 20 RUB', () => {
    const basis = recipe();
    basis.components = [
      { ...basis.components[0], label: 'Добавка', shareBasisPoints: 1_000 },
      {
        ...basis.components[0],
        rawMaterialDefinitionId: 'material-2',
        label: 'Основа',
        shareBasisPoints: 9_000,
        prices: [{ ...basis.components[0].prices[0], id: 'price-2', priceKopecksPerKg: 1 }],
      },
    ];

    const result = calculateRollProductionCost(
      calculation({ materialBasis: basis, spool: null, payroll: null }),
    );

    expect(result.materialSources[0]).toMatchObject({
      kind: 'recipe_reference',
      componentGrams: 1_000,
      allocatedAmountKopecks: 2_000,
    });
  });

  it('calculates a 1500 mm spool at 60 RUB/m as exactly 90 RUB', () => {
    const result = calculateRollProductionCost(calculation());

    expect(result.spoolAmountKopecks).toBe(9_000);
    expect(result.spoolSource).toMatchObject({ sourceId: 'spool-price-1' });
  });

  it('applies an immutable position material ratio with exact half-up money', () => {
    const result = calculateRollProductionCost(
      calculation({
        basis: { kind: 'actual', weightGrams: 3 },
        materialBasis: {
          kind: 'position_observed_rate',
          sourceFingerprint: 'a'.repeat(64),
          sourceSnapshotCount: 2,
          observedWeightGrams: 4,
          observedMaterialAmountKopecks: 2,
        },
      }),
    );

    expect(result.materialAmountKopecks).toBe(2);
    expect(result.materialSources).toEqual([
      expect.objectContaining({
        kind: 'position_observed_rate',
        sourceSnapshotCount: 2,
        allocatedAmountKopecks: 2,
      }),
    ]);
  });

  it('allocates component grams exactly with deterministic id tie order and half-up money', () => {
    const basis = recipe();
    basis.components = [
      {
        ...basis.components[0],
        shareBasisPoints: 5_000,
        prices: [{ ...basis.components[0].prices[0], priceKopecksPerKg: 1_000 }],
      },
      {
        ...basis.components[0],
        rawMaterialDefinitionId: 'material-2',
        shareBasisPoints: 5_000,
        prices: [{ ...basis.components[0].prices[0], id: 'price-2', priceKopecksPerKg: 1 }],
      },
    ];
    const result = calculateRollProductionCost(
      calculation({ basis: { kind: 'actual', weightGrams: 1_001 }, materialBasis: basis }),
    );

    expect(result.materialSources.map((source) => source.componentGrams)).toEqual([501, 500]);
    expect(result.materialSources.reduce((sum, source) => sum + source.componentGrams, 0)).toBe(
      1_001,
    );
    expect(result.materialSources.map((source) => source.allocatedAmountKopecks)).toEqual([501, 1]);
  });

  it.each([
    ['nonfinite', Number.POSITIVE_INFINITY],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
  ])('rejects %s integer source measures', (_label, value) => {
    expect(() =>
      calculateRollProductionCost(calculation({ basis: { kind: 'actual', weightGrams: value } })),
    ).toThrow('weightGrams');
  });

  it('fails closed when recipe shares are duplicated or do not total 10000 basis points', () => {
    const duplicate = recipe().components[0];
    const malformed = calculateRollProductionCost(
      calculation({
        materialBasis: {
          kind: 'recipe_reference',
          components: [
            { ...duplicate, shareBasisPoints: 5_000 },
            { ...duplicate, shareBasisPoints: 5_000 },
          ],
        },
      }),
    );
    const incomplete = calculateRollProductionCost(
      calculation({
        materialBasis: {
          kind: 'recipe_reference',
          components: [{ ...duplicate, shareBasisPoints: 9_999 }],
        },
      }),
    );

    expect(malformed.unresolvedReasons).toContain('material_usage_unresolved');
    expect(incomplete.unresolvedReasons).toContain('material_usage_unresolved');
    expect(malformed.materialSources).toEqual([]);
  });

  it('selects old/new material rows at producedAt, ignores future, and rejects a tied effective row', () => {
    const component = recipe().components[0];
    const rows = [
      {
        ...component.prices[0],
        id: 'old',
        priceKopecksPerKg: 1_000,
        effectiveFrom: new Date('2026-07-01T00:00:00Z'),
      },
      {
        ...component.prices[0],
        id: 'new',
        priceKopecksPerKg: 2_000,
        effectiveFrom: new Date('2026-08-01T00:00:00Z'),
      },
      {
        ...component.prices[0],
        id: 'future',
        priceKopecksPerKg: 9_000,
        effectiveFrom: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    const selected = calculateRollProductionCost(
      calculation({
        materialBasis: {
          kind: 'recipe_reference',
          components: [{ ...component, prices: rows }],
        },
      }),
    );
    const ambiguous = calculateRollProductionCost(
      calculation({
        materialBasis: {
          kind: 'recipe_reference',
          components: [{ ...component, prices: [...rows, { ...rows[1], id: 'tied' }] }],
        },
      }),
    );

    expect(selected.materialSources[0]).toMatchObject({
      sourceId: 'new',
      priceKopecksPerKg: 2_000,
    });
    expect(ambiguous.unresolvedReasons).toContain('material_price_unresolved');
  });

  it('preserves frozen ShiftBagUsage gram and money allocations independently', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedGrams: 1,
        allocatedAmountKopecks: 1,
      },
      {
        rollDispatchItemId: 'roll-2',
        canonicalCaptureId: 'capture-2',
        weightGrams: 1,
        allocatedGrams: 1,
        allocatedAmountKopecks: 0,
      },
    ]);
    const result = calculateRollProductionCost(
      calculation({
        basis: { kind: 'actual', weightGrams: 1 },
        materialBasis: {
          kind: 'shift_bigbag_allocation',
          rollDispatchItemId: 'roll-1',
          sources: [
            {
              usageId: 'usage-1',
              bigBagId: 'bag-1',
              label: 'BB-1',
              effectiveAt: new Date('2026-08-01T00:00:00Z'),
              totalConsumedGrams: 2,
              totalAmountKopecks: 1,
              priceKopecksPerKg: 333,
              denominator,
              denominatorFingerprint: fingerprintAllocationDenominator(denominator),
            },
          ],
        },
      }),
    );

    expect(result.materialAmountKopecks).toBe(1);
    expect(result.materialSources[0]).toMatchObject({
      kind: 'shift_bigbag_allocation',
      componentGrams: 1,
      allocatedAmountKopecks: 1,
    });
  });

  it('rejects one canonical capture reused by two denominator rows', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedAmountKopecks: 1,
      },
      {
        rollDispatchItemId: 'roll-2',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedAmountKopecks: 0,
      },
    ]);

    expect(() =>
      calculateRollProductionCost(
        calculation({
          basis: { kind: 'actual', weightGrams: 1 },
          additionalCosts: [
            {
              kind: 'order_allocation',
              id: 'duplicate-capture',
              source: 'Акт',
              effectiveAt: PRODUCED_AT,
              reason: 'Наладка',
              rollDispatchItemId: 'roll-1',
              totalAmountKopecks: 1,
              denominator,
              denominatorFingerprint: fingerprintAllocationDenominator(denominator),
              ...orderSeal(denominator),
            },
          ],
        }),
      ),
    ).toThrow(/canonical capture|unique/i);
  });

  it.each(['material_usage_unresolved', 'material_price_unresolved'] as const)(
    'accepts an explicit unresolved measured-material state: %s',
    (reason) => {
      const result = calculateRollProductionCost(
        calculation({
          materialBasis: { kind: 'unresolved', reason },
        }),
      );
      expect(result.materialAmountKopecks).toBeNull();
      expect(result.unresolvedReasons).toContain(reason);
    },
  );

  it('rejects duplicate measured usage rows and a fabricated rounded usage total', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedGrams: 2,
        allocatedAmountKopecks: 2,
      },
    ]);
    const source = {
      usageId: 'usage-1',
      bigBagId: 'bag-1',
      label: 'BB-1',
      effectiveAt: PRODUCED_AT,
      totalConsumedGrams: 2,
      totalAmountKopecks: 2,
      priceKopecksPerKg: 333,
      denominator,
      denominatorFingerprint: fingerprintAllocationDenominator(denominator),
    };
    expect(() =>
      calculateRollProductionCost(
        calculation({
          basis: { kind: 'actual', weightGrams: 1 },
          materialBasis: {
            kind: 'shift_bigbag_allocation',
            rollDispatchItemId: 'roll-1',
            sources: [source, source],
          },
        }),
      ),
    ).toThrow(/usage|total/i);
  });

  it.each([
    [
      'missing current row',
      [
        {
          rollDispatchItemId: 'roll-2',
          canonicalCaptureId: 'capture-2',
          weightGrams: 1,
          allocatedGrams: 1,
          allocatedAmountKopecks: 1,
        },
      ],
    ],
    [
      'duplicate row',
      [
        {
          rollDispatchItemId: 'roll-1',
          canonicalCaptureId: 'capture-1',
          weightGrams: 1,
          allocatedGrams: 1,
          allocatedAmountKopecks: 1,
        },
        {
          rollDispatchItemId: 'roll-1',
          canonicalCaptureId: 'capture-1',
          weightGrams: 1,
          allocatedGrams: 0,
          allocatedAmountKopecks: 0,
        },
      ],
    ],
    [
      'invalid sum',
      [
        {
          rollDispatchItemId: 'roll-1',
          canonicalCaptureId: 'capture-1',
          weightGrams: 1,
          allocatedGrams: 2,
          allocatedAmountKopecks: 1,
        },
      ],
    ],
  ])('rejects an invalid frozen allocation denominator: %s', (_label, rows) => {
    const denominator = allocationDenominator(rows);
    expect(() =>
      calculateRollProductionCost(
        calculation({
          basis: { kind: 'actual', weightGrams: 1 },
          materialBasis: {
            kind: 'shift_bigbag_allocation',
            rollDispatchItemId: 'roll-1',
            sources: [
              {
                usageId: 'usage-1',
                bigBagId: 'bag-1',
                label: 'BB-1',
                effectiveAt: PRODUCED_AT,
                totalConsumedGrams: 1,
                totalAmountKopecks: 1,
                priceKopecksPerKg: 1_000,
                denominator,
                denominatorFingerprint: fingerprintAllocationDenominator(denominator),
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it('rejects a tampered frozen allocation fingerprint', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedGrams: 1,
        allocatedAmountKopecks: 1,
      },
    ]);
    expect(() =>
      calculateRollProductionCost(
        calculation({
          basis: { kind: 'actual', weightGrams: 1 },
          materialBasis: {
            kind: 'shift_bigbag_allocation',
            rollDispatchItemId: 'roll-1',
            sources: [
              {
                usageId: 'usage-1',
                bigBagId: 'bag-1',
                label: 'BB-1',
                effectiveAt: PRODUCED_AT,
                totalConsumedGrams: 1,
                totalAmountKopecks: 1,
                priceKopecksPerKg: 1_000,
                denominator,
                denominatorFingerprint: '0'.repeat(64),
              },
            ],
          },
        }),
      ),
    ).toThrow('fingerprint');
  });

  it('distinguishes unknown spool identity from known identity without an effective price', () => {
    const price = calculation().spool!.prices[0];
    expect(
      selectEffectiveSpoolPrice('Неизвестно', KNOWN_SPOOL_LABELS, [price], PRODUCED_AT),
    ).toEqual({
      kind: 'unresolved',
      reason: 'spool_type_unresolved',
    });
    expect(selectEffectiveSpoolPrice('76 мм', KNOWN_SPOOL_LABELS, [price], PRODUCED_AT)).toEqual({
      kind: 'unresolved',
      reason: 'spool_price_unresolved',
    });
  });

  it('fails closed when a stored spool label does not match its normalized key', () => {
    const price = { ...calculation().spool!.prices[0], spoolTypeLabel: '76 мм' };
    expect(
      selectEffectiveSpoolPrice('Шпуля 76 мм', KNOWN_SPOOL_LABELS, [price], PRODUCED_AT),
    ).toEqual({ kind: 'unresolved', reason: 'spool_type_unresolved' });
  });

  it('requires one exact normalized observed label and rejects ambiguous canonical variants', () => {
    const price = calculation().spool!.prices[0];
    expect(
      selectEffectiveSpoolPrice('ШПУЛЯ 76 ММ', KNOWN_SPOOL_LABELS, [price], PRODUCED_AT),
    ).toEqual({ kind: 'unresolved', reason: 'spool_type_unresolved' });
    expect(
      selectEffectiveSpoolPrice(
        'Шпуля 76 мм',
        [...KNOWN_SPOOL_LABELS, 'ШПУЛЯ 76 ММ'],
        [price],
        PRODUCED_AT,
      ),
    ).toEqual({ kind: 'unresolved', reason: 'spool_type_unresolved' });
    expect(
      selectEffectiveSpoolPrice(
        'Шпуля 76 мм',
        KNOWN_SPOOL_LABELS,
        [{ ...price, spoolTypeKey: 'ШПУЛЯ 76 ММ' }],
        PRODUCED_AT,
      ),
    ).toEqual({ kind: 'unresolved', reason: 'spool_type_unresolved' });
  });

  it('validates spool width even when the price is unresolved', () => {
    expect(() =>
      calculateRollProductionCost(
        calculation({
          spool: {
            ...calculation().spool!,
            widthMicrometers: Number.POSITIVE_INFINITY,
            prices: [],
          },
        }),
      ),
    ).toThrow('widthMicrometers');
  });

  it('keeps grounded spool labels distinct and isolates their price histories', () => {
    expect(new Set(KNOWN_SPOOL_LABELS.map(normalizeSpoolTypeKey)).size).toBe(3);
    expect(normalizeSpoolTypeKey('  ШПУЛЯ\u00a0  ЁЖ  ')).toBe('шпуля еж');
    const duplicate = calculation().spool!.prices[0];
    expect(
      selectEffectiveSpoolPrice(
        'Шпуля 76 мм',
        KNOWN_SPOOL_LABELS,
        [duplicate, { ...duplicate, id: 'duplicate' }],
        PRODUCED_AT,
      ),
    ).toEqual({ kind: 'unresolved', reason: 'spool_type_unresolved' });
  });

  it('selects the latest spool price at producedAt, never future/read time', () => {
    const prices = [
      { ...calculation().spool!.prices[0], id: 'old' },
      {
        ...calculation().spool!.prices[0],
        id: 'future',
        effectiveFrom: new Date('2026-08-03T00:00:00Z'),
      },
    ];
    expect(
      selectEffectiveSpoolPrice('Шпуля 76 мм', KNOWN_SPOOL_LABELS, prices, PRODUCED_AT),
    ).toEqual(
      expect.objectContaining({ kind: 'resolved', price: expect.objectContaining({ id: 'old' }) }),
    );
  });

  it('uses planned/actual weight and never reads plannedLengthM for spool cost', () => {
    const actual = calculateRollProductionCost(calculation());
    const planned = calculateRollProductionCost({
      ...calculation({ basis: { kind: 'planned', weightGrams: 20_000 } }),
      plannedLengthM: 999_999_999,
    } as RollProductionCostCalculationInput & { plannedLengthM: number });
    expect(actual.basis).toEqual({ kind: 'actual', weightGrams: 10_000 });
    expect(planned.basis).toEqual({ kind: 'planned', weightGrams: 20_000 });
    expect(actual).toMatchObject({
      materialAmountKopecks: 20_000,
      payrollAmountKopecks: 4_000,
      totalAmountKopecks: 33_000,
      totalKopecksPerKg: 3_300,
    });
    expect(planned).toMatchObject({
      materialAmountKopecks: 40_000,
      payrollAmountKopecks: 8_000,
      totalAmountKopecks: 57_000,
      totalKopecksPerKg: 2_850,
    });
    expect(planned.spoolAmountKopecks).toBe(9_000);
  });

  it('rejects null direct additional cost instead of silently treating it as zero', () => {
    const result = calculateRollProductionCost(
      calculation({
        additionalCosts: [
          {
            kind: 'direct',
            id: 'direct-1',
            source: 'Акт',
            effectiveAt: PRODUCED_AT,
            reason: 'Наладка',
            allocatedAmountKopecks: null,
          } as never,
        ],
      }),
    );
    expect(result.unresolvedReasons).toContain('additional_cost_unresolved');
    expect(result.totalAmountKopecks).toBeNull();
  });

  it('does not resolve payroll from a policy effective after producedAt', () => {
    const result = calculateRollProductionCost(
      calculation({
        payroll: { ...calculation().payroll!, effectiveFrom: new Date('2026-08-03T00:00:00Z') },
      }),
    );
    expect(result.payrollAmountKopecks).toBeNull();
    expect(result.unresolvedReasons).toContain('payroll_unresolved');
  });

  it('keeps an explicit unresolved order denominator partial', () => {
    const result = calculateRollProductionCost(
      calculation({
        additionalCosts: [
          {
            kind: 'unresolved',
            id: 'order-1',
            source: 'Акт',
            effectiveAt: PRODUCED_AT,
            reason: 'Заказ',
            unresolvedReason: 'order_cost_allocation_unresolved',
          },
        ],
      }),
    );
    expect(result.unresolvedReasons).toContain('order_cost_allocation_unresolved');
  });

  it('uses strict sealed order allocations and freezes their denominator fingerprint', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 10_000,
        allocatedAmountKopecks: 2,
      },
      {
        rollDispatchItemId: 'roll-2',
        canonicalCaptureId: 'capture-2',
        weightGrams: 10_000,
        allocatedAmountKopecks: 1,
      },
    ]);
    const fingerprint = fingerprintAllocationDenominator(denominator);
    const result = calculateRollProductionCost(
      calculation({
        additionalCosts: [
          {
            kind: 'order_allocation',
            id: 'order-cost-1',
            source: 'Акт',
            effectiveAt: PRODUCED_AT,
            reason: 'Наладка',
            rollDispatchItemId: 'roll-1',
            totalAmountKopecks: 3,
            denominator,
            denominatorFingerprint: fingerprint,
            ...orderSeal(denominator),
          },
        ],
      }),
    );

    expect(result.additionalAmountKopecks).toBe(2);
    expect(result.additionalSources[0]).toMatchObject({ denominatorFingerprint: fingerprint });
  });

  it('rejects a fingerprinted 3/0 forgery when strict allocation is 2/1', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 10_000,
        allocatedAmountKopecks: 3,
      },
      {
        rollDispatchItemId: 'roll-2',
        canonicalCaptureId: 'capture-2',
        weightGrams: 10_000,
        allocatedAmountKopecks: 0,
      },
    ]);
    expect(() =>
      calculateRollProductionCost(
        calculation({
          additionalCosts: [
            {
              kind: 'order_allocation',
              id: 'forged',
              source: 'Акт',
              effectiveAt: PRODUCED_AT,
              reason: 'Наладка',
              rollDispatchItemId: 'roll-1',
              totalAmountKopecks: 3,
              denominator,
              denominatorFingerprint: fingerprintAllocationDenominator(denominator),
              ...orderSeal(denominator),
            },
          ],
        }),
      ),
    ).toThrow(/allocation algorithm/);
  });

  it('rejects a fingerprinted nonterminal ProductionOrder seal proof', () => {
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 10_000,
        allocatedAmountKopecks: 3,
      },
    ]);
    const base = orderSeal(denominator);
    const sealProof: ProductionOrderSealProof = {
      ...base.sealProof,
      rows: [{ ...base.sealProof.rows[0], status: 'in_progress' }],
    };

    expect(() =>
      calculateRollProductionCost(
        calculation({
          additionalCosts: [
            {
              kind: 'order_allocation',
              id: 'nonterminal-seal',
              source: 'Акт',
              effectiveAt: PRODUCED_AT,
              reason: 'Наладка',
              rollDispatchItemId: 'roll-1',
              productionOrderId: base.productionOrderId,
              totalAmountKopecks: 3,
              denominator,
              denominatorFingerprint: fingerprintAllocationDenominator(denominator),
              sealProof,
              sealFingerprint: fingerprintProductionOrderSealProof(sealProof),
            },
          ],
        }),
      ),
    ).toThrow(/seal|terminal/i);
  });

  it.each([
    ['weight', { basis: { kind: 'actual', weightGrams: null } }, 'weight_unresolved'],
    [
      'recipe',
      { materialBasis: { kind: 'recipe_reference', components: [] } },
      'material_usage_unresolved',
    ],
    [
      'material price',
      {
        materialBasis: {
          kind: 'recipe_reference',
          components: [{ ...recipe().components[0], prices: [] }],
        },
      },
      'material_price_unresolved',
    ],
    [
      'spool identity',
      {
        spool: {
          label: null,
          knownTypeLabels: KNOWN_SPOOL_LABELS,
          widthMicrometers: 1,
          prices: [],
        },
      },
      'spool_type_unresolved',
    ],
    ['spool price', { spool: { ...calculation().spool, prices: [] } }, 'spool_price_unresolved'],
    [
      'spool geometry',
      { spool: { ...calculation().spool, widthMicrometers: null } },
      'spool_geometry_unresolved',
    ],
    ['payroll', { payroll: null }, 'payroll_unresolved'],
  ] as const)('returns partial with a specific reason for missing %s', (_label, patch, reason) => {
    const result = calculateRollProductionCost(calculation(patch as never));
    expect(result.status).toBe('partial');
    expect(result.unresolvedReasons).toContain(reason);
    expect(result.totalAmountKopecks).toBeNull();
  });

  it.each(['derived', 'sum', 'perkg'] as const)('rejects %s safe-integer overflow', (target) => {
    const maximum = Number.MAX_SAFE_INTEGER;
    if (target === 'derived') {
      const basis = recipe();
      basis.components[0].prices[0].priceKopecksPerKg = maximum;
      expect(() =>
        calculateRollProductionCost(
          calculation({
            basis: { kind: 'actual', weightGrams: maximum },
            materialBasis: basis,
          }),
        ),
      ).toThrow(/safe integer range/);
      return;
    }
    const denominator = allocationDenominator([
      {
        rollDispatchItemId: 'roll-1',
        canonicalCaptureId: 'capture-1',
        weightGrams: 1,
        allocatedGrams: 1_000,
        allocatedAmountKopecks: maximum,
      },
    ]);
    const input = calculation({
      basis: { kind: 'actual', weightGrams: 1 },
      materialBasis: {
        kind: 'shift_bigbag_allocation',
        rollDispatchItemId: 'roll-1',
        sources: [
          {
            usageId: 'usage-1',
            bigBagId: 'bag-1',
            label: 'BB-1',
            effectiveAt: PRODUCED_AT,
            totalConsumedGrams: 1_000,
            totalAmountKopecks: maximum,
            priceKopecksPerKg: maximum,
            denominator,
            denominatorFingerprint: fingerprintAllocationDenominator(denominator),
          },
        ],
      },
      spool: {
        ...calculation().spool!,
        widthMicrometers: 1,
        prices: [{ ...calculation().spool!.prices[0], priceKopecksPerMeter: 1 }],
      },
      payroll: { ...calculation().payroll!, rateKopecksPerKg: 1 },
      additionalCosts:
        target === 'sum'
          ? [
              {
                kind: 'direct',
                id: 'direct',
                source: 'Акт',
                effectiveAt: PRODUCED_AT,
                reason: 'x',
                allocatedAmountKopecks: 1,
              },
            ]
          : [],
    });
    expect(() => calculateRollProductionCost(input)).toThrow(/safe integer range/);
  });

  it('returns only safe integer money and source measures', () => {
    const result = calculateRollProductionCost(calculation());
    const values = [
      result.basis.weightGrams,
      result.materialAmountKopecks,
      result.spoolAmountKopecks,
      result.payrollAmountKopecks,
      result.additionalAmountKopecks,
      result.totalAmountKopecks,
      result.totalKopecksPerKg,
      ...result.materialSources.flatMap((source) => [
        source.componentGrams,
        ...('priceKopecksPerKg' in source ? [source.priceKopecksPerKg] : []),
        source.allocatedAmountKopecks,
      ]),
    ].filter((value): value is number => value !== null);
    expect(values.every(Number.isSafeInteger)).toBe(true);
  });
});
