import type { AppliedPayrollTariffOrder } from './payroll-tariff-orders';

export const DIRECTOR_PAYROLL_TIMEZONE = 'Europe/Moscow' as const;
export const DIRECTOR_PAYROLL_MACHINE_FAMILIES = [
  'urp',
  'matil',
  'kitayka',
  'abc_old',
  'abc_new',
] as const;
export const DIRECTOR_PAYROLL_SHIFT_DURATIONS = ['12h', '24h'] as const;
export const DIRECTOR_PAYROLL_MATERIAL_CLASSES = ['primary', 'secondary'] as const;
export const DIRECTOR_PAYROLL_TARIFF_RULES = [
  'primary',
  'secondary',
  'thin_roll',
  'abc_standard',
  'abc_black_white',
  'alabuga_override',
] as const;
export const DIRECTOR_PAYROLL_UNRESOLVED_REASONS = [
  'before_policy_effective_date',
  'shift_not_closed',
  'production_operator_unresolved',
  'post_session_unresolved',
  'shift_unresolved',
  'machine_family_unresolved',
  'shift_duration_unresolved',
  'material_class_unresolved',
  'film_type_unresolved',
  'counterparty_unresolved',
] as const;

export type DirectorPayrollQuery = { from: string; to: string };
export type DirectorPayrollMachineFamily = (typeof DIRECTOR_PAYROLL_MACHINE_FAMILIES)[number];
export type DirectorPayrollShiftDuration = (typeof DIRECTOR_PAYROLL_SHIFT_DURATIONS)[number];
export type DirectorPayrollMaterialClass = (typeof DIRECTOR_PAYROLL_MATERIAL_CLASSES)[number];
export type DirectorPayrollTariffRule = (typeof DIRECTOR_PAYROLL_TARIFF_RULES)[number];
export type DirectorPayrollUnresolvedReason = (typeof DIRECTOR_PAYROLL_UNRESOLVED_REASONS)[number];

export type DirectorPayrollBreakdownRow = {
  id: string;
  tariffOrderId: string;
  operatorId: string;
  operatorName: string;
  shiftId: string;
  shiftLabel: string;
  shiftDate: string;
  postId: string;
  postCode: string;
  postName: string;
  machineFamily: DirectorPayrollMachineFamily;
  shiftDuration: DirectorPayrollShiftDuration;
  shiftOutputKg: number;
  payableKg: number;
  rateKopecksPerKg: number;
  amountKopecks: number;
  tariffRule: DirectorPayrollTariffRule;
  basisLabel: string;
  materialClass: DirectorPayrollMaterialClass | null;
  filmClass: 'standard' | 'black_white' | null;
  specialCustomer: boolean;
};

export type DirectorPayrollOperatorSummary = {
  operatorId: string;
  operatorName: string;
  payableKg: number;
  amountKopecks: number;
  machineShiftCount: number;
  unresolvedFactCount: number;
};

export type DirectorPayrollUnresolvedFact = {
  rollId: string;
  rollCode: string;
  orderId: string;
  orderNumber: string;
  producedAt: string;
  netKg: number;
  operatorId: string | null;
  operatorName: string | null;
  shiftId: string | null;
  shiftLabel: string | null;
  postId: string | null;
  postCode: string | null;
  postName: string | null;
  reasons: DirectorPayrollUnresolvedReason[];
};

/**
 * `partial` has calculated data and at least one unresolved fact; `empty` has neither;
 * `complete` has calculated data and no unresolved facts.
 */
export type DirectorPayrollPreviewStatus = 'complete' | 'partial' | 'empty';

export type DirectorPayrollPreview = {
  status: DirectorPayrollPreviewStatus;
  appliedTariffOrders: AppliedPayrollTariffOrder[];
  range: {
    fromDate: string;
    toDate: string;
    timezone: typeof DIRECTOR_PAYROLL_TIMEZONE;
    generatedAt: string;
  };
  summary: {
    payableAmountKopecks: number;
    payableKg: number;
    machineShiftCount: number;
    operatorCount: number;
    unresolvedKg: number;
    unresolvedFactCount: number;
    excludedDefectKg: number;
    excludedDefectRollCount: number;
  };
  operators: DirectorPayrollOperatorSummary[];
  breakdown: DirectorPayrollBreakdownRow[];
  unresolved: DirectorPayrollUnresolvedFact[];
};
