import { ServiceUnavailableException } from '@nestjs/common';
import type { OneCInvoiceSnapshot } from '@plenka/contracts';
import { classifyInvoiceCandidates, OneCInvoiceSyncService } from './onec-invoice-sync.service';

const OPERATION_KEY = '2cc610b7-f906-414b-b62d-a43c514b2139';
const INVOICE_ID = 'c9da7a3f-8ce4-4681-aab7-61f87fe12c48';
const ACTOR = { userId: 'finance-1', role: 'finance' as const };

function invoice(
  overrides: Partial<OneCInvoiceSnapshot['parsed']> = {},
  externalId = INVOICE_ID,
): OneCInvoiceSnapshot {
  return {
    sourceKind: 'mock_1C',
    subjectType: 'invoice',
    externalId,
    sourceVersion: 'invoice-v2',
    staleness: 'fresh',
    capturedAt: '2026-08-02T09:00:00.000Z',
    parsed: {
      invoiceNo: 'СЧ-0042',
      date: '2026-08-02T08:00:00.000Z',
      total: 1200,
      currency: 'RUB',
      counterpartyExternalId: 'counterparty-1',
      orderReference: 'PLENKA_ORDER=ЗК-0042',
      posted: true,
      deleted: false,
      lines: [
        {
          lineNumber: 1,
          nomenclatureExternalId: null,
          name: 'Плёнка',
          quantity: 20,
          price: 60,
          amount: 1200,
          unitExternalId: null,
        },
      ],
      ...overrides,
    },
    rawPayload: { secret: 'admin-only' },
  };
}

