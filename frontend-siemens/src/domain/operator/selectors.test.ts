import { describe, expect, it } from 'vitest';

import { applyDateScope } from '../../components/shell/DateScopeDropdown';
import type { LabelState } from '../types';
import { initialOperatorRuntime } from './fixtures';
import {
  canOperatorRecoverInvalidHandoverWeight,
  canOperatorReweigh,
  getOperatorSelectedObject,
  operatorActionsForOrder,
  operatorListItems,
  operatorRollHubRows,
  operatorShiftBlockerText,
  operatorShiftRecoveryText,
  operatorShiftSeverity,
  operatorShiftStatusLabel,
  operatorWorkbenchForOrder,
} from './selectors';

describe('operator shift without an active Big-Bag', () => {
  it('presents the explicit blocker and safe recovery path', () => {
    const shift = {
      ...initialOperatorRuntime.shift,
      status: 'bag_missing' as const,
    };

    expect(operatorShiftStatusLabel(shift.status)).toBe('Нужен Big-Bag');
    expect(operatorShiftSeverity(shift.status)).toBe('critical');
    expect(operatorShiftBlockerText(shift)).toBe('Нет активного Big-Bag');
    expect(operatorShiftRecoveryText(shift)).toBe(
      'Подключите следующий Big-Bag или сдайте смену',
    );
  });
});

describe('operatorListItems deferred date scope', () => {
  it('maps an ISO update timestamp into inclusive period filtering', () => {
    const lastEventAt = '2026-07-15T11:05:00+03:00';
    const runtime = {
      ...initialOperatorRuntime,
      orders: initialOperatorRuntime.orders.map((order) =>
        order.status === 'deferred' ? { ...order, lastEventAt } : order,
      ),
    };
    const items = operatorListItems(runtime, 'Все', 'Отложены');

    expect(items).toHaveLength(1);
    expect(items[0]?.lastEventAt).toBe(lastEventAt);
    expect(items[0]?.dateKey).toBe('2026-07-15');
    expect(applyDateScope(items, '2026-07-14..2026-07-15')).toEqual(items);
    expect(applyDateScope(items, '2026-07-13..2026-07-14')).toEqual([]);
  });

  it('keeps the demo time-only update timestamp undated', () => {
    const items = operatorListItems(initialOperatorRuntime, 'Все', 'Отложены');

    expect(items).toHaveLength(1);
    expect(items[0]?.lastEventAt).toBe('11:05');
    expect(items[0]?.dateKey).toBeUndefined();
  });
});

describe('operator physical label evidence', () => {
  it('uses the thin-spool standard without presenting a physical scale reading', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'spool_weight' as const,
      state: 'in_progress' as const,
      rolls: source.rolls.map((roll, index) =>
        index === 0
          ? {
              ...roll,
              status: 'принят',
              spoolWeightPolicy: 'standard_700g' as const,
              spoolScaleActivated: false,
              spoolKg: undefined,
            }
          : roll,
      ),
    };

    const workbench = operatorWorkbenchForOrder(order, {
      ...initialOperatorRuntime.shift,
      status: 'active',
    });
    const action = operatorActionsForOrder(order, {
      ...initialOperatorRuntime.shift,
      status: 'active',
    }).find((candidate) => candidate.id === 'operator-spool-weight');

    expect(workbench.stageSignal).toEqual(
      expect.objectContaining({
        kind: 'scale',
        value: '0,7 кг',
        facts: expect.arrayContaining([
          expect.objectContaining({ label: 'Источник', value: 'норма тонкой шпули' }),
        ]),
      }),
    );
    expect(action).toEqual(
      expect.objectContaining({
        label: 'Зафиксировать 0,7 кг',
        helpText: 'Для тонкой шпули применяется производственный норматив 0,7 кг.',
      }),
    );
  });

  it('keeps the operator step and roll metrics free from duplicated progress data', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'spool_weight' as const,
      state: 'in_progress' as const,
    };

    const workbench = operatorWorkbenchForOrder(order, {
      ...initialOperatorRuntime.shift,
      status: 'active',
    });

    expect(workbench.step).toBe('Зафиксируйте вес шпули');
    expect(workbench.metrics.map((metric) => metric.label)).toEqual(['План/допуск']);
  });

  it('shows transport submission as awaiting a real scan, not as a printed label', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'qr_check' as const,
      state: 'qr_check' as const,
      rolls: source.rolls.map((roll, index) => ({
        ...roll,
        labelState: index === 0 ? ('submitted' as const) : roll.labelState,
      })),
    };

    const workbench = operatorWorkbenchForOrder(order, {
      ...initialOperatorRuntime.shift,
      status: 'active',
    });
    const serialized = JSON.stringify(workbench);

    expect(workbench.labelLifecycle?.current).toBe('submitted');
    expect(workbench.labelLifecycle?.steps).toContainEqual(
      expect.objectContaining({ state: 'submitted', label: 'Задание отправлено' }),
    );
    expect(serialized).toContain('Ожидает фактический скан');
    expect(serialized).not.toContain('QR напечатан');
    expect(serialized).not.toContain('Напечатана');
  });

  it('does not expose a manual warehouse handover after QR verification', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'handover' as const,
      state: 'handover' as const,
    };

    expect(
      operatorActionsForOrder(order, { ...initialOperatorRuntime.shift, status: 'active' })
        .map((action) => action.id),
    ).not.toContain('operator-handover');
  });
});

