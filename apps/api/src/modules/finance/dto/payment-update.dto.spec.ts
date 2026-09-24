import { validate } from 'class-validator';
import { PaymentUpdateDto } from './payment-update.dto';

const OPERATION_KEY = '2c0190d9-4db0-49ff-8358-f6f0a393b44c';

function dto(paymentStatus: string) {
  return Object.assign(new PaymentUpdateDto(), {
    operationKey: OPERATION_KEY,
    paymentStatus,
  });
}

describe('PaymentUpdateDto', () => {
  it.each(['partial', 'paid'])('accepts the manual fact-backed status %s', async (status) => {
    await expect(validate(dto(status))).resolves.toEqual([]);
  });

  it.each(['unpaid', 'overdue', 'sync_error'])(
    'rejects the server-derived status %s at the HTTP boundary',
    async (status) => {
      await expect(validate(dto(status))).resolves.toEqual([
        expect.objectContaining({ property: 'paymentStatus' }),
      ]);
    },
  );
});
