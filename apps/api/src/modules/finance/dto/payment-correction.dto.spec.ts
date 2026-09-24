import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaymentCorrectionDto } from './payment-correction.dto';

const valid = {
  operationKey: '7c49f11d-4cb0-4824-8905-1b4c8db9be67',
  target: { kind: 'schedule_confirmation', id: 'schedule-1' },
  expectedPaymentStatus: 'paid',
  reason: 'Ошибочно подтверждён не тот этап',
};

describe('PaymentCorrectionDto', () => {
  it('normalizes and accepts an exact target-specific command', async () => {
    const dto = plainToInstance(PaymentCorrectionDto, {
      ...valid,
      operationKey: valid.operationKey.toUpperCase(),
      target: { ...valid.target, id: ' schedule-1 ' },
      reason: '  Ошибочно подтверждён не тот этап  ',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).toMatchObject(valid);
  });

  it.each([
    ['operation key', { operationKey: 'not-a-uuid' }],
    ['target kind', { target: { kind: 'whole_status', id: 'schedule-1' } }],
    ['target id', { target: { kind: 'payment_operation', id: ' ' } }],
    ['payment status', { expectedPaymentStatus: 'not_applicable' }],
    ['reason', { reason: ' ' }],
    ['reason length', { reason: 'x'.repeat(501) }],
  ])('rejects invalid %s', async (_caseName, patch) => {
    const dto = plainToInstance(PaymentCorrectionDto, { ...valid, ...patch });

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
