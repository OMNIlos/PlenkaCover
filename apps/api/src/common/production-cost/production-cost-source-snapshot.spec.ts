import {
  buildProductionCostSourceSnapshot,
  type ProductionCostSourceSnapshotInput,
} from './production-cost-source-snapshot';
import { requestFingerprint } from '../idempotency/request-fingerprint';
import {
  fingerprintAllocationDenominator,
  fingerprintProductionOrderSealProof,
  type AllocationDenominator,
  type ProductionOrderSealProof,
} from './production-cost-calculator';

function input(): ProductionCostSourceSnapshotInput {
  return {
    basis: {
      rollDispatchItemId: 'roll-1',
      basisWeightGrams: 10_000,
      producedAt: new Date('2026-08-02T10:00:00Z'),
      closedAt: new Date('2026-08-02T18:00:00Z'),
    },
    eligibility: {
      canonicalCaptureId: 'capture-1',
      rootCaptureId: 'root-capture-1',
      rootPostSessionId: 'session-1',
      shiftId: 'shift-1',
      machineAssignmentId: 'assignment-1',
      dispatchCompletedAt: new Date('2026-08-02T17:00:00Z'),
      sessionEndedAt: new Date('2026-08-02T18:00:00Z'),
      shiftEndedAt: new Date('2026-08-02T18:00:00Z'),
    },
    material: {
      kind: 'recipe_reference',
      sources: [
        {
          kind: 'recipe_reference',
          sourceId: 'price-1',
          materialDefinitionId: 'material-1',
          label: 'ПНД',
          componentGrams: 10_000,
          shareBasisPoints: 10_000,
          priceKopecksPerKg: 2_000,
          effectiveAt: new Date('2026-08-01T00:00:00Z'),
          allocatedAmountKopecks: 20_000,
        },
      ],
    },
    spool: {
      sourceId: 'spool-price-1',
      spoolTypeKey: 'шпуля 76 мм',
      spoolTypeLabel: 'Шпуля 76 мм',
      widthMicrometers: 1_500_000,
      priceKopecksPerMeter: 6_000,
      effectiveAt: new Date('2026-08-01T00:00:00Z'),
      allocatedAmountKopecks: 9_000,
    },
    payroll: {
      tariffOrderId: 'payroll-order-1',
      tariffOrderName: 'Приказ № 1',
      effectiveFrom: new Date('2025-09-28T21:00:00Z'),
      rateKopecksPerKg: 400,
      basisLabel: 'базовая ставка',
      allocatedAmountKopecks: 4_000,
    },
    additional: [],
  };
}