describe('operator defect weighing visibility', () => {
  it('offers an explicit defect weighing action while the current roll awaits weight', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'roll_weight' as const,
      state: 'in_progress' as const,
    };

    expect(
      operatorActionsForOrder(order, {
        ...initialOperatorRuntime.shift,
        status: 'active',
      }).find((action) => action.id === 'operator-defect'),
    ).toEqual(
      expect.objectContaining({
        label: 'Взвесить брак',
        enabled: true,
        level: 'secondary',
      }),
    );
  });
});

describe('operator reweigh availability', () => {
  it.each(['qr_print', 'qr_check', 'handover'] as const)('blocks physical actions at %s while print delivery is unknown', (status) => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source, status,
      rolls: source.rolls.map((roll) => ({ ...roll, labelState: 'delivery_unknown' as LabelState })),
    };
    const shift = { ...initialOperatorRuntime.shift, status: 'active' as const };
    const actions = operatorActionsForOrder(order, shift);
    expect(actions.filter((action) => action.enabled).map((action) => action.id)).toEqual(['operator-problem']);
    const workbench = operatorWorkbenchForOrder(order, shift);
    expect(workbench.blockingReason).toBeTruthy();
    expect(workbench.stageSignal?.severity).toBe('critical');
    expect(workbench.labelLifecycle?.current).toBe('delivery_unknown');
    expect(workbench.step).toBe('Сверка печати');
    expect(operatorRollHubRows({ ...initialOperatorRuntime, shift, orders: [order] })[0]).toMatchObject({ blocker: 'Печать требует сверки', severity: 'critical' });
    expect(operatorListItems({ ...initialOperatorRuntime, shift, orders: [order] }, 'Заблокированы', 'Мои рулоны').length).toBeGreaterThan(0);
    expect(canOperatorReweigh(order)).toBe(false);
  });
  const weightedOrder = () => {
    const source = initialOperatorRuntime.orders[0];
    return {
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
    };
  };
  const activeShift = { ...initialOperatorRuntime.shift, status: 'active' as const };
  const invalidHandoverOrder = () => {
    const source = weightedOrder();
    return {
      ...source,
      status: 'handover' as const,
      state: 'handover' as const,
      rolls: source.rolls.map((roll, index) =>
        index === 0
          ? {
              ...roll,
              status: 'handover',
              spoolKg: 3.65,
              grossKg: 3.1,
              netKg: -0.55,
              actualNetKg: -0.55,
              toleranceState: 'blocked' as const,
              labelState: 'verified' as const,
              warehouseState: 'not_ready' as const,
            }
          : roll,
      ),
    };
  };

  it('enables reweigh only for the current weighted roll before print submission', () => {
    const order = weightedOrder();
    const action = operatorActionsForOrder(order, activeShift).find(
      (candidate) => candidate.id === 'operator-reweigh-roll',
    );

    expect(canOperatorReweigh(order)).toBe(true);
    expect(action).toEqual(expect.objectContaining({ enabled: true, level: 'secondary' }));
    expect(operatorWorkbenchForOrder(order, activeShift).rollProgress).toEqual({
      current: order.currentRoll,
      completed: order.completedRolls,
      total: order.plannedRolls,
    });
  });

  it.each<LabelState>([
    'print_requested',
    'submitted',
    'printed',
    'applied',
    'verified',
    'reprint_requested',
    'voided',
    'damaged_lookup_required',
  ])('does not expose reweigh after label state %s', (labelState) => {
    const source = weightedOrder();
    const order = {
      ...source,
      rolls: source.rolls.map((roll, index) => (index === 0 ? { ...roll, labelState } : roll)),
    };
    const action = operatorActionsForOrder(order, activeShift).find(
      (candidate) => candidate.id === 'operator-reweigh-roll',
    );
    const stepBackAction = operatorActionsForOrder(order, activeShift).find(
      (candidate) => candidate.id === 'operator-step-back-roll-weight',
    );

    expect(canOperatorReweigh(order)).toBe(false);
    expect(action?.enabled ?? false).toBe(false);
    expect(stepBackAction).toBeUndefined();
  });

  it.each(['qr_check', 'handover', 'warehouse'] as const)(
    'does not expose reweigh after terminal transition to %s',
    (status) => {
      const order = { ...weightedOrder(), status };
      const action = operatorActionsForOrder(order, activeShift).find(
        (candidate) => candidate.id === 'operator-reweigh-roll',
      );

      expect(canOperatorReweigh(order)).toBe(false);
      expect(action?.enabled ?? false).toBe(false);
    },
  );

  it('rejects an unweighted or non-current roll', () => {
    const unweighted = weightedOrder();
    unweighted.rolls[0] = {
      ...unweighted.rolls[0],
      grossKg: undefined,
      netKg: undefined,
      actualNetKg: undefined,
    };
    const wrongCurrentSource = weightedOrder();
    const wrongCurrent = {
      ...wrongCurrentSource,
      currentRoll: 2,
      rollProgress: { ...wrongCurrentSource.rollProgress, current: 2 },
    };
    const selectedNonCurrent = { ...weightedOrder(), currentRoll: 2 };

    expect(canOperatorReweigh(unweighted)).toBe(false);
    expect(canOperatorReweigh(wrongCurrent)).toBe(false);
    expect(canOperatorReweigh(selectedNonCurrent)).toBe(false);
  });

  it('offers Перевзвесить only for the invalid current handover roll', () => {
    const order = invalidHandoverOrder();
    const actions = operatorActionsForOrder(order, activeShift);

    expect(canOperatorRecoverInvalidHandoverWeight(order)).toBe(true);
    expect(actions).toContainEqual(
      expect.objectContaining({
        id: 'operator-reweigh-roll',
        label: 'Перевзвесить',
        level: 'recommended',
        enabled: true,
      }),
    );
    expect(actions.map((action) => action.id)).not.toContain('operator-verify-qr');
  });

  it('does not offer handover recovery for a positive canonical weight', () => {
    const source = invalidHandoverOrder();
    const order = {
      ...source,
      rolls: source.rolls.map((roll, index) =>
        index === 0 ? { ...roll, grossKg: 6.65, netKg: 3, actualNetKg: 3 } : roll,
      ),
    };

    expect(canOperatorRecoverInvalidHandoverWeight(order)).toBe(false);
    expect(
      operatorActionsForOrder(order, activeShift).some(
        (action) => action.id === 'operator-reweigh-roll',
      ),
    ).toBe(false);
  });

  it.each([
    ['unverified QR', { labelState: 'submitted' as const }],
    ['non-canonical pre-handover projection', { warehouseState: 'ready_for_handover' as const }],
    ['warehouse ownership', { warehouseState: 'sent' as const }],
    ['non-finite mass', { netKg: Number.NaN, actualNetKg: Number.NaN }],
  ])('does not offer invalid-weight recovery after %s', (_case, rollPatch) => {
    const source = invalidHandoverOrder();
    const order = {
      ...source,
      rolls: source.rolls.map((roll, index) =>
        index === 0 ? { ...roll, ...rollPatch } : roll,
      ),
    };

    expect(canOperatorRecoverInvalidHandoverWeight(order)).toBe(false);
    expect(
      operatorActionsForOrder(order, activeShift).some(
        (action) => action.id === 'operator-reweigh-roll',
      ),
    ).toBe(false);
  });
});

