import { describe, expect, it } from 'vitest';

import type { ProductionShift } from '../api/production';
import {
  currentAssignmentByOperator,
  currentProductionAssignments,
  productionShiftCapacity,
} from './operators';

describe('productionShiftCapacity', () => {
  it('does not invent a 480-minute capacity for time-free individual shifts', () => {
    expect(productionShiftCapacity(null, null)).toEqual({
      capacityKnown: false,
      shiftCapacityMinutes: 0,
      remainingShiftMinutes: 0,
    });
  });
});

describe('currentAssignmentByOperator', () => {
  it('projects operator assignments from every planned or open shift', () => {
    const plannedShift: ProductionShift = {
      id: 'shift-planned',
      label: 'Подготовленная смена',
      plannedStartAt: null,
      plannedEndAt: null,
      status: 'planned',
      machineAssignments: [
        {
          id: 'assignment-planned',
          shiftId: 'shift-planned',
          operatorId: 'operator-1',
          postId: 'post-1',
          status: 'planned',
        },
      ],
    };
    const openShift: ProductionShift = {
      id: 'shift-open',
      label: 'Открытая смена',
      plannedStartAt: null,
      plannedEndAt: null,
      status: 'open',
      machineAssignments: [
        {
          id: 'assignment-open',
          shiftId: 'shift-open',
          operatorId: 'operator-2',
          postId: 'post-2',
          status: 'locked',
        },
      ],
    };
    const closedShift: ProductionShift = {
      id: 'shift-closed',
      label: 'Закрытая смена',
      plannedStartAt: null,
      plannedEndAt: null,
      status: 'closed',
      machineAssignments: [
        {
          id: 'assignment-closed',
          shiftId: 'shift-closed',
          operatorId: 'operator-3',
          postId: 'post-3',
          status: 'completed',
        },
      ],
    };

    const assignments = currentAssignmentByOperator([plannedShift, closedShift, openShift]);

    expect(assignments.get('operator-1')).toEqual({
      state: 'assigned',
      shift: plannedShift,
      assignment: plannedShift.machineAssignments?.[0],
    });
    expect(assignments.get('operator-2')).toEqual({
      state: 'assigned',
      shift: openShift,
      assignment: openShift.machineAssignments?.[0],
    });
    expect(assignments.has('operator-3')).toBe(false);
  });

  it('returns an explicit conflict without choosing arbitrary topology', () => {
    const assignments = currentAssignmentByOperator([
      {
        id: 'shift-b',
        label: 'Смена B',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'open',
        machineAssignments: [
          {
            id: 'assignment-b',
            shiftId: 'shift-b',
            operatorId: 'operator-1',
            postId: 'post-b',
            status: 'locked',
          },
        ],
      },
      {
        id: 'shift-a',
        label: 'Смена A',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'planned',
        machineAssignments: [
          {
            id: 'assignment-a',
            shiftId: 'shift-a',
            operatorId: 'operator-1',
            postId: 'post-a',
            status: 'planned',
          },
        ],
      },
    ]);

    expect(assignments.get('operator-1')).toEqual({
      state: 'conflict',
      shiftIds: ['shift-a', 'shift-b'],
    });
    expect(assignments.get('operator-1')).not.toHaveProperty('shift');
    expect(assignments.get('operator-1')).not.toHaveProperty('assignment');
  });
});

describe('currentProductionAssignments', () => {
  it('keeps only planned, locked, and breakdown-reassigned assignments in current shifts', () => {
    const assignments = currentProductionAssignments([
      {
        id: 'shift-planned',
        label: 'Плановая смена',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'planned',
        machineAssignments: [
          {
            id: 'assignment-planned',
            shiftId: 'shift-planned',
            operatorId: 'operator-planned',
            postId: 'post-planned',
            status: 'planned',
          },
        ],
      },
      {
        id: 'shift-open',
        label: 'Открытая смена',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'open',
        machineAssignments: [
          {
            id: 'assignment-locked',
            shiftId: 'shift-open',
            operatorId: 'operator-locked',
            postId: 'post-locked',
            status: 'locked',
          },
          {
            id: 'assignment-reassigned',
            shiftId: 'shift-open',
            operatorId: 'operator-reassigned',
            postId: 'post-reassigned',
            status: 'breakdown_reassigned',
          },
          {
            id: 'assignment-completed',
            shiftId: 'shift-open',
            operatorId: 'operator-completed',
            postId: 'post-completed',
            status: 'completed',
          },
        ],
      },
      {
        id: 'shift-closed',
        label: 'Закрытая смена',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'closed',
        machineAssignments: [
          {
            id: 'assignment-closed',
            shiftId: 'shift-closed',
            operatorId: 'operator-closed',
            postId: 'post-closed',
            status: 'locked',
          },
        ],
      },
    ]);

    expect(assignments.map(({ assignment }) => assignment.id)).toEqual([
      'assignment-planned',
      'assignment-locked',
      'assignment-reassigned',
    ]);
  });
});
