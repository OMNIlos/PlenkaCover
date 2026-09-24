export const OPERATOR_REPORTABLE_PROBLEM_TYPES = ['general', 'raw_material_shortage'] as const;

export type OperatorReportableProblemType = (typeof OPERATOR_REPORTABLE_PROBLEM_TYPES)[number];

export const OPERATOR_REPORTABLE_PROBLEM_TYPE_LABELS = {
  general: 'Общая проблема',
  raw_material_shortage: 'Нехватка сырья',
} as const satisfies Record<OperatorReportableProblemType, string>;

export const OPERATOR_REPORTABLE_PROBLEM_ROUTING = {
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
} as const satisfies Record<
  OperatorReportableProblemType,
  {
    ownerLabel: string;
    targetRole: 'commercial' | 'production';
    recovery: string;
  }
>;

export function isOperatorReportableProblemType(
  value: unknown,
): value is OperatorReportableProblemType {
  return OPERATOR_REPORTABLE_PROBLEM_TYPES.includes(value as OperatorReportableProblemType);
}
