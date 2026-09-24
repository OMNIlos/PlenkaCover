import { describe, expect, it } from 'vitest';

import type { PenaltyRuntime } from './types';
import { buildPenaltyAnalyticsProjection } from './penaltyAnalytics';

function penalty(overrides: Partial<PenaltyRuntime> = {}): PenaltyRuntime {
  return {
    penaltyId: 'penalty-1',
    employeeId: 'unknown-employee',
    employeeName: 'Сотрудник не найден',
    employeeRole: 'Оператор',
    targetRole: 'operator',
    scopeObjectId: 'без связанного объекта',
    reason: 'Брак',
    amountLabel: '10 ₽',
    author: 'Директор',
    status: 'notified',
    createdAt: '2026-08-08T08:00:00.000Z',
    history: [],
    ...overrides,
  };
}

describe('legacy penalty analytics projection', () => {
  it('does not invent demo operators for an empty backend set', () => {
    expect(buildPenaltyAnalyticsProjection([]).operatorStats).toEqual([]);
  });

  it('keeps an unknown persisted employee instead of joining demo operators', () => {
    expect(buildPenaltyAnalyticsProjection([penalty()]).operatorStats).toEqual([
      expect.objectContaining({
        operatorId: 'unknown-employee',
        operatorName: 'Сотрудник не найден',
        totalCount: 1,
      }),
    ]);
  });
});
