import { describe, expect, it } from 'vitest';

import {
  isOperatorReportableProblemType,
  OPERATOR_REPORTABLE_PROBLEM_ROUTING,
  OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS,
  OPERATOR_REPORTABLE_PROBLEM_TYPES,
} from './operatorProblem';

describe('operator reportable problem contract', () => {
  it('exposes only the two routed user-reported problem types with exhaustive Russian labels', () => {
    expect(OPERATOR_REPORTABLE_PROBLEM_TYPES).toEqual(['general', 'raw_material_shortage']);
    expect(OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS).toEqual({
      general: 'Общая проблема',
      raw_material_shortage: 'Нехватка сырья',
    });
    expect(OPERATOR_REPORTABLE_PROBLEM_ROUTING).toEqual({
      general: {
        ownerLabel: 'Зав. производства',
        targetRole: 'production',
        recovery: 'Зав. производства решает следующий шаг',
      },
      raw_material_shortage: {
        ownerLabel: 'Коммерция',
        targetRole: 'commercial',
        recovery: 'Коммерция применяет корректировку сырья',
      },
    });
  });

  it.each([
    'defect',
    'shift_balance_mismatch',
    'machine_breakdown',
    'device_failure',
    'physical_incident',
    '',
  ])('rejects the system or dedicated problem type %s', (value) => {
    expect(isOperatorReportableProblemType(value)).toBe(false);
  });
});
