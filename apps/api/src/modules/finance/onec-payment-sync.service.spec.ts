import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OneCPaymentSnapshot } from '@plenka/contracts';
import { OneCPaymentSyncService } from './onec-payment-sync.service';

const OPERATION_KEY = '2cc610b7-f906-414b-b62d-a43c514b2139';
const OTHER_OPERATION_KEY = '70b5ec89-d413-45ce-a01f-f88adc64564e';
const TAKEOVER_OPERATION_KEY = '5527bc4b-c097-4318-b1d6-b406b74345b8';
const REQUEST_FINGERPRINT = 'e87b364f343f641e9859efd630ed344de2a2fd5bc33f01d273a8103074751d1d';
const PAYMENT_ID = 'b95df6df-d804-4dfb-b29c-5bd2b43cf210';
const INVOICE_ID = 'c9da7a3f-8ce4-4681-aab7-61f87fe12c48';
const ACTOR = { userId: 'finance-1', role: 'finance' as const };

function payment(overrides: Partial<OneCPaymentSnapshot['parsed']> = {}): OneCPaymentSnapshot {
  return {
    sourceKind: 'mock_1C',
    subjectType: 'payment',
    externalId: PAYMENT_ID,
    sourceVersion: 'payment-v2',
    staleness: 'fresh',
    capturedAt: '2026-08-02T09:00:00.000Z',
    parsed: {
      number: 'ПП-0042',
      date: '2026-08-02T08:00:00.000Z',
      amount: 600,
      currency: 'RUB',
      counterpartyExternalId: 'counterparty-1',
      invoiceExternalId: INVOICE_ID,
      posted: true,
      deleted: false,
      ...overrides,
    },
    rawPayload: { secret: 'admin-only' },
  };
}