function setup(linkedExternalId: string | null = null) {
  const order = {
    id: 'finance-1',
    commercialOrderId: 'order-1',
    externalId: linkedExternalId,
    sourceVersion: linkedExternalId ? 'invoice-v1' : null,
    invoiceStatus: linkedExternalId ? 'invoiced' : 'not_invoiced',
    invoiceSyncState: linkedExternalId ? 'posted' : 'not_synced',
    invoiceIssuedAt: linkedExternalId ? new Date('2026-08-01T08:00:00.000Z') : null,
    sourceStatus: 'ready',
    commercialOrder: { orderNumber: 'ЗК-0042' },
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'finance-1' }]),
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue(order),
    },
    syncJournal: {
      findUnique: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    sourceSnapshot: {
      upsert: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
    },
  };
  tx.syncJournal.findUnique
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      id: 'journal-1',
      financeOrderId: 'finance-1',
      operationKey: OPERATION_KEY,
      requestFingerprint: expect.any(String),
      status: 'retry_requested',
      activeScopeKey: 'finance-invoice-sync:finance-1',
    });
  const prisma = {
    financeOrder: {
      findUnique: jest.fn().mockResolvedValue(order),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const adapter = {
    findInvoicesByOrderReference: jest.fn(),
    findInvoicesByExactNumber: jest.fn(),
    pullInvoiceByExternalId: jest.fn(),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new OneCInvoiceSyncService(
    prisma as never,
    audit as never,
    adapter as never,
    { onecTimeoutMs: 5000 } as never,
  );
  return { adapter, audit, order, prisma, service, tx };
}

describe('classifyInvoiceCandidates', () => {
  it('distinguishes zero, draft, posted and ambiguous exact matches', () => {
    expect(classifyInvoiceCandidates([], null)).toBe('not_found');
    expect(classifyInvoiceCandidates([invoice({ posted: false })], null)).toBe('draft_found');
    expect(classifyInvoiceCandidates([invoice()], null)).toBe('posted');
    expect(
      classifyInvoiceCandidates(
        [invoice(), invoice({}, 'd143d80b-8d34-4519-947f-e930c5ed7358')],
        null,
      ),
    ).toBe('ambiguous');
  });

  it('marks a linked invoice stale if 1С unposts or deletes it', () => {
    expect(classifyInvoiceCandidates([invoice({ posted: false })], INVOICE_ID)).toBe('stale');
    expect(classifyInvoiceCandidates([invoice({ deleted: true })], INVOICE_ID)).toBe('stale');
  });
});

describe('OneCInvoiceSyncService', () => {
  it('links invoice identity without importing its price or changing manual invoice status', async () => {
    const { adapter, service, tx } = setup();
    adapter.findInvoicesByOrderReference.mockResolvedValue([invoice()]);
    adapter.pullInvoiceByExternalId.mockResolvedValue(invoice());

    const result = await service.refresh(ACTOR, 'finance-1', { operationKey: OPERATION_KEY });
    expect(result).toMatchObject({
      financeOrderId: 'finance-1',
      orderReference: 'PLENKA_ORDER=ЗК-0042',
      invoiceSyncState: 'posted',
      invoice: {
        externalId: INVOICE_ID,
        invoiceNumber: 'СЧ-0042',
      },
    });
    expect(result.invoice).not.toHaveProperty('amount');
    expect(result.invoice).not.toHaveProperty('subtotal');
    expect(result.invoice).not.toHaveProperty('taxTotal');
    expect(result.invoice).not.toHaveProperty('lines');
    expect(result.candidates[0]).not.toHaveProperty('amount');
    expect(adapter.findInvoicesByOrderReference).toHaveBeenCalledWith('PLENKA_ORDER=ЗК-0042');
    expect(tx.financeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'finance-1' },
        data: expect.objectContaining({
          externalId: INVOICE_ID,
          sourceVersion: 'invoice-v2',
          invoiceSyncState: 'posted',
          invoiceNumber: 'СЧ-0042',
          invoiceIssuedAt: expect.any(Date),
        }),
      }),
    );
    const officialUpdate = tx.financeOrder.update.mock.calls.find(
      ([input]) => input.data.invoiceSyncState === 'posted',
    )?.[0];
    expect(officialUpdate?.data).not.toHaveProperty('invoiceStatus');
    expect(officialUpdate?.data).not.toHaveProperty('amountValue');
    expect(officialUpdate?.data).not.toHaveProperty('amountLabel');
    expect(tx.sourceSnapshot.upsert).toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      tx.financeOrder.update.mock.invocationCallOrder.find(
        (callOrder, index) => tx.financeOrder.update.mock.calls[index][0] === officialUpdate,
      )!,
    );
  });

  it('refreshes an already linked invoice only by Ref_Key', async () => {
    const { adapter, order, service, tx } = setup(INVOICE_ID);
    adapter.pullInvoiceByExternalId.mockResolvedValue(invoice());

    await service.refresh(ACTOR, 'finance-1', {
      operationKey: OPERATION_KEY,
    });

    expect(adapter.pullInvoiceByExternalId).toHaveBeenCalledWith(INVOICE_ID);
    expect(adapter.findInvoicesByOrderReference).not.toHaveBeenCalled();
    const refreshUpdate = tx.financeOrder.update.mock.calls.find(
      ([input]) => input.data.invoiceSyncState === 'posted',
    )?.[0];
    expect(refreshUpdate?.data).not.toHaveProperty('invoiceIssuedAt');
    expect(order.invoiceIssuedAt).toEqual(new Date('2026-08-01T08:00:00.000Z'));
  });

  it('preserves the first posted fact when a linked invoice later becomes stale', async () => {
    const { adapter, order, service, tx } = setup(INVOICE_ID);
    order.invoiceIssuedAt = null;
    adapter.pullInvoiceByExternalId.mockResolvedValue(invoice({ posted: false }));

    await expect(
      service.refresh(ACTOR, 'finance-1', { operationKey: OPERATION_KEY }),
    ).resolves.toMatchObject({ invoiceSyncState: 'stale' });

    expect(tx.financeOrder.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceSyncState: 'stale',
          invoiceIssuedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('links a manually selected invoice by exact 1С number without fuzzy matching', async () => {
    const { adapter, audit, service } = setup();
    adapter.findInvoicesByExactNumber.mockResolvedValue([invoice()]);
    adapter.pullInvoiceByExternalId.mockResolvedValue(invoice());

    await expect(
      service.link(ACTOR, 'finance-1', {
        operationKey: OPERATION_KEY,
        invoiceNumber: 'СЧ-0042',
        reason: 'Проверено бухгалтером в 1С',
      }),
    ).resolves.toMatchObject({
      invoiceSyncState: 'posted',
      invoice: { externalId: INVOICE_ID },
    });
    expect(adapter.findInvoicesByExactNumber).toHaveBeenCalledWith('СЧ-0042');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.onec_imported',
        reason: 'Проверено бухгалтером в 1С',
      }),
      expect.anything(),
    );
  });

  it('does not silently choose between duplicate exact invoice numbers', async () => {
    const { adapter, service } = setup();
    adapter.findInvoicesByExactNumber.mockResolvedValue([
      invoice(),
      invoice({}, 'd143d80b-8d34-4519-947f-e930c5ed7358'),
    ]);

    await expect(
      service.link(ACTOR, 'finance-1', {
        operationKey: OPERATION_KEY,
        invoiceNumber: 'СЧ-0042',
        reason: 'Проверка неоднозначного номера',
      }),
    ).resolves.toMatchObject({
      invoiceSyncState: 'ambiguous',
      candidateCount: 2,
      invoice: null,
    });
    expect(adapter.pullInvoiceByExternalId).not.toHaveBeenCalled();
  });

  it('fails the durable claim and returns a sanitized source error', async () => {
    const { adapter, service, tx } = setup();
    adapter.findInvoicesByOrderReference.mockRejectedValue(new Error('Basic secret'));

    await expect(
      service.refresh(ACTOR, 'finance-1', { operationKey: OPERATION_KEY }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'finance-1' },
      data: {
        invoiceSyncState: 'error',
        sourceStatus: 'error',
        invoiceSourceCheckedAt: expect.any(Date),
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$queryRaw.mock.invocationCallOrder[2]).toBeLessThan(
      tx.syncJournal.updateMany.mock.invocationCallOrder.at(-1)!,
    );
  });

  it('keeps a posted invoice boundary closed after a transport error', async () => {
    const { adapter, order, service, tx } = setup(INVOICE_ID);
    order.invoiceIssuedAt = null;
    adapter.pullInvoiceByExternalId.mockRejectedValue(new Error('connection failed'));

    await expect(
      service.refresh(ACTOR, 'finance-1', { operationKey: OPERATION_KEY }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(tx.financeOrder.update).toHaveBeenCalledWith({
      where: { id: 'finance-1' },
      data: {
        invoiceSyncState: 'error',
        sourceStatus: 'error',
        invoiceSourceCheckedAt: expect.any(Date),
        invoiceIssuedAt: expect.any(Date),
      },
    });
  });

  it('expires an abandoned lease before claiming a replacement sync', async () => {
    const { adapter, audit, service, tx } = setup(INVOICE_ID);
    const expiredAt = new Date('2026-08-02T08:00:00.000Z');
    tx.syncJournal.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'expired-journal',
        financeOrderId: 'finance-1',
        operationKey: '70b5ec89-d413-45ce-a01f-f88adc64564e',
        activeScopeKey: 'finance-invoice-sync:finance-1',
        entity: 'invoice',
        status: 'retry_requested',
        ownerRole: 'finance',
        leaseExpiresAt: expiredAt,
      })
      .mockResolvedValueOnce({
        id: 'journal-1',
        financeOrderId: 'finance-1',
        operationKey: OPERATION_KEY,
        status: 'retry_requested',
        activeScopeKey: 'finance-invoice-sync:finance-1',
      });
    adapter.pullInvoiceByExternalId.mockResolvedValue(invoice());

    await expect(
      service.refresh(ACTOR, 'finance-1', { operationKey: OPERATION_KEY }),
    ).resolves.toMatchObject({ invoiceSyncState: 'posted' });

    expect(tx.syncJournal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'expired-journal',
          activeScopeKey: 'finance-invoice-sync:finance-1',
          leaseExpiresAt: { lte: expect.any(Date) },
        }),
        data: expect.objectContaining({
          status: 'error',
          activeScopeKey: null,
          leaseExpiresAt: null,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.onec_import_failed',
        detail: expect.objectContaining({ code: 'INVOICE_SYNC_LEASE_EXPIRED' }),
      }),
      expect.anything(),
    );
  });
});
