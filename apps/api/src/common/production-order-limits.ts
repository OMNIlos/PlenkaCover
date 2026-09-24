import { UnprocessableEntityException } from '@nestjs/common';

export const MAX_PRODUCTION_DISPATCH_ITEMS = 2_000;

export function assertProductionDispatchItemCount(count: number): void {
  if (Number.isSafeInteger(count) && count > 0 && count <= MAX_PRODUCTION_DISPATCH_ITEMS) return;
  throw new UnprocessableEntityException({
    code: 'PRODUCTION_ORDER_TOO_LARGE',
    message: 'В заказе слишком много рулонов для безопасной передачи в производство.',
    maxRolls: MAX_PRODUCTION_DISPATCH_ITEMS,
  });
}