function setup(existingReceipt: Record<string, unknown> | null = null) {
  const storedReceipt = {
    id: 'receipt-1',
    externalId: PAYMENT_ID,
    sourceVersion: 'payment-v2',
    number: 'ПП-0042',
    receivedAt: new Date('2026-08-02T08:00:00.000Z'),
    amount: new Prisma.Decimal(600),
    currency: 'RUB',
    counterpartyExternalId: 'counterparty-1',
    invoiceExternalId: INVOICE_ID,
    invoiceNumberReference: null,
    orderReference: null,
    posted: true,
    deleted: false,
    sourceStatus: 'fresh',
    matchState: 'matched',
    matchKind: 'invoice_ref',
    candidateFinanceOrderIds: ['fo-1'],
    lastMatchedAt: new Date(),
    capturedAt: new Date('2026-08-02T09:00:00.000Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    allocations: [],
  };
  const tx = {
    syncJournal: {
      findUnique: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    paymentReceipt: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValueOnce(existingReceipt).mockResolvedValue(storedReceipt),
      upsert: jest.fn().mockResolvedValue(storedReceipt),
    },
    sourceSnapshot: {
      upsert: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
    },
  };
  let operationKeyLookups = 0;
  tx.syncJournal.findUnique.mockImplementation(
    ({ where }: { where: { operationKey?: string; activeScopeKey?: string } }) => {
      if (where.activeScopeKey) return null;
      operationKeyLookups += 1;
      return operationKeyLookups === 1
        ? null
        : {
            id: 'journal-1',
            operationKey: OPERATION_KEY,
            status: 'retry_requested',
            activeScopeKey: 'finance-payment-source-sync',
          };
    },
  );
  const prisma = {
    syncJournal: {
      findUnique: jest.fn(),
      updateMany: tx.syncJournal.updateMany,
    },
    paymentReceipt: tx.paymentReceipt,
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const adapter = { pullPayments: jest.fn() };
  const allocation = {
    matchOrders: jest.fn().mockResolvedValue([
      {
        financeOrderId: 'fo-1',
        invoiceExternalId: INVOICE_ID,
        invoiceNumber: 'СЧ-0042',
        invoiceCurrency: 'RUB',
        orderReference: 'PLENKA_ORDER=ЗК-0042',
        counterpartyExternalId: 'counterparty-1',
      },
    ]),
    autoApply: jest.fn().mockResolvedValue([{ id: 'allocation-1', amount: '600.00' }]),
    reverseReceipt: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const service = new OneCPaymentSyncService(
    prisma as never,
    audit as never,
    adapter as never,
    allocation as never,
    {
      onecTimeoutMs: 5000,
      onecPaymentAutoApplyEnabled: true,
      onecSyncPageSize: 2,
    } as never,
  );
  return { adapter, allocation, audit, prisma, service, tx };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function takeoverSetup() {
  type Journal = {
    id: string;
    operationKey: string;
    requestFingerprint: string;
    activeScopeKey: string | null;
    entity: string;
    status: string;
    ownerRole: 'finance';
    leaseExpiresAt: Date | null;
    completedAt: Date | null;
    recovery: string | null;
  };
  type JournalWhere = {
    id?: string;
    operationKey?: string;
    activeScopeKey?: string;
    entity?: string;
    status?: string;
    leaseExpiresAt?: { lte: Date };
  };
  type JournalData = Partial<Omit<Journal, 'id' | 'operationKey' | 'requestFingerprint'>>;

  const journals: Journal[] = [];
  const matches = (journal: Journal, where: JournalWhere) =>
    (where.id === undefined || journal.id === where.id) &&
    (where.operationKey === undefined || journal.operationKey === where.operationKey) &&
    (where.activeScopeKey === undefined || journal.activeScopeKey === where.activeScopeKey) &&
    (where.entity === undefined || journal.entity === where.entity) &&
    (where.status === undefined || journal.status === where.status) &&
    (where.leaseExpiresAt === undefined ||
      (journal.leaseExpiresAt !== null && journal.leaseExpiresAt <= where.leaseExpiresAt.lte));
  const findUnique = jest.fn(
    async ({ where }: { where: Pick<JournalWhere, 'id' | 'operationKey' | 'activeScopeKey'> }) =>
      journals.find((journal) => matches(journal, where)) ?? null,
  );
  const updateMany = jest.fn(
    async ({ where, data }: { where: JournalWhere; data: JournalData }) => {
      const journal = journals.find((candidate) => matches(candidate, where));
      if (!journal) return { count: 0 };
      Object.assign(journal, data);
      return { count: 1 };
    },
  );
  const createMany = jest.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
    const input = data[0];
    const operationKey = input.operationKey as string;
    const activeScopeKey = input.activeScopeKey as string;
    if (
      journals.some(
        (journal) =>
          journal.operationKey === operationKey || journal.activeScopeKey === activeScopeKey,
      )
    ) {
      return { count: 0 };
    }
    journals.push({
      id: `journal-${journals.length + 1}`,
      operationKey,
      requestFingerprint: input.requestFingerprint as string,
      activeScopeKey,
      entity: input.entity as string,
      status: input.status as string,
      ownerRole: input.ownerRole as 'finance',
      leaseExpiresAt: input.leaseExpiresAt as Date,
      completedAt: null,
      recovery: null,
    });
    return { count: 1 };
  });
  const syncJournal = { findUnique, updateMany, createMany };
  const storedReceipt = {
    id: 'receipt-after-takeover',
    externalId: PAYMENT_ID,
    sourceVersion: 'payment-v2',
    number: 'ПП-0042',
    receivedAt: new Date('2026-08-02T08:00:00.000Z'),
    amount: new Prisma.Decimal(600),
    currency: 'RUB',
    counterpartyExternalId: 'counterparty-1',
    invoiceExternalId: INVOICE_ID,
    invoiceNumberReference: null,
    orderReference: null,
    posted: true,
    deleted: false,
    sourceStatus: 'fresh',
    matchState: 'matched',
    matchKind: 'invoice_ref',
    candidateFinanceOrderIds: ['fo-1'],
    lastMatchedAt: new Date(),
    capturedAt: new Date('2026-08-02T09:00:00.000Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
    allocations: [],
  };
  let receiptWritten = false;
  const paymentReceipt = {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn(async () => (receiptWritten ? storedReceipt : null)),
    upsert: jest.fn(async () => {
      receiptWritten = true;
      return storedReceipt;
    }),
  };
  const sourceSnapshot = {
    upsert: jest.fn().mockResolvedValue({ id: 'snapshot-after-takeover' }),
  };
  const tx = { syncJournal, paymentReceipt, sourceSnapshot };
  const prisma = {
    syncJournal,
    paymentReceipt,
    $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const oldPull = deferred<OneCPaymentSnapshot[]>();
  const oldPullStarted = deferred<void>();
  const adapter = {
    pullPayments: jest
      .fn()
      .mockImplementationOnce(() => {
        oldPullStarted.resolve();
        return oldPull.promise;
      })
      .mockResolvedValueOnce([]),
  };
  const allocation = {
    matchOrders: jest.fn().mockResolvedValue([
      {
        financeOrderId: 'fo-1',
        invoiceExternalId: INVOICE_ID,
        invoiceNumber: 'СЧ-0042',
        invoiceCurrency: 'RUB',
        orderReference: 'PLENKA_ORDER=ЗК-0042',
        counterpartyExternalId: 'counterparty-1',
      },
    ]),
    autoApply: jest.fn().mockResolvedValue([{ id: 'allocation-1', amount: '600.00' }]),
    reverseReceipt: jest.fn().mockResolvedValue([]),
  };
  const service = new OneCPaymentSyncService(
    prisma as never,
    audit as never,
    adapter as never,
    allocation as never,
    {
      onecTimeoutMs: 5000,
      onecPaymentAutoApplyEnabled: true,
      onecSyncPageSize: 2,
    } as never,
  );
  return {
    adapter,
    allocation,
    audit,
    journals,
    oldPull,
    oldPullStarted,
    paymentReceipt,
    service,
    sourceSnapshot,
  };
}

describe('OneCPaymentSyncService', () => {
  it('imports a posted receipt and auto-applies an exact invoice Ref_Key match', async () => {
    const { adapter, allocation, service, tx } = setup();
    adapter.pullPayments.mockResolvedValue([payment()]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      imported: 1,
      matched: 1,
      autoApplied: 1,
      proposals: 0,
    });
    expect(tx.paymentReceipt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          externalId: PAYMENT_ID,
          matchState: 'matched',
          matchKind: 'invoice_ref',
        }),
      }),
    );
    expect(allocation.autoApply).toHaveBeenCalled();
    expect(tx.sourceSnapshot.upsert).toHaveBeenCalled();
  });

  it('loads every bounded payment page instead of silently stopping after the first page', async () => {
    const { adapter, service } = setup();
    const second = { ...payment(), externalId: 'b95df6df-d804-4dfb-b29c-5bd2b43cf211' };
    const third = { ...payment(), externalId: 'b95df6df-d804-4dfb-b29c-5bd2b43cf212' };
    adapter.pullPayments.mockResolvedValueOnce([payment(), second]).mockResolvedValueOnce([third]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      imported: 3,
    });
    expect(adapter.pullPayments).toHaveBeenNthCalledWith(1, { top: 2, skip: 0 });
    expect(adapter.pullPayments).toHaveBeenNthCalledWith(2, { top: 2, skip: 2 });
  });

  it('skips an unchanged fully allocated receipt without another write or audit event', async () => {
    const { adapter, audit, prisma, service, tx } = setup();
    adapter.pullPayments.mockResolvedValue([payment()]);
    prisma.paymentReceipt.findMany.mockResolvedValue([
      {
        id: 'receipt-1',
        externalId: PAYMENT_ID,
        sourceVersion: 'payment-v2',
        number: 'ПП-0042',
        receivedAt: new Date('2026-08-02T08:00:00.000Z'),
        amount: new Prisma.Decimal(600),
        currency: 'RUB',
        counterpartyExternalId: 'counterparty-1',
        invoiceExternalId: INVOICE_ID,
        invoiceNumberReference: null,
        orderReference: null,
        posted: true,
        deleted: false,
        sourceStatus: 'fresh',
        matchState: 'matched',
        matchKind: 'invoice_ref',
        candidateFinanceOrderIds: ['fo-1'],
        allocations: [{ amount: new Prisma.Decimal(600) }],
      },
    ]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect(tx.paymentReceipt.upsert).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledTimes(2);
  });

  it('keeps an invoice-number-only match as a manual proposal', async () => {
    const { adapter, allocation, service, tx } = setup();
    adapter.pullPayments.mockResolvedValue([
      payment({
        invoiceExternalId: null,
        invoiceNumberReference: 'СЧ-0042',
      }),
    ]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      proposals: 1,
      autoApplied: 0,
    });
    expect(tx.paymentReceipt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          matchState: 'proposal',
          matchKind: 'invoice_number_proposal',
        }),
      }),
    );
    expect(allocation.autoApply).not.toHaveBeenCalled();
  });

  it('creates compensating reversals when 1С unposts an allocated receipt', async () => {
    const existing = {
      id: 'receipt-1',
      externalId: PAYMENT_ID,
      sourceVersion: 'payment-v1',
      amount: new Prisma.Decimal(600),
      posted: true,
      deleted: false,
      allocations: [{ id: 'allocation-1', amount: new Prisma.Decimal(600) }],
    };
    const { adapter, allocation, service } = setup(existing);
    adapter.pullPayments.mockResolvedValue([payment({ posted: false })]);
    allocation.reverseReceipt.mockResolvedValue([{ id: 'reversal-1', amount: '-600.00' }]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      reversed: 1,
    });
    expect(allocation.reverseReceipt).toHaveBeenCalled();
    expect(allocation.autoApply).not.toHaveBeenCalled();
  });

  it('returns a sanitized source error and closes the durable claim', async () => {
    const { adapter, service, tx } = setup();
    adapter.pullPayments.mockRejectedValue(new Error('Basic secret'));

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(tx.syncJournal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'error', activeScopeKey: null }),
      }),
    );
  });

  it('atomically expires an abandoned payment lease, audits it, and claims the replacement', async () => {
    const { adapter, audit, service, tx } = setup();
    const activeScopeKey = 'finance-payment-source-sync';
    const staleClaim = {
      id: 'journal-stale',
      operationKey: OTHER_OPERATION_KEY,
      requestFingerprint: REQUEST_FINGERPRINT,
      activeScopeKey,
      entity: 'payment',
      status: 'retry_requested',
      ownerRole: 'finance',
      leaseExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
    };
    tx.syncJournal.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(staleClaim)
      .mockResolvedValueOnce({
        id: 'journal-new',
        operationKey: OPERATION_KEY,
        status: 'retry_requested',
        activeScopeKey,
      });
    adapter.pullPayments.mockResolvedValue([]);

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
      imported: 0,
      replayed: false,
    });

    expect(tx.syncJournal.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'journal-stale',
        operationKey: OTHER_OPERATION_KEY,
        activeScopeKey,
        entity: 'payment',
        status: 'retry_requested',
        leaseExpiresAt: { lte: expect.any(Date) },
      },
      data: {
        status: 'error',
        activeScopeKey: null,
        leaseExpiresAt: null,
        recovery: 'Payment sync lease expired before completion.',
        completedAt: expect.any(Date),
      },
    });
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      {
        actorRole: 'finance',
        actorId: 'finance-1',
        type: 'integration.onec_import_failed',
        detail: {
          operationKey: OTHER_OPERATION_KEY,
          subjectType: 'payment',
          code: 'PAYMENT_SYNC_LEASE_EXPIRED',
        },
      },
      tx,
    );
    expect(tx.syncJournal.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ operationKey: OPERATION_KEY, activeScopeKey })],
      }),
    );
  });

  it('keeps a fresh active payment lease as an active conflict', async () => {
    const { adapter, audit, service, tx } = setup();
    tx.syncJournal.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'journal-active',
        operationKey: OTHER_OPERATION_KEY,
        activeScopeKey: 'finance-payment-source-sync',
        entity: 'payment',
        status: 'retry_requested',
        leaseExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      });

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_SYNC_ACTIVE_CONFLICT' }),
    });

    expect(tx.syncJournal.createMany).not.toHaveBeenCalled();
    expect(adapter.pullPayments).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not claim or audit when stale-lease expiry loses its compare-and-swap', async () => {
    const { adapter, audit, service, tx } = setup();
    tx.syncJournal.findUnique
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'journal-race',
        operationKey: OTHER_OPERATION_KEY,
        activeScopeKey: 'finance-payment-source-sync',
        entity: 'payment',
        status: 'retry_requested',
        leaseExpiresAt: new Date('2026-08-01T00:00:00.000Z'),
      });
    tx.syncJournal.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_SYNC_STATE_CHANGED' }),
    });

    expect(tx.syncJournal.createMany).not.toHaveBeenCalled();
    expect(adapter.pullPayments).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replays an existing completed operation without touching the active scope', async () => {
    const { adapter, audit, service, tx } = setup();
    tx.syncJournal.findUnique.mockReset().mockResolvedValueOnce({
      id: 'journal-ready',
      operationKey: OPERATION_KEY,
      requestFingerprint: REQUEST_FINGERPRINT,
      activeScopeKey: null,
      entity: 'payment',
      status: 'ready',
    });

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toEqual({
      imported: 0,
      matched: 0,
      autoApplied: 0,
      proposals: 0,
      ambiguous: 0,
      unmatched: 0,
      reversed: 0,
      skipped: 0,
      replayed: true,
    });

    expect(tx.syncJournal.createMany).not.toHaveBeenCalled();
    expect(adapter.pullPayments).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps an existing operation-key mismatch as a key conflict', async () => {
    const { adapter, audit, service, tx } = setup();
    tx.syncJournal.findUnique.mockReset().mockResolvedValueOnce({
      id: 'journal-other-request',
      operationKey: OPERATION_KEY,
      requestFingerprint: '0'.repeat(64),
      activeScopeKey: null,
      entity: 'payment',
      status: 'ready',
    });

    await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PAYMENT_SYNC_KEY_CONFLICT' }),
    });

    expect(tx.syncJournal.createMany).not.toHaveBeenCalled();
    expect(adapter.pullPayments).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('fences a paused worker after a replacement takes over its expired claim', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(new Date('2026-08-10T19:00:00.000Z'));
      const {
        allocation,
        audit,
        oldPull,
        oldPullStarted,
        paymentReceipt,
        service,
        sourceSnapshot,
      } = takeoverSetup();
      const oldSync = service.sync(ACTOR, { operationKey: OPERATION_KEY });
      await oldPullStarted.promise;

      jest.setSystemTime(new Date('2026-08-10T19:01:06.000Z'));
      await expect(
        service.sync(ACTOR, { operationKey: TAKEOVER_OPERATION_KEY }),
      ).resolves.toMatchObject({ imported: 0, replayed: false });
      const auditCountAtTakeover = audit.record.mock.calls.length;

      oldPull.resolve([payment()]);
      await expect(oldSync).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(paymentReceipt.upsert).not.toHaveBeenCalled();
      expect(sourceSnapshot.upsert).not.toHaveBeenCalled();
      expect(allocation.autoApply).not.toHaveBeenCalled();
      expect(allocation.reverseReceipt).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledTimes(auditCountAtTakeover);
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'integration.onec_imported' }),
        expect.anything(),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('renews the exact claim across a healthy sync that outlives its original lease', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let now = new Date('2026-08-10T20:00:00.000Z').getTime();
      jest.setSystemTime(now);
      const { adapter, prisma, service, tx } = setup();
      const second = { ...payment(), externalId: 'b95df6df-d804-4dfb-b29c-5bd2b43cf211' };
      const third = { ...payment(), externalId: 'b95df6df-d804-4dfb-b29c-5bd2b43cf212' };
      adapter.pullPayments
        .mockImplementationOnce(async () => {
          now += 40_000;
          jest.setSystemTime(now);
          return [payment(), second];
        })
        .mockImplementationOnce(async () => {
          now += 40_000;
          jest.setSystemTime(now);
          return [third];
        });

      await expect(service.sync(ACTOR, { operationKey: OPERATION_KEY })).resolves.toMatchObject({
        imported: 3,
      });

      const renewalCalls = tx.syncJournal.updateMany.mock.calls.filter(
        ([input]) => input.data.status === undefined && input.data.leaseExpiresAt instanceof Date,
      );
      expect(prisma.syncJournal.updateMany).toBe(tx.syncJournal.updateMany);
      expect(renewalCalls).toHaveLength(5);
      for (const [input] of renewalCalls) {
        expect(input).toEqual({
          where: {
            id: 'journal-1',
            operationKey: OPERATION_KEY,
            activeScopeKey: 'finance-payment-source-sync',
            entity: 'payment',
            status: 'retry_requested',
          },
          data: { leaseExpiresAt: expect.any(Date) },
        });
      }
      expect(renewalCalls.map(([input]) => input.data.leaseExpiresAt.toISOString())).toEqual([
        '2026-08-10T20:01:05.000Z',
        '2026-08-10T20:01:45.000Z',
        '2026-08-10T20:02:25.000Z',
        '2026-08-10T20:02:25.000Z',
        '2026-08-10T20:02:25.000Z',
      ]);
      expect(now).toBe(new Date('2026-08-10T20:01:20.000Z').getTime());
    } finally {
      jest.useRealTimers();
    }
  });

  it('cannot complete or fail an old journal after takeover clears its ownership scope', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      jest.setSystemTime(new Date('2026-08-10T21:00:00.000Z'));
      const { audit, journals, oldPull, oldPullStarted, service } = takeoverSetup();
      const oldSync = service.sync(ACTOR, { operationKey: OPERATION_KEY });
      await oldPullStarted.promise;

      jest.setSystemTime(new Date('2026-08-10T21:01:06.000Z'));
      await service.sync(ACTOR, { operationKey: TAKEOVER_OPERATION_KEY });
      const auditCountAtTakeover = audit.record.mock.calls.length;

      oldPull.resolve([]);
      await expect(oldSync).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(journals).toEqual([
        expect.objectContaining({
          id: 'journal-1',
          operationKey: OPERATION_KEY,
          status: 'error',
          activeScopeKey: null,
          leaseExpiresAt: null,
          completedAt: new Date('2026-08-10T21:01:06.000Z'),
          recovery: 'Payment sync lease expired before completion.',
        }),
        expect.objectContaining({
          id: 'journal-2',
          operationKey: TAKEOVER_OPERATION_KEY,
          status: 'ready',
          activeScopeKey: null,
        }),
      ]);
      expect(audit.record).toHaveBeenCalledTimes(auditCountAtTakeover);
    } finally {
      jest.useRealTimers();
    }
  });
});
