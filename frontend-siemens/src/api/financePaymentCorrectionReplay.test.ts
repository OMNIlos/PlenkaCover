import { describe, expect, it } from 'vitest';

import { ApiError, ApiResponseParseError } from './client';
import {
  FinancePaymentCorrectionReplayGuard,
  financePaymentCorrectionIntent,
} from './financePaymentCorrectionReplay';

const payload = {
  target: { kind: 'schedule_confirmation' as const, id: 'schedule-1' },
  expectedPaymentStatus: 'paid' as const,
  reason: 'Ошибочное подтверждение',
};

describe('finance payment correction replay guard', () => {
  it('freezes the exact normalized payload and operation key after uncertain delivery', () => {
    const guard = new FinancePaymentCorrectionReplayGuard();
    const prepared = guard.prepare('finance-1', { ...payload, reason: `  ${payload.reason}  ` });
    const command = guard.command(
      'finance-1',
      prepared,
      '00000000-0000-4000-8000-000000000501',
    );

    guard.reject(
      'finance-1',
      command,
      new ApiResponseParseError(201, new Error('malformed response')),
    );

    expect(() =>
      guard.prepare('finance-1', { ...payload, reason: 'Другая причина' }),
    ).toThrow('можно повторить только сохранённую корректировку');
    expect(() =>
      guard.prepare('finance-1', {
        ...payload,
        target: { kind: 'payment_operation', id: 'operation-2' },
      }),
    ).toThrow('можно повторить только сохранённую корректировку');

    const retryPayload = guard.prepare('finance-1', payload);
    expect(
      guard.command('finance-1', retryPayload, '00000000-0000-4000-8000-000000000501'),
    ).toEqual(command);
    expect(() =>
      guard.command('finance-1', retryPayload, '00000000-0000-4000-8000-000000000502'),
    ).toThrow('другой operationKey');
    expect(financePaymentCorrectionIntent('finance-1', retryPayload)).toContain(
      'Ошибочное подтверждение',
    );

    guard.resolve('finance-1');
    expect(
      guard.prepare('finance-1', { ...payload, reason: 'Новая корректировка' }),
    ).toEqual({ ...payload, reason: 'Новая корректировка' });
  });

  it('releases the frozen command after a deterministic response', () => {
    const guard = new FinancePaymentCorrectionReplayGuard();
    const prepared = guard.prepare('finance-1', payload);
    const command = guard.command(
      'finance-1',
      prepared,
      '00000000-0000-4000-8000-000000000503',
    );
    guard.reject('finance-1', command, new ApiError(409, 'Конфликт fingerprint.'));

    expect(
      guard.prepare('finance-1', { ...payload, reason: 'Исправленная причина' }),
    ).toEqual({ ...payload, reason: 'Исправленная причина' });
  });
});
