import type { PayrollTariffOrderErrorCode, PayrollTariffOrderFieldError } from '@plenka/contracts';

export class PayrollTariffOrderDomainError extends Error {
  constructor(
    readonly code: PayrollTariffOrderErrorCode,
    message: string,
    readonly fieldErrors?: PayrollTariffOrderFieldError[],
  ) {
    super(message);
    this.name = 'PayrollTariffOrderDomainError';
  }
}

export function corruptPayrollTariffOrder(): PayrollTariffOrderDomainError {
  return new PayrollTariffOrderDomainError(
    'PAYROLL_TARIFF_ORDER_CORRUPT',
    'Опубликованный приказ по тарифам повреждён',
  );
}

export function payrollTariffOrderError(
  code: PayrollTariffOrderErrorCode,
  message: string,
  fieldErrors?: PayrollTariffOrderFieldError[],
): PayrollTariffOrderDomainError {
  return new PayrollTariffOrderDomainError(code, message, fieldErrors);
}
