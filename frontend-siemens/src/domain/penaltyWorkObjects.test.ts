import { describe, expect, it } from 'vitest';

import type { ProductionRollDispatchItem } from './types';
import {
  buildPenaltyWorkCatalog,
  isPenaltyWorkLinkValid,
  resetPenaltyRollOnOrderChange,
  resetPenaltyWorkLinkOnEmployeeChange,
} from './penaltyWorkObjects';

function roll(
  value: Pick<
    ProductionRollDispatchItem,
    'operatorId' | 'productionOrderId' | 'orderNumber' | 'rollId'
  >,
) {
  return value as ProductionRollDispatchItem;
}

describe('penalty work-object catalog', () => {
  it('groups only each operator’s real rolls under their production orders', () => {
    const catalog = buildPenaltyWorkCatalog([
      roll({
        operatorId: 'op-1',
        productionOrderId: 'po-1',
        orderNumber: 'A-501',
        rollId: 'A-501-roll-2',
      }),
      roll({
        operatorId: 'op-1',
        productionOrderId: 'po-1',
        orderNumber: 'A-501',
        rollId: 'A-501-roll-1',
      }),
      roll({
        operatorId: 'op-2',
        productionOrderId: 'po-2',
        orderNumber: 'B-100',
        rollId: 'B-100-roll-1',
      }),
    ]);

    expect(catalog['op-1']).toEqual([
      {
        productionOrderId: 'po-1',
        orderNumber: 'A-501',
        rollCodes: ['A-501-roll-1', 'A-501-roll-2'],
      },
    ]);
    expect(catalog['op-2']).toEqual([
      {
        productionOrderId: 'po-2',
        orderNumber: 'B-100',
        rollCodes: ['B-100-roll-1'],
      },
    ]);
  });

  it('deduplicates repeated roll projections', () => {
    const sameRoll = roll({
      operatorId: 'op-1',
      productionOrderId: 'po-1',
      orderNumber: 'A-501',
      rollId: 'A-501-roll-1',
    });

    expect(buildPenaltyWorkCatalog([sameRoll, sameRoll])['op-1']?.[0].rollCodes).toEqual([
      'A-501-roll-1',
    ]);
  });

  it('clears order and roll when the employee changes', () => {
    expect(
      resetPenaltyWorkLinkOnEmployeeChange(
        {
          employeeId: 'op-1',
          productionOrderId: 'po-1',
          rollCode: 'A-501-roll-1',
          reason: 'Недовес',
        },
        'op-2',
      ),
    ).toEqual({
      employeeId: 'op-2',
      productionOrderId: '',
      rollCode: '',
      reason: 'Недовес',
    });
  });

  it('clears only the roll when the order changes', () => {
    expect(
      resetPenaltyRollOnOrderChange(
        {
          employeeId: 'op-1',
          productionOrderId: 'po-1',
          rollCode: 'A-501-roll-1',
          reason: 'Недовес',
        },
        'po-2',
      ),
    ).toEqual({
      employeeId: 'op-1',
      productionOrderId: 'po-2',
      rollCode: '',
      reason: 'Недовес',
    });
  });

  it('invalidates a stale order or roll after the assignment catalog refreshes', () => {
    const orders = [
      {
        productionOrderId: 'po-1',
        orderNumber: 'A-501',
        rollCodes: ['A-501-roll-2'],
      },
    ];

    expect(isPenaltyWorkLinkValid(orders, 'po-1', '')).toBe(true);
    expect(isPenaltyWorkLinkValid(orders, 'po-1', 'A-501-roll-2')).toBe(true);
    expect(isPenaltyWorkLinkValid(orders, 'po-missing', '')).toBe(false);
    expect(isPenaltyWorkLinkValid(orders, 'po-1', 'A-501-roll-1')).toBe(false);
  });
});
