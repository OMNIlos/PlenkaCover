import {
  ArgumentsHost,
  Catch,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import type { PayrollTariffOrderErrorCode } from '@plenka/contracts';
import { PayrollTariffOrderDomainError } from './payroll-tariff-order.errors';

type HttpResponse = {
  status(code: number): HttpResponse;
  json(body: unknown): void;
};

const UNPROCESSABLE_CODES = new Set<PayrollTariffOrderErrorCode>([
  'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
  'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_PAST_OR_TODAY',
]);

function statusFor(code: PayrollTariffOrderErrorCode): number {
  if (code === 'PAYROLL_TARIFF_ORDER_NOT_FOUND') return HttpStatus.NOT_FOUND;
  if (code === 'PAYROLL_TARIFF_ORDER_CORRUPT') return HttpStatus.INTERNAL_SERVER_ERROR;
  if (UNPROCESSABLE_CODES.has(code)) return HttpStatus.UNPROCESSABLE_ENTITY;
  return HttpStatus.CONFLICT;
}

@Catch(PayrollTariffOrderDomainError)
export class PayrollTariffOrderExceptionFilter implements ExceptionFilter {
  catch(error: PayrollTariffOrderDomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    response.status(statusFor(error.code)).json({
      code: error.code,
      message: error.message,
      ...(error.fieldErrors === undefined ? {} : { fieldErrors: error.fieldErrors }),
    });
  }
}
