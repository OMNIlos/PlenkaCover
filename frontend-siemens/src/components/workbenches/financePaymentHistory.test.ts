import { describe, expect, it } from 'vitest';
import type { WorkObject } from '../../domain/types';
import { financePaymentHistory } from './financePaymentHistory';

describe('financePaymentHistory', () => {
  it('merges imported, manual, and correction facts while deduplicating an allocation mirror', () => {
    const object = {
      financePaymentTimeline: [
        {
          id: 'allocation-1',
          receiptId: 'receipt-1',
          amount: '40.00',
          status: 'applied',
          createdAt: '2026-08-10T10:00:00.000Z',
        },
      ],
      financePaymentCorrections: [
        {
          id: 'correction-1',
          targetKind: 'payment_operation',
          reason: 'Исправление',
          actorRole: 'Бухгалтерия',
          resultingStatus: 'partial',
          createdAt: '2026-08-10T11:00:00.000Z',
        },
      ],
      paymentOperations: [
        {
          id: 'operation-mirror',
          allocationId: 'allocation-1',
          label: 'Зеркало поступления',
          amountLabel: '40 ₽',
        },
        {
          id: 'operation-manual',
          label: 'Ручная корректировка',
          amountLabel: '10 ₽',
        },
      ],
      audit: [],
    } as unknown as WorkObject;

    expect(financePaymentHistory(object).map(({ id }) => id)).toEqual([
      'allocation-1',
      'correction-1',
      'operation-manual',
    ]);
  });

  it('fails closed for known, unknown and missing payment-operation source codes', () => {
    const object = {
      paymentOperations: [
        { id: '1c', label: 'Оплата', amountLabel: '1 ₽', source: '1C' },
        { id: 'mock-1c', label: 'Оплата', amountLabel: '2 ₽', source: 'mock_1C' },
        { id: 'manual', label: 'Оплата', amountLabel: '3 ₽', source: 'manual_platform' },
        { id: 'warehouse', label: 'Оплата', amountLabel: '4 ₽', source: 'warehouse_runtime' },
        { id: 'unknown', label: 'Оплата', amountLabel: '5 ₽', source: 'partner_bank_api_v2' },
        { id: 'missing', label: 'Оплата', amountLabel: '6 ₽' },
      ],
      audit: [],
    } as unknown as WorkObject;

    const history = financePaymentHistory(object);

    expect(history.map(({ source }) => source)).toEqual([
      'Учётный источник',
      'Учётный источник',
      'Внесено вручную',
      'Подтверждено складом',
      'Другой источник',
      'Источник не указан',
    ]);
    expect(JSON.stringify(history)).not.toMatch(
      /mock_1C|manual_platform|warehouse_runtime|partner_bank_api_v2/u,
    );
  });
});
