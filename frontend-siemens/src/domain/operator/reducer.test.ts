import { afterEach, describe, expect, it, vi } from 'vitest';

import { initialOperatorRuntime } from './fixtures';
import {
  applyOperatorReweighResult,
  applyOperatorStepBackResult,
  reconcileOperatorRuntimeRefresh,
  reduceOperatorRuntime,
} from './reducer';

afterEach(() => {
  vi.useRealTimers();
});

function runtimeAtPrePrint() {
  const source = initialOperatorRuntime.orders[0];
  return {
    ...initialOperatorRuntime,
    orders: initialOperatorRuntime.orders.map((order) =>
      order.id === source.id
        ? {
            ...source,
            status: 'qr_print' as const,
            state: 'in_progress' as const,
            rolls: source.rolls.map((roll, index) =>
              index === 0
                ? {
                    ...roll,
                    status: 'вес зафиксирован',
                    grossKg: 43,
                    netKg: 41.2,
                    actualNetKg: 41.2,
                    toleranceState: 'within' as const,
                    labelState: 'not_printed' as const,
                  }
                : roll,
            ),
          }
        : order,
    ),
  };
}

describe('operator roll reweigh reducer', () => {
  it('handles the demo action without advancing the stage or label lifecycle', () => {
    const runtime = runtimeAtPrePrint();
    const before = runtime.orders[0];

    const next = reduceOperatorRuntime(runtime, before.rolls[0].id, 'operator-reweigh-roll');
    const order = next.orders[0];

    expect(order.status).toBe('qr_print');
    expect(order.rolls[0]?.labelState).toBe('not_printed');
    expect(order.rolls[0]?.netKg).toBe(41.2);
    expect(next.audit[before.id]?.[0]).toEqual(
      expect.objectContaining({
        actionLabel: 'перевзвешивание рулона запрошено',
      }),
    );
  });

  it('moves the scanned demo roll directly to warehouse without a handover action', () => {
    const source = initialOperatorRuntime.orders[0];
    const runtime = {
      ...initialOperatorRuntime,
      orders: initialOperatorRuntime.orders.map((order) =>
        order.id === source.id
          ? {
              ...source,
              status: 'qr_check' as const,
              state: 'qr_check' as const,
              rolls: source.rolls.map((roll, index) =>
                index === 0 ? { ...roll, labelState: 'submitted' as const } : roll,
              ),
            }
          : order,
      ),
    };

    const next = reduceOperatorRuntime(
      runtime,
      source.rolls[0].id,
      'operator-verify-qr',
    );
    const order = next.orders[0];

    expect(order.status).not.toBe('handover');
    expect(order.rolls[0]).toEqual(
      expect.objectContaining({ labelState: 'verified', warehouseState: 'sent' }),
    );
  });

  it('patches the confirmed response without mutating the prior snapshot or label state', () => {
    const runtime = runtimeAtPrePrint();
    const before = runtime.orders[0].rolls[0];

    const next = applyOperatorReweighResult(runtime, {
      rollCode: before.id,
      step: 'qr_print',
      previousWeight: { grossKg: 43, netKg: 41.2, toleranceOk: true },
      currentWeight: { grossKg: 42.9, netKg: 41.1, toleranceOk: false },
    });
    const patched = next.orders[0].rolls[0];

    expect(patched).toEqual(
      expect.objectContaining({
        grossKg: 42.9,
        netKg: 41.1,
        actualNetKg: 41.1,
        toleranceState: 'blocked',
        labelState: 'not_printed',
      }),
    );
    expect(next.orders[0].status).toBe('qr_print');
    expect(before).toEqual(expect.objectContaining({ grossKg: 43, netKg: 41.2 }));
  });

  it('maps an unevaluated backend tolerance to pending', () => {
    const runtime = runtimeAtPrePrint();
    const rollCode = runtime.orders[0].rolls[0].id;

    const next = applyOperatorReweighResult(runtime, {
      rollCode,
      step: 'qr_print',
      previousWeight: { grossKg: 43, netKg: 41.2, toleranceOk: true },
      currentWeight: { grossKg: 42.9, netKg: 41.1, toleranceOk: null },
    });

    expect(next.orders[0].rolls[0].toleranceState).toBe('pending');
  });

  it('patches recovered handover weight without resetting QR or warehouse state', () => {
    const source = runtimeAtPrePrint();
    const runtime = {
      ...source,
      orders: source.orders.map((order, orderIndex) =>
        orderIndex === 0
          ? {
              ...order,
              status: 'handover' as const,
              state: 'handover' as const,
              rolls: order.rolls.map((roll, rollIndex) =>
                rollIndex === 0
                  ? {
                      ...roll,
                      status: 'handover',
                      grossKg: 3.1,
                      spoolKg: 3.65,
                      netKg: -0.55,
                      actualNetKg: -0.55,
                      toleranceState: 'blocked' as const,
                      labelState: 'verified' as const,
                      warehouseState: 'not_ready' as const,
                      updatedAt: '2026-08-13T11:00:00.000Z',
                    }
                  : roll,
              ),
            }
          : order,
      ),
    };
    const rollCode = runtime.orders[0].rolls[0].id;

    vi.useFakeTimers();
    vi.setSystemTime('2026-08-13T12:00:00.000Z');
    const next = applyOperatorReweighResult(runtime, {
      rollCode,
      step: 'handover',
      previousWeight: { grossKg: 3.1, netKg: -0.55, toleranceOk: false },
      currentWeight: { grossKg: 6.65, netKg: 3, toleranceOk: false },
    });
    const order = next.orders[0];

    expect(order.status).toBe('handover');
    expect(order.rolls[0]).toEqual(
      expect.objectContaining({
        grossKg: 6.65,
        netKg: 3,
        actualNetKg: 3,
        toleranceState: 'blocked',
        labelState: 'verified',
        warehouseState: 'not_ready',
        updatedAt: '2026-08-13T12:00:00.000Z',
      }),
    );
  });

  it('does not rewrite canonical progress when an old row is selected', () => {
    const runtime = runtimeAtPrePrint();
    const order = runtime.orders[0];
    const selectedOldRow = order.rolls[1];

    const next = reduceOperatorRuntime(runtime, selectedOldRow.id, 'operator-reweigh-roll');

    expect(next.orders[0].rollProgress).toEqual(order.rollProgress);
  });
});