describe('operator previous-step recovery', () => {
  const activeShift = { ...initialOperatorRuntime.shift, status: 'active' as const };

  it('offers a contextual return to spool weighing while awaiting the roll weight', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
      ...source,
      status: 'roll_weight' as const,
      state: 'in_progress' as const,
    };

    expect(
      operatorActionsForOrder(order, activeShift).find(
        (action) => action.id === 'operator-step-back-spool-weight',
      ),
    ).toEqual(
      expect.objectContaining({
        label: 'Назад к весу шпули',
        level: 'secondary',
        enabled: true,
        confirmation:
          'Вернуться к весу шпули? Зафиксированный вес шпули останется в истории. Шпулю нужно взвесить заново.',
      }),
    );
  });

  it('offers a contextual return to roll weighing before QR print', () => {
    const source = initialOperatorRuntime.orders[0];
    const order = {
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
              labelState: 'not_printed' as const,
            }
          : roll,
      ),
    };

    expect(
      operatorActionsForOrder(order, activeShift).find(
        (action) => action.id === 'operator-step-back-roll-weight',
      ),
    ).toEqual(
      expect.objectContaining({
        label: 'Назад к весу рулона',
        level: 'secondary',
        enabled: true,
        confirmation:
          'Вернуться к весу рулона? Зафиксированный вес рулона останется в истории. Рулон нужно взвесить заново.',
      }),
    );
  });

  it.each(['assigned', 'spool_weight', 'qr_check', 'handover', 'warehouse'] as const)(
    'does not expose a previous-step action at %s',
    (status) => {
      const source = initialOperatorRuntime.orders[0];
      const order = { ...source, status };

      expect(
        operatorActionsForOrder(order, activeShift).some((action) =>
          action.id.startsWith('operator-step-back-'),
        ),
      ).toBe(false);
    },
  );
});

