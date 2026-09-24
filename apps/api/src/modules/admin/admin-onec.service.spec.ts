import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminOneCService } from './admin-onec.service';

const actor = { userId: 'admin-1', role: 'admin' as const };

function setup() {
  const prisma = {
    operationalCheck: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    sourceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
    },
    syncJournal: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    oneCSyncRun: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const onec = {
    checkHealth: jest.fn().mockResolvedValue({
      mode: 'mock',
      status: 'ready',
      checkedAt: '2026-07-13T10:00:00.000Z',
      latencyMs: 1,
      endpointLabel: 'mock_1C',
    }),
  };
  const imports = {
    importCounterparties: jest.fn().mockResolvedValue([{ subjectType: 'counterparty' }]),
    importCounterparty: jest.fn().mockResolvedValue({ subjectType: 'counterparty' }),
    importInvoice: jest.fn().mockResolvedValue({ subjectType: 'invoice' }),
    importPayments: jest.fn().mockResolvedValue([{ subjectType: 'payment' }]),
    importShipments: jest.fn().mockResolvedValue([{ subjectType: 'shipment' }]),
    importStock: jest.fn().mockResolvedValue([{ subjectType: 'stock' }]),
  };
  const checks = { record: jest.fn().mockResolvedValue({ id: 'check-1' }) };
  const incidents = { signal: jest.fn().mockResolvedValue({ id: 'incident-1' }) };
  const sync = {
    run: jest.fn().mockResolvedValue({
      id: 'run-1',
      mode: 'preview',
      status: 'completed',
      counters: {},
    }),
  };
  const service = new AdminOneCService(
    prisma as never,
    audit as never,
    onec as never,
    imports as never,
    checks as never,
    incidents as never,
    sync as never,
  );
  return { service, prisma, audit, onec, imports, checks, incidents, sync };
}