describe('operator roll step-back projection', () => {
  it('reopens roll weighing and clears only the current roll weight projection', () => {
    const runtime = runtimeAtPrePrint();
    const rollCode = runtime.orders[0].rolls[0].id;

    const next = applyOperatorStepBackResult(runtime, {
      rollCode,
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
    const order = next.orders[0];

    expect(order.status).toBe('roll_weight');
    expect(order.rollNetKg).toBeUndefined();
    expect(order.rolls[0]).toEqual(
      expect.objectContaining({
        status: 'roll_weight',
        spoolScaleActivated: false,
        rollScaleActivated: true,
        toleranceState: 'pending',
        labelState: 'not_printed',
      }),
    );
    expect(order.rolls[0]?.spoolKg).toBe(runtime.orders[0].rolls[0]?.spoolKg);
    expect(order.rolls[0]?.grossKg).toBeUndefined();
    expect(order.rolls[0]?.netKg).toBeUndefined();
    expect(order.rolls[0]?.actualNetKg).toBeUndefined();
  });

  it('reopens spool weighing and clears both current weight projections', () => {
    const prePrint = runtimeAtPrePrint();
    const order = prePrint.orders[0];
    const runtime = {
      ...prePrint,
      orders: prePrint.orders.map((candidate) =>
        candidate.id === order.id
          ? {
              ...candidate,
              status: 'roll_weight' as const,
              spoolKg: 1.8,
              rolls: candidate.rolls.map((roll, index) =>
                index === 0 ? { ...roll, spoolKg: 1.8 } : roll,
              ),
            }
          : candidate,
      ),
    };

    const next = applyOperatorStepBackResult(runtime, {
      rollCode: order.rolls[0].id,
      previousStep: 'roll_weight',
      step: 'spool_weight',
    });
    const reopened = next.orders[0];

    expect(reopened.status).toBe('spool_weight');
    expect(reopened.spoolKg).toBeUndefined();
    expect(reopened.rolls[0]).toEqual(
      expect.objectContaining({
        status: 'spool_weight',
        spoolScaleActivated: true,
        rollScaleActivated: false,
        toleranceState: 'pending',
      }),
    );
    expect(reopened.rolls[0]?.spoolKg).toBeUndefined();
    expect(reopened.rolls[0]?.grossKg).toBeUndefined();
    expect(reopened.rolls[0]?.netKg).toBeUndefined();
  });
});

describe('operator shift close refresh', () => {
  it('closes a zero-defect shift without a QR print action', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'close_pending' as const },
    };
    const selected = runtime.orders[0].id;
    const weighed = reduceOperatorRuntime(runtime, selected, 'operator-weigh-defect-bag:none:0');
    const printAttempt = reduceOperatorRuntime(weighed, selected, 'operator-print-defect-bag');
    const closed = reduceOperatorRuntime(printAttempt, selected, 'operator-close-shift');

    expect(weighed.shift.defectBag).toMatchObject({
      weightKg: 0, defectType: null, status: 'weighed', labelState: 'not_printed',
    });
    expect(printAttempt).toBe(weighed);
    expect(closed.shift.status).toBe('closed');
  });

  it('keeps close blocked until the defect bag is weighed and its QR is printed', () => {
    const runtime = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'close_pending' as const },
    };
    const selection = runtime.orders[0].id;

    const blocked = reduceOperatorRuntime(runtime, selection, 'operator-close-shift');
    const weighed = reduceOperatorRuntime(
      blocked,
      selection,
      'operator-weigh-defect-bag:secondary:12.4',
    );
    const ready = reduceOperatorRuntime(weighed, selection, 'operator-print-defect-bag');
    const closed = reduceOperatorRuntime(ready, selection, 'operator-close-shift');

    expect(blocked.shift.status).toBe('close_pending');
    expect(weighed.shift.defectBag).toEqual(
      expect.objectContaining({
        status: 'weighed',
        defectType: 'secondary',
        weightKg: 12.4,
        labelState: 'not_printed',
      }),
    );
    expect(ready.shift.defectBag).toEqual(
      expect.objectContaining({ status: 'ready_for_warehouse', labelState: 'submitted' }),
    );
    expect(closed.shift.status).toBe('closed');
  });

  it('cancels final weighing back to an active shift without dropping tracked-bag facts', () => {
    const activeBag = {
      bagId: 'bag-1',
      code: 'BB-1',
      material: 'ПВД',
      materialId: 'material-1',
      warehouseKg: 500,
      startKg: 480,
      endKg: null,
      addedReason: null,
      releasedReason: null,
      active: true,
      releasedAt: null,
      sequence: 1,
    };
    const current = {
      ...initialOperatorRuntime,
      balanceProblemOrderId: initialOperatorRuntime.orders[0].id,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [activeBag],
        endKg: 417.2,
        actualUsageKg: 62.8,
        deviationPercent: 3,
        enteredBy: 'Оператор закрытия',
        enteredAt: '19:55',
      },
    };

    const next = reduceOperatorRuntime(
      current,
      current.shift.id,
      'operator-close-shift-cancel',
    );

    expect(next.shift.status).toBe('active');
    expect(next.shift.startKg).toBe(current.shift.startKg);
    expect(next.shift.bags).toEqual([activeBag]);
    expect(next.shift.endKg).toBe(current.shift.endKg);
    expect(next.shift.actualUsageKg).toBe(current.shift.actualUsageKg);
    expect(next.shift.deviationPercent).toBe(current.shift.deviationPercent);
    expect(next.shift.enteredBy).toBe(current.shift.enteredBy);
    expect(next.shift.enteredAt).toBe(current.shift.enteredAt);
    expect(next.balanceProblemOrderId).toBe(current.balanceProblemOrderId);
    expect(next.audit).toBe(current.audit);
  });

  it('cancels final weighing to a missing-bag state when tracked bags are all inactive', () => {
    const inactiveBag = {
      bagId: 'bag-1',
      code: 'BB-1',
      material: 'ПВД',
      materialId: 'material-1',
      warehouseKg: 500,
      startKg: 480,
      endKg: 0,
      addedReason: null,
      releasedReason: null,
      active: false,
      releasedAt: '2026-08-09T19:55:00.000Z',
      sequence: 1,
    };
    const current = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [inactiveBag],
        endKg: 0,
        actualUsageKg: initialOperatorRuntime.shift.startKg,
        deviationPercent: 0,
      },
    };

    const next = reduceOperatorRuntime(
      current,
      current.shift.id,
      'operator-close-shift-cancel',
    );

    expect(next.shift.status).toBe('bag_missing');
    expect(next.shift.endKg).toBe(current.shift.endKg);
    expect(next.shift.actualUsageKg).toBe(current.shift.actualUsageKg);
    expect(next.shift.deviationPercent).toBe(current.shift.deviationPercent);
  });

  it('clears locally entered closing facts when legacy tracked bags are absent', () => {
    const withoutTrackedBags = {
      ...initialOperatorRuntime,
      balanceProblemOrderId: initialOperatorRuntime.orders[0].id,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        endKg: 417.2,
        actualUsageKg: 62.8,
        deviationPercent: 3,
        enteredBy: 'Оператор смены',
        enteredAt: '08:00',
      },
    };

    const next = reduceOperatorRuntime(
      withoutTrackedBags,
      withoutTrackedBags.shift.id,
      'operator-close-shift-cancel',
    );

    expect(next.shift.status).toBe('active');
    expect(next.shift).not.toHaveProperty('endKg');
    expect(next.shift).not.toHaveProperty('actualUsageKg');
    expect(next.shift).not.toHaveProperty('deviationPercent');
    expect(next.shift.enteredBy).toBe(withoutTrackedBags.shift.enteredBy);
    expect(next.shift.enteredAt).toBe(withoutTrackedBags.shift.enteredAt);
    expect(next.balanceProblemOrderId).toBeUndefined();
  });

  it('treats an explicitly tracked empty bag list as active and preserves server facts', () => {
    const current = {
      ...initialOperatorRuntime,
      balanceProblemOrderId: initialOperatorRuntime.orders[0].id,
      shift: {
        ...initialOperatorRuntime.shift,
        status: 'close_pending' as const,
        bags: [],
        endKg: 417.2,
        actualUsageKg: 62.8,
        deviationPercent: 3,
      },
    };

    const next = reduceOperatorRuntime(
      current,
      current.shift.id,
      'operator-close-shift-cancel',
    );

    expect(next.shift.status).toBe('active');
    expect(next.shift.endKg).toBe(current.shift.endKg);
    expect(next.shift.actualUsageKg).toBe(current.shift.actualUsageKg);
    expect(next.shift.deviationPercent).toBe(current.shift.deviationPercent);
    expect(next.balanceProblemOrderId).toBe(current.balanceProblemOrderId);
  });

  it('does not cancel a shift that is already closed', () => {
    const current = {
      ...initialOperatorRuntime,
      shift: { ...initialOperatorRuntime.shift, status: 'closed' as const },
    };

    expect(
      reduceOperatorRuntime(current, current.shift.id, 'operator-close-shift-cancel'),
    ).toBe(current);
  });

  it('keeps the final Big-bag step open while the same active shift is refreshed', () => {
    const current = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'close_pending' as const,
      },
    };
    const incoming = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'active' as const,
        plannedUsageKg: 125,
      },
      orders: initialOperatorRuntime.orders.slice(0, 1),
    };

    const reconciled = reconcileOperatorRuntimeRefresh(current, incoming);

    expect(reconciled.shift.status).toBe('close_pending');
    expect(reconciled.shift.plannedUsageKg).toBe(125);
    expect(reconciled.orders).toHaveLength(1);
  });

  it('keeps the cancel step open when the matching server shift reports a missing bag', () => {
    const current = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'close_pending' as const,
      },
    };
    const incoming = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'bag_missing' as const,
      },
    };

    expect(reconcileOperatorRuntimeRefresh(current, incoming).shift.status).toBe('close_pending');
  });

  it('accepts a closed server state and does not preserve the local close step', () => {
    const current = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'close_pending' as const,
      },
    };
    const incoming = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'closed' as const,
      },
    };

    expect(reconcileOperatorRuntimeRefresh(current, incoming).shift.status).toBe('closed');
  });

  it('does not carry the close step into another shift', () => {
    const current = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-1',
        status: 'close_pending' as const,
      },
    };
    const incoming = {
      ...initialOperatorRuntime,
      shift: {
        ...initialOperatorRuntime.shift,
        id: 'shift-2',
        status: 'active' as const,
      },
    };

    expect(reconcileOperatorRuntimeRefresh(current, incoming).shift.status).toBe('active');
  });
});