describe('operator canonical roll selection', () => {
  it('opens a selected row without rewriting canonical rollProgress', () => {
    const sourceOrder = initialOperatorRuntime.orders[0];
    const selectedRoll = sourceOrder.rolls[1];

    const object = getOperatorSelectedObject(initialOperatorRuntime, selectedRoll.id);

    expect(object?.workbench?.type).toBe('operator');
    if (object?.workbench?.type !== 'operator') return;
    expect(object.workbench.currentRoll?.id).toBe(selectedRoll.id);
    expect(object.workbench.rollProgress.current).toBe(sourceOrder.rollProgress.current);
  });

  it('projects the selected roll step instead of the server-current roll step', () => {
    const sourceOrder = initialOperatorRuntime.orders[0];
    const serverCurrentRoll = {
      ...sourceOrder.rolls[0],
      status: 'handover',
      labelState: 'verified' as const,
      warehouseState: 'ready_for_handover' as const,
    };
    const selectedRoll = {
      ...sourceOrder.rolls[1],
      status: 'assigned',
    };
    const runtime = {
      ...initialOperatorRuntime,
      orders: [
        {
          ...sourceOrder,
          status: 'handover' as const,
          currentRoll: serverCurrentRoll.sequenceNumber,
          currentDispatchItemId: serverCurrentRoll.dispatchItemId,
          rolls: [serverCurrentRoll, selectedRoll],
        },
      ],
    };

    const object = getOperatorSelectedObject(runtime, selectedRoll.id);

    expect(object?.workbench?.type).toBe('operator');
    if (object?.workbench?.type !== 'operator') return;
    expect(object.workbench.currentRoll?.id).toBe(selectedRoll.id);
    expect(object.workbench.step).toBe('Примите заказ');
    expect(object.actions.find((action) => action.level === 'recommended')?.id).toBe(
      'operator-accept-order',
    );
  });
});
