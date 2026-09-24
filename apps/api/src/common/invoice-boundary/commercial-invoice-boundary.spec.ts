import {
  invoiceLocksCommercialParameters,
  lockInvoiceBoundaryForCommercialOrder,
  lockInvoiceBoundaryForFinanceOrder,
  readInvoiceBoundaryForCommercialOrder,
  tryLockCommercialInvoiceBoundary,
  type CommercialInvoiceBoundary,
} from './commercial-invoice-boundary';

const OPEN_BOUNDARY: CommercialInvoiceBoundary = {
  financeOrderId: 'finance-1',
  commercialOrderId: 'order-1',
  invoiceStatus: 'not_invoiced',
  invoiceIssuedAt: null,
  invoiceSyncState: 'not_synced',
};

describe('commercial invoice boundary', () => {
  it.each([
    [null, false],
    [OPEN_BOUNDARY, false],
    [{ ...OPEN_BOUNDARY, invoiceStatus: 'invoiced' }, true],
    [{ ...OPEN_BOUNDARY, invoiceIssuedAt: new Date('2026-08-06T08:00:00.000Z') }, true],
    [{ ...OPEN_BOUNDARY, invoiceSyncState: 'posted' }, true],
    [{ ...OPEN_BOUNDARY, invoiceSyncState: 'draft_found' }, false],
    [{ ...OPEN_BOUNDARY, invoiceSyncState: 'stale' }, false],
  ] satisfies Array<[CommercialInvoiceBoundary | null, boolean]>)(
    'classifies invoice facts %#',
    (boundary, expected) => {
      expect(invoiceLocksCommercialParameters(boundary)).toBe(expected);
    },
  );

  it('serializes invoice publication before preserving FinanceOrder-first row locking', async () => {
    const calls: string[] = [];
    const tx = {
      financeOrder: {
        findUnique: jest
          .fn()
          .mockImplementationOnce(async () => {
            calls.push('resolve-finance-link');
            return { id: 'finance-1', commercialOrderId: 'order-1' };
          })
          .mockImplementationOnce(async () => {
            calls.push('read-boundary');
            return {
              id: 'finance-1',
              commercialOrderId: 'order-1',
              invoiceStatus: 'not_invoiced',
              invoiceIssuedAt: null,
              invoiceSyncState: 'not_synced',
            };
          }),
      },
      $queryRaw: jest
        .fn()
        .mockImplementationOnce(async () => {
          calls.push('lock-boundary-advisory');
          return [{ lock: '1' }];
        })
        .mockImplementationOnce(async () => {
          calls.push('lock-finance-order');
          return [{ id: 'finance-1' }];
        }),
    };

    await expect(lockInvoiceBoundaryForFinanceOrder(tx as never, 'finance-1')).resolves.toEqual(
      OPEN_BOUNDARY,
    );
    expect(calls).toEqual([
      'resolve-finance-link',
      'lock-boundary-advisory',
      'lock-finance-order',
      'read-boundary',
    ]);
  });

  it('serializes a read-committed commercial edit without taking a FinanceOrder row lock', async () => {
    const calls: string[] = [];
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockImplementationOnce(async () => {
          calls.push('read-boundary');
          return {
            id: 'finance-1',
            commercialOrderId: 'order-1',
            invoiceStatus: 'not_invoiced',
            invoiceIssuedAt: null,
            invoiceSyncState: 'not_synced',
          };
        }),
      },
      $queryRaw: jest.fn().mockImplementationOnce(async () => {
        calls.push('lock-boundary-advisory');
        return [{ lock: '1' }];
      }),
    };

    await expect(lockInvoiceBoundaryForCommercialOrder(tx as never, 'order-1')).resolves.toEqual(
      OPEN_BOUNDARY,
    );
    expect(calls).toEqual(['lock-boundary-advisory', 'read-boundary']);
  });

  it('lets serializable amendments try the boundary as their first statement and read after coverage locks', async () => {
    const calls: string[] = [];
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockImplementationOnce(async () => {
          calls.push('read-boundary');
          return {
            id: 'finance-1',
            commercialOrderId: 'order-1',
            invoiceStatus: 'not_invoiced',
            invoiceIssuedAt: null,
            invoiceSyncState: 'not_synced',
          };
        }),
      },
      $queryRaw: jest.fn().mockImplementationOnce(async () => {
        calls.push('try-boundary-advisory');
        return [{ locked: true }];
      }),
    };

    await expect(tryLockCommercialInvoiceBoundary(tx as never, 'order-1')).resolves.toBe(true);
    calls.push('lock-coverage-hierarchy');
    await expect(readInvoiceBoundaryForCommercialOrder(tx as never, 'order-1')).resolves.toEqual(
      OPEN_BOUNDARY,
    );
    expect(calls).toEqual(['try-boundary-advisory', 'lock-coverage-hierarchy', 'read-boundary']);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reports a busy boundary without waiting inside a serializable transaction', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ locked: false }]),
    };

    await expect(tryLockCommercialInvoiceBoundary(tx as never, 'order-1')).resolves.toBe(false);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns null after locking a commercial order that has no finance order', async () => {
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'order-1' }]),
    };

    await expect(lockInvoiceBoundaryForCommercialOrder(tx as never, 'order-1')).resolves.toBeNull();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns null without locking when the finance order does not exist', async () => {
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $queryRaw: jest.fn(),
    };

    await expect(
      lockInvoiceBoundaryForFinanceOrder(tx as never, 'missing-finance'),
    ).resolves.toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