describe('production cost source snapshot allowlist', () => {
  it('serializes only safe exact facts and stable ISO timestamps', () => {
    const result = buildProductionCostSourceSnapshot(input());

    expect(result).toMatchObject({
      basis: { rollDispatchItemId: 'roll-1', basisWeightGrams: 10_000 },
      eligibility: {
        canonicalCaptureId: 'capture-1',
        rootCaptureId: 'root-capture-1',
      },
      material: { kind: 'recipe_reference' },
    });
    expect(result.basis.producedAt).toBe('2026-08-02T10:00:00.000Z');
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:rawPayload|parsedPayload|deviceId|gatewayPayload|scanValue|printJob|weightPayload|password|secret|authToken)"\s*:/i,
    );
  });

  it('retains full measured and order allocation denominators in the fingerprint', () => {
    const materialDenominator: AllocationDenominator = {
      sealed: true,
      algorithmVersion: 'largest-remainder-v1',
      rows: [
        {
          rollDispatchItemId: 'roll-1',
          canonicalCaptureId: 'capture-1',
          weightGrams: 10_000,
          allocatedGrams: 10_000,
          allocatedAmountKopecks: 20_000,
        },
      ],
    };
    const orderDenominator: AllocationDenominator = {
      sealed: true,
      algorithmVersion: 'largest-remainder-v1',
      rows: [
        {
          rollDispatchItemId: 'roll-1',
          canonicalCaptureId: 'capture-1',
          weightGrams: 10_000,
          allocatedAmountKopecks: 300,
        },
      ],
    };
    const orderSealProof: ProductionOrderSealProof = {
      sealed: true,
      algorithmVersion: 'production-order-terminal-leaves-v1',
      productionOrderId: 'production-order-1',
      rows: [
        {
          rollDispatchItemId: 'roll-1',
          status: 'done',
          replacementAttemptId: null,
          canonicalCaptureId: 'capture-1',
          weightGrams: 10_000,
          hasDefect: false,
        },
        {
          rollDispatchItemId: 'defect-1',
          status: 'defect',
          replacementAttemptId: null,
          canonicalCaptureId: 'capture-defect-1',
          weightGrams: 1_000,
          hasDefect: true,
        },
      ],
    };
    const measured = input();
    measured.material = {
      kind: 'shift_bigbag_allocation',
      sources: [
        {
          kind: 'shift_bigbag_allocation',
          usageId: 'usage-1',
          bigBagId: 'bag-1',
          materialDefinitionId: null,
          label: 'BB-1 · ПНД',
          totalConsumedGrams: 10_000,
          totalAmountKopecks: 20_000,
          priceKopecksPerKg: 2_000,
          effectiveAt: new Date('2026-08-01T00:00:00Z'),
          denominator: materialDenominator,
          denominatorFingerprint: fingerprintAllocationDenominator(materialDenominator),
        },
      ],
    };
    measured.additional = [
      {
        kind: 'order_allocation',
        sourceId: 'order-cost-1',
        source: 'Акт',
        reason: 'Наладка',
        effectiveAt: new Date('2026-08-01T00:00:00Z'),
        rollDispatchItemId: 'roll-1',
        productionOrderId: 'production-order-1',
        totalAmountKopecks: 300,
        denominator: orderDenominator,
        denominatorFingerprint: fingerprintAllocationDenominator(orderDenominator),
        sealProof: orderSealProof,
        sealFingerprint: fingerprintProductionOrderSealProof(orderSealProof),
      },
    ];
    const baseline = buildProductionCostSourceSnapshot(measured);
    expect(baseline.material).toMatchObject({
      kind: 'shift_bigbag_allocation',
      sources: [
        expect.objectContaining({
          bigBagId: 'bag-1',
          totalConsumedGrams: 10_000,
          totalAmountKopecks: 20_000,
          denominator: expect.objectContaining({ rows: expect.any(Array) }),
        }),
      ],
    });
    expect(baseline.additional[0]).toMatchObject({
      kind: 'order_allocation',
      productionOrderId: 'production-order-1',
      sealProof: {
        rows: [
          expect.objectContaining({ rollDispatchItemId: 'defect-1', hasDefect: true }),
          expect.objectContaining({ rollDispatchItemId: 'roll-1', hasDefect: false }),
        ],
      },
    });

    const changed = input();
    const changedDenominator: AllocationDenominator = {
      ...materialDenominator,
      rows: [{ ...materialDenominator.rows[0], canonicalCaptureId: 'capture-2' }],
    };
    changed.material = {
      kind: 'shift_bigbag_allocation',
      sources: [
        {
          ...measured.material.sources[0],
          denominator: changedDenominator,
          denominatorFingerprint: fingerprintAllocationDenominator(changedDenominator),
        },
      ],
    };
    expect(requestFingerprint(buildProductionCostSourceSnapshot(changed))).not.toBe(
      requestFingerprint(baseline),
    );
  });

  it.each([
    ['raw payload', { rawPayload: { bytes: 'secret' } }],
    ['nested device', { nested: { deviceId: 'scale-1' } }],
    ['nested gateway', { nested: [{ gatewayPayload: 'raw' }] }],
    ['scan', { scanValue: 'qr' }],
    ['print', { printJob: 'job-1' }],
    ['weight payload', { weightPayload: { grams: 1 } }],
    ['secret token', { nested: { authToken: 'secret' } }],
    ['device prefix', { deviceCalibrationBlob: 'raw' }],
    ['gateway prefix', { gatewayTransportFrame: 'raw' }],
    ['access token prefix', { accessTokenHash: 'raw' }],
  ])('recursively rejects forbidden %s keys before persistence', (_label, forbidden) => {
    expect(() => buildProductionCostSourceSnapshot({ ...input(), ...forbidden } as never)).toThrow(
      /forbidden source snapshot key/i,
    );
  });

  it('keeps invalid measured usage identity in a stable version fingerprint', () => {
    const first = input();
    first.material = {
      kind: 'unresolved',
      reason: 'material_usage_unresolved',
      sources: [{ usageId: 'usage-a', bigBagId: 'bag-a', materialDefinitionId: null }],
      safeInputFingerprint: 'a'.repeat(64),
    };
    const retry = input();
    retry.material = {
      kind: 'unresolved',
      reason: 'material_usage_unresolved',
      sources: [{ usageId: 'usage-a', bigBagId: 'bag-a', materialDefinitionId: null }],
      safeInputFingerprint: 'a'.repeat(64),
    };
    const changed = input();
    changed.material = {
      kind: 'unresolved',
      reason: 'material_usage_unresolved',
      sources: [{ usageId: 'usage-b', bigBagId: 'bag-b', materialDefinitionId: null }],
      safeInputFingerprint: 'b'.repeat(64),
    };

    const firstSnapshot = buildProductionCostSourceSnapshot(first);
    expect(firstSnapshot.material).toEqual({
      kind: 'unresolved',
      reason: 'material_usage_unresolved',
      sources: [{ usageId: 'usage-a', bigBagId: 'bag-a', materialDefinitionId: null }],
      safeInputFingerprint: 'a'.repeat(64),
    });
    expect(requestFingerprint(buildProductionCostSourceSnapshot(retry))).toBe(
      requestFingerprint(firstSnapshot),
    );
    expect(requestFingerprint(buildProductionCostSourceSnapshot(changed))).not.toBe(
      requestFingerprint(firstSnapshot),
    );
  });

  it('keeps an unresolved order population version-visible without unsafe facts', () => {
    const source = input();
    source.additional = [
      {
        kind: 'unresolved',
        sourceId: 'order-cost-1',
        productionOrderId: 'production-order-1',
        source: 'Акт',
        reason: 'Наладка',
        effectiveAt: new Date('2026-08-01T00:00:00Z'),
        unresolvedReason: 'order_cost_allocation_unresolved',
        observedRollIds: ['roll-a'],
        safeInputFingerprint: 'c'.repeat(64),
      },
    ];

    expect(buildProductionCostSourceSnapshot(source).additional[0]).toEqual({
      kind: 'unresolved',
      sourceId: 'order-cost-1',
      productionOrderId: 'production-order-1',
      source: 'Акт',
      reason: 'Наладка',
      effectiveAt: '2026-08-01T00:00:00.000Z',
      unresolvedReason: 'order_cost_allocation_unresolved',
      observedRollIds: ['roll-a'],
      safeInputFingerprint: 'c'.repeat(64),
    });
  });

  it('rejects unsafe/nonfinite values and never returns caller object references', () => {
    const source = input();
    if (source.material.kind !== 'recipe_reference') throw new Error('recipe expected');
    source.material.sources[0].allocatedAmountKopecks = Number.MAX_SAFE_INTEGER + 1;
    expect(() => buildProductionCostSourceSnapshot(source)).toThrow(/safe integer/i);

    const clean = input();
    const built = buildProductionCostSourceSnapshot(clean);
    if (clean.material.kind !== 'recipe_reference') throw new Error('recipe expected');
    clean.material.sources[0].label = 'mutated';
    if (built.material.kind !== 'recipe_reference') throw new Error('recipe expected');
    expect(built.material.sources[0].label).toBe('ПНД');
  });
});