describe('AdminOneCService', () => {
  it('dispatches preview and apply through the full synchronization coordinator', async () => {
    const { service, sync } = setup();

    await service.previewSync(actor);
    await service.runSync(actor);

    expect(sync.run).toHaveBeenNthCalledWith(1, actor, 'preview');
    expect(sync.run).toHaveBeenNthCalledWith(2, actor, 'apply');
  });

  it('lists safe synchronization runs with deterministic pagination', async () => {
    const { service, prisma } = setup();
    prisma.oneCSyncRun.findMany.mockResolvedValue([
      {
        id: 'run-1',
        mode: 'apply',
        status: 'completed',
        counters: {},
        errorCode: null,
        recovery: null,
        startedAt: new Date('2026-07-29T08:00:00.000Z'),
        completedAt: new Date('2026-07-29T08:01:00.000Z'),
      },
    ]);
    prisma.oneCSyncRun.count.mockResolvedValue(1);

    const result = await service.listSyncRuns({ page: 2, pageSize: 20 });

    expect(result).toMatchObject({ page: 2, pageSize: 20, total: 1 });
    expect(prisma.oneCSyncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 20,
        select: expect.not.objectContaining({ rawPayload: true }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('rawPayload');
  });

  it('builds a bounded reconciliation result from the latest safe run counters', async () => {
    const { service, prisma } = setup();
    prisma.oneCSyncRun.findFirst.mockResolvedValue({
      id: 'run-conflict',
      status: 'completed',
      counters: {
        nomenclature: {
          fetched: 2,
          created: 1,
          updated: 0,
          unchanged: 0,
          conflicts: 1,
        },
      },
    });

    await expect(service.reconciliation()).resolves.toMatchObject({
      latestRunId: 'run-conflict',
      status: 'attention_required',
      issues: [
        expect.objectContaining({
          subjectType: 'nomenclature',
          code: 'identity_conflict',
        }),
      ],
    });
  });

  it('runs a connection check and persists safe check plus audit', async () => {
    const { service, onec, checks, audit } = setup();

    const result = await service.check(actor);

    expect(result).toMatchObject({ mode: 'mock', status: 'ready' });
    expect(onec.checkHealth).toHaveBeenCalled();
    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'onec', status: 'passed', actorId: 'admin-1' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.onec.check_requested' }),
    );
  });

  it('signals an incident for an unavailable connection without leaking an adapter error', async () => {
    const { service, onec, checks, incidents } = setup();
    onec.checkHealth.mockResolvedValue({
      mode: 'http',
      status: 'unavailable',
      checkedAt: '2026-07-13T10:00:00.000Z',
      latencyMs: 50,
      errorCategory: 'auth',
      message: '1С authentication failed.',
    });

    await service.check(actor);

    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        summary: expect.not.objectContaining({ raw: expect.anything() }),
      }),
    );
    expect(incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'onec:connection', severity: 'critical' }),
    );
  });

  it.each([
    ['counterparty', undefined, 'importCounterparties'],
    ['counterparty', 'cp-1', 'importCounterparty'],
    ['invoice', 'inv-1', 'importInvoice'],
    ['payment', undefined, 'importPayments'],
    ['shipment', undefined, 'importShipments'],
    ['stock', undefined, 'importStock'],
  ] as const)(
    'dispatches %s import through OneCImportService',
    async (subjectType, externalId, method) => {
      const { service, imports, audit } = setup();

      await service.import(actor, { subjectType, externalId });

      expect(imports[method]).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'admin.onec.import_requested' }),
      );
    },
  );

  it('requires externalId for an invoice import', async () => {
    const { service } = setup();
    await expect(service.import(actor, { subjectType: 'invoice' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('retries a finance journal by performing an actual invoice import', async () => {
    const { service, prisma, imports } = setup();
    prisma.syncJournal.findUnique.mockResolvedValue({
      id: 'journal-1',
      entity: 'finance_order',
      financeOrderId: 'finance-1',
      status: 'error',
      retries: 1,
    });
    prisma.syncJournal.update.mockResolvedValue({ id: 'journal-1', status: 'ready' });

    await service.retry(actor, 'journal-1');

    expect(imports.importInvoice).toHaveBeenCalledWith(actor, 'finance-1');
    expect(prisma.syncJournal.update).toHaveBeenCalledWith({
      where: { id: 'journal-1' },
      data: { status: 'ready', retries: { increment: 1 }, recovery: null },
    });
  });

  it('rejects a finance-owned keyed retry without importing or mutating its claim', async () => {
    const { service, prisma, imports } = setup();
    prisma.syncJournal.findUnique.mockResolvedValue({
      id: 'journal-finance-owned',
      entity: 'invoice',
      financeOrderId: 'finance-1',
      operationKey: '7fc1ff55-6c96-482d-a56e-3036ae0801ef',
      activeScopeKey: 'finance-invoice-sync:finance-1',
      status: 'retry_requested',
      retries: 1,
      leaseExpiresAt: new Date('2026-07-17T12:05:00.000Z'),
    });

    await expect(service.retry(actor, 'journal-finance-owned')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ADMIN_ONEC_FINANCE_RETRY_OWNED' }),
    });

    expect(imports.importInvoice).not.toHaveBeenCalled();
    expect(prisma.syncJournal.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown or unmapped retry', async () => {
    const { service, prisma } = setup();
    await expect(service.retry(actor, 'missing')).rejects.toBeInstanceOf(NotFoundException);

    prisma.syncJournal.findUnique.mockResolvedValue({
      id: 'journal-2',
      entity: 'unsupported',
      financeOrderId: null,
    });
    await expect(service.retry(actor, 'journal-2')).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns safe paginated snapshots and exposes raw only through explicit lookup', async () => {
    const { service, prisma } = setup();
    prisma.sourceSnapshot.findMany.mockResolvedValue([
      { id: 'snap-1', subjectType: 'stock', parsed: { qty: 1 } },
    ]);
    prisma.sourceSnapshot.findUnique.mockResolvedValue({
      id: 'snap-1',
      rawPayload: { secretFrame: 'raw' },
    });

    const list = await service.listSnapshots({ page: 1, pageSize: 50 });
    const raw = await service.rawSnapshot('snap-1');

    expect(JSON.stringify(list)).not.toContain('rawPayload');
    expect(raw.rawPayload).toEqual({ secretFrame: 'raw' });
    expect(prisma.sourceSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ rawPayload: true }) }),
    );
  });
});
