import type {
  DirectorPayrollBreakdownRow,
  DirectorPayrollPreview,
  DirectorPayrollQuery,
  DirectorPayrollUnresolvedFact,
} from './director-payroll';
import type { PayrollTariffOrderReference } from './payroll-tariff-orders';

export type OperatorPayrollQuery = DirectorPayrollQuery;

export type OperatorPayrollBreakdownRow = Omit<
  DirectorPayrollBreakdownRow,
  'operatorId' | 'operatorName'
>;

export type OperatorPayrollUnresolvedFact = Omit<
  DirectorPayrollUnresolvedFact,
  'operatorId' | 'operatorName'
>;

/**
 * Private operator projection. Actor identity is taken only from the authenticated
 * session and is intentionally absent from the response.
 */
export type OperatorPayrollPreview = {
  status: DirectorPayrollPreview['status'];
  /** Safe order references; matrices remain director-only in this projection. */
  appliedTariffOrders: PayrollTariffOrderReference[];
  range: DirectorPayrollPreview['range'];
  summary: Omit<DirectorPayrollPreview['summary'], 'operatorCount'>;
  breakdown: OperatorPayrollBreakdownRow[];
  unresolved: OperatorPayrollUnresolvedFact[];
};

/** Authoritative payroll result frozen together with one successful shift close. */
export type OperatorShiftClosingPayroll = {
  sessionId: string;
  shiftId: string;
  status: OperatorPayrollPreview['status'];
  appliedTariffOrders: PayrollTariffOrderReference[];
  summary: OperatorPayrollPreview['summary'];
  breakdown: OperatorPayrollBreakdownRow[];
  unresolved: OperatorPayrollUnresolvedFact[];
};

export type OperatorShiftCloseResult = {
  balance: import('./operator-runtime').OperatorShiftBalance;
  problemId: string | null;
  releasedRollIds: string[];
  closingPayroll: OperatorShiftClosingPayroll;
};
