import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PALLET_LABEL_PROFILE } from '@plenka/contracts';
import { PalletPrintService } from './pallet-print.service';
import { WarehouseController } from './warehouse.controller';

const NOW = new Date('2026-07-14T12:00:00.000Z');
const REQUEST_1 = '11111111-1111-4111-8111-111111111111';
const REQUEST_2 = '22222222-2222-4222-8222-222222222222';
const PALLET_TOKEN = `plt_${'a'.repeat(64)}`;
const ACTOR = { userId: 'warehouse-user', role: 'warehouse' as const };

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterAll(() => {
  jest.useRealTimers();
});

const READY_PRINTER = {
  id: 'printer-1',
  code: 'PRINTER-1',
  label: 'MERTECH TLP4',
  kind: 'printer',
  connectionKind: 'tcp9100',
  isEnabled: true,
  status: 'ready',
  lastSeenAt: NOW,
  post: {
    id: 'post-1',
    code: 'POST-1',
    name: 'Складской пост',
    status: 'active',
    agentStatus: 'online',
    lastSeenAt: new Date(NOW.getTime() - 30_000),
  },
};

const DOCUMENT = {
  id: 'document-1',
  palletId: 'ПР-1407-01',
  voidedAt: null as Date | null,
  payload: {
    templateVersion: PALLET_LABEL_PROFILE.templateVersion,
    printReady: true,
    label: {
      templateVersion: PALLET_LABEL_PROFILE.templateVersion,
      palletId: 'ПР-1407-01',
      materialMark: 'PE-LD',
      productNames: ['Пленка ПВД'],
      article: '2000',
      rollCount: 3,
      packagingMaterial: 'Стрейч-пленка',
      packagingCount: 1,
      netKg: 120,
      grossKg: 124,
      productionDate: '07.2026',
      shelfLifeMonths: 12,
      deliveryDate: null,
      storageConditions: 'Хранить в сухом помещении',
      orderNumbers: ['A-1'],
      customerAliases: ['Клиент'],
      createdAt: NOW.toISOString(),
    },
  },
};

type Job = {
  id: string;
  palletListDocumentId: string;
  requestId: string;
  printerId: string;
  gatewayCommandId: string | null;
  status: string;
  failureReason: string | null;
  reason: string | null;
  replacesJobId: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

function setup(
  options: {
    document?: { id: string; palletId: string; payload: unknown; voidedAt: Date | null } | null;
    lockedDocument?: {
      id: string;
      palletId: string;
      payload: unknown;
      voidedAt: Date | null;
    } | null;
    printer?: typeof READY_PRINTER | null;
    printResult?:
      | { jobId: string; printerId: string; status: 'printed'; gatewayCommandId: string }
      | { jobId: string; printerId: string; status: 'failed'; failureReason: string }
      | {
          jobId: string;
          printerId: string;
          status: 'delivery_unknown';
          failureReason: string;
          gatewayCommandId: string;
        }
      | Error;
    adapterTransport?: 'gateway' | 'mock';
    finalizationError?: Error;
  } = {},
) {
  const jobs: Job[] = [];
  const document = options.document === undefined ? DOCUMENT : options.document;
  const lockedDocument = options.lockedDocument === undefined ? document : options.lockedDocument;
  const printer = options.printer === undefined ? READY_PRINTER : options.printer;
  const palletPrintJob = {
    findUnique: jest.fn(async ({ where }: { where: { requestId: string } }) =>
      jobs.find((job) => job.requestId === where.requestId),
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const status = where.status as string | { in?: string[] };
      const statuses = typeof status === 'string' ? [status] : (status.in ?? []);
      return [...jobs]
        .reverse()
        .find(
          (job) =>
            job.palletListDocumentId === where.palletListDocumentId &&
            statuses.includes(job.status),
        );
    }),
    create: jest.fn(async ({ data }: { data: Omit<Job, 'id' | 'createdAt' | 'completedAt'> }) => {
      if (jobs.some((job) => job.requestId === data.requestId)) throw uniqueViolation();
      const job: Job = {
        ...data,
        id: `print-job-${jobs.length + 1}`,
        createdAt: new Date(NOW.getTime() + jobs.length),
        completedAt: null,
      };
      jobs.push(job);
      return job;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<Job> }) => {
      const job = jobs.find((candidate) => candidate.id === where.id);
      if (!job) throw new Error(`Missing test job ${where.id}`);
      Object.assign(job, data);
      return job;
    }),
  };
  let transactionCount = 0;
  const prisma = {
    palletListDocument: {
      findUnique: jest.fn().mockResolvedValue(document),
    },
    deviceRuntime: {
      findMany: jest.fn().mockResolvedValue(printer ? [printer] : []),
      findUnique: jest.fn().mockResolvedValue(printer),
    },
    palletPrintJob,
    $transaction: jest.fn(async (callback: (transaction: unknown) => unknown) => {
      transactionCount += 1;
      if (options.finalizationError && transactionCount === 2) throw options.finalizationError;
      return callback({
        palletListDocument: {
          findUnique: jest.fn().mockResolvedValue(lockedDocument),
        },
        palletPrintJob,
        $queryRaw: jest.fn().mockResolvedValue([{ id: DOCUMENT.id }]),
      });
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue({}) };
  const printerAdapter = {
    transport: options.adapterTransport ?? 'gateway',
    print: jest.fn().mockImplementation(async () => {
      if (options.printResult instanceof Error) throw options.printResult;
      return (
        options.printResult ?? {
          jobId: 'device-job-1',
          printerId: 'printer-1',
          status: 'printed',
          gatewayCommandId: 'gateway-command-1',
        }
      );
    }),
  };
  const renderer = {
    renderPalletLabel: jest.fn().mockReturnValue({
      png: Buffer.from('png'),
      bitmap: Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes, 0xaa),
    }),
  };
  const incidents = {
    signal: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
  };
  const palletTokens = {
    requireForDocument: jest
      .fn()
      .mockResolvedValue({ documentId: DOCUMENT.id, token: PALLET_TOKEN }),
  };
  const service = new PalletPrintService(
    prisma as never,
    audit as never,
    printerAdapter as never,
    renderer as never,
    palletTokens as never,
    incidents as never,
  );
  return { service, prisma, audit, printerAdapter, renderer, palletTokens, incidents, jobs };
}

const dto = (requestId = REQUEST_1, reason?: string) => ({
  printerId: READY_PRINTER.id,
  requestId,
  reason,
});

describe('PalletPrintService.listPrinters', () => {
  it('returns an explicit safe readiness projection without diagnostics', async () => {
    const { service, prisma } = setup();

    await expect(service.listPrinters(NOW)).resolves.toEqual([
      {
        id: 'printer-1',
        code: 'PRINTER-1',
        label: 'MERTECH TLP4',
        post: { id: 'post-1', code: 'POST-1', name: 'Складской пост' },
        status: 'ready',
        ready: true,
        unavailableReason: null,
      },
    ]);
    expect(prisma.deviceRuntime.findMany).toHaveBeenCalledWith({
      where: { kind: 'printer', postId: { not: null } },
      select: expect.not.objectContaining({ rawPayload: true, parsedPayload: true }),
      orderBy: [{ post: { code: 'asc' } }, { code: 'asc' }, { id: 'asc' }],
    });
    expect(JSON.stringify(await service.listPrinters(NOW))).not.toMatch(
      /rawPayload|parsedPayload|agentTokenHash/,
    );
  });

  it('does not advertise direct printing while the backend uses the mock adapter', async () => {
    const { service } = setup({ adapterTransport: 'mock' });

    await expect(service.listPrinters(NOW)).resolves.toEqual([
      expect.objectContaining({
        id: 'printer-1',
        ready: false,
        unavailableReason: 'Печать через Device Gateway не включена на сервере',
      }),
    ]);
  });
});

describe('PalletPrintService.print', () => {
  it('rejects a direct request instead of returning fake success from the mock adapter', async () => {
    const { service, printerAdapter } = setup({ adapterTransport: 'mock' });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WAREHOUSE_GATEWAY_PRINT_DISABLED' }),
    });
    expect(printerAdapter.print).not.toHaveBeenCalled();
  });

  it('revalidates annulment under the document lock and never calls the printer after void wins', async () => {
    const voidedAt = new Date('2026-08-07T12:00:01.000Z');
    const { service, printerAdapter, palletTokens, jobs, audit } = setup({
      document: { ...DOCUMENT, voidedAt: null },
      lockedDocument: { ...DOCUMENT, voidedAt },
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: {
        code: 'PALLET_PRINT_DOCUMENT_VOIDED',
        documentId: DOCUMENT.id,
      },
    });

    expect(jobs).toHaveLength(0);
    expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
    expect(printerAdapter.print).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns the same safe void conflict when a prior print request is replayed after annulment', async () => {
    const document = { ...DOCUMENT, voidedAt: null as Date | null };
    const { service, printerAdapter, jobs } = setup({ document });
    await service.print(ACTOR, DOCUMENT.id, dto());
    document.voidedAt = new Date('2026-08-07T12:00:01.000Z');

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: {
        code: 'PALLET_PRINT_DOCUMENT_VOIDED',
        documentId: DOCUMENT.id,
      },
    });

    expect(jobs).toHaveLength(1);
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
  });

  it('does not create a reprint job for an annulled document', async () => {
    const document = { ...DOCUMENT, voidedAt: null as Date | null };
    const { service, printerAdapter, jobs } = setup({ document });
    await service.print(ACTOR, DOCUMENT.id, dto());
    document.voidedAt = new Date('2026-08-07T12:00:01.000Z');

    await expect(
      service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2, 'Повреждена при наклейке')),
    ).rejects.toMatchObject({
      response: {
        code: 'PALLET_PRINT_DOCUMENT_VOIDED',
        documentId: DOCUMENT.id,
      },
    });

    expect(jobs).toHaveLength(1);
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
  });

  it('claims, renders and submits exactly one fixed pallet label with safe audit facts', async () => {
    const { service, printerAdapter, audit, renderer, palletTokens, incidents, jobs } = setup();

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).resolves.toEqual({
      id: 'print-job-1',
      requestId: REQUEST_1,
      printerId: 'printer-1',
      status: 'submitted',
      gatewayCommandId: 'gateway-command-1',
      message: 'Задание отправлено',
    });
    expect(palletTokens.requireForDocument).toHaveBeenCalledWith(DOCUMENT.id);
    expect(renderer.renderPalletLabel).toHaveBeenCalledWith(
      DOCUMENT.payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
    expect(printerAdapter.print).toHaveBeenCalledWith(
      { deviceId: 'printer-1', expectedPostId: 'post-1', expectedKind: 'printer' },
      {
        kind: 'pallet_label',
        documentId: DOCUMENT.id,
        templateVersion: PALLET_LABEL_PROFILE.templateVersion,
        widthMm: PALLET_LABEL_PROFILE.widthMm,
        heightMm: PALLET_LABEL_PROFILE.heightMm,
        dpi: PALLET_LABEL_PROFILE.dpi,
        widthDots: PALLET_LABEL_PROFILE.widthDots,
        heightDots: PALLET_LABEL_PROFILE.heightDots,
        bitmapBase64: Buffer.alloc(PALLET_LABEL_PROFILE.bitmapBytes, 0xaa).toString('base64'),
        copies: 1,
      },
    );
    expect(jobs[0]).toMatchObject({
      status: 'submitted',
      gatewayCommandId: 'gateway-command-1',
    });
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_submitted',
    ]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('bitmapBase64');
    expect(incidents.resolve).toHaveBeenCalledWith(
      'device:printer-1:connection',
      expect.any(String),
    );
    expect(incidents.resolve).not.toHaveBeenCalledWith(
      'gateway:post:post-1:command:print_delivery_unknown',
      expect.any(String),
    );
    expect(incidents.resolve).toHaveBeenCalledWith(
      'gateway:post:post-1:liveness',
      expect.any(String),
    );
  });

  it('prints the compact profile owned by an immutable snapshot', async () => {
    const compactDocument = {
      ...DOCUMENT,
      payload: {
        ...DOCUMENT.payload,
        templateVersion: 'pallet-100x150-compact-v2' as const,
        label: {
          ...DOCUMENT.payload.label,
          templateVersion: 'pallet-100x150-compact-v2' as const,
        },
      },
    };
    const { service, renderer, printerAdapter } = setup({ document: compactDocument });

    await service.print(ACTOR, DOCUMENT.id, dto());

    expect(renderer.renderPalletLabel).toHaveBeenCalledWith(
      compactDocument.payload.label,
      PALLET_TOKEN,
      'pallet-100x150-compact-v2',
    );
    expect(printerAdapter.print).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ templateVersion: 'pallet-100x150-compact-v2' }),
    );
  });

  it.each([
    'pallet-100x100-square-v4',
    'pallet-100x100-safe-v5',
    'pallet-100x100-extended-v6',
    'pallet-100x100-configurable-v7',
  ] as const)(
    'rejects browser-only %s before lookup, claim, render or gateway side effects',
    async (profile) => {
      const squareDocument = {
        ...DOCUMENT,
        payload: {
          ...DOCUMENT.payload,
          templateVersion: profile,
          label: {
            ...DOCUMENT.payload.label,
            templateVersion: profile,
            rollCodes: ['ROLL-1'],
          },
        },
      };
      const { service, prisma, renderer, printerAdapter, palletTokens, audit, incidents, jobs } =
        setup({ document: squareDocument });

      await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
        status: 409,
        response: { code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' },
      });

      expect(prisma.palletPrintJob.findUnique).not.toHaveBeenCalled();
      expect(prisma.deviceRuntime.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(renderer.renderPalletLabel).not.toHaveBeenCalled();
      expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
      expect(printerAdapter.print).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
      expect(incidents.signal).not.toHaveBeenCalled();
      expect(incidents.resolve).not.toHaveBeenCalled();
      expect(jobs).toHaveLength(0);
    },
  );

  it.each([
    ['missing payload profile', { ...DOCUMENT.payload, templateVersion: undefined }],
    [
      'missing label profile',
      {
        ...DOCUMENT.payload,
        label: { ...DOCUMENT.payload.label, templateVersion: undefined },
      },
    ],
    [
      'mismatched profiles',
      {
        ...DOCUMENT.payload,
        label: {
          ...DOCUMENT.payload.label,
          templateVersion: 'pallet-100x150-compact-v2',
        },
      },
    ],
    [
      'unknown profiles',
      {
        ...DOCUMENT.payload,
        templateVersion: 'pallet-unknown',
        label: { ...DOCUMENT.payload.label, templateVersion: 'pallet-unknown' },
      },
    ],
  ])('rejects a %s before rendering or submitting', async (_case, corruptPayload) => {
    const { service, renderer, printerAdapter, palletTokens, jobs } = setup({
      document: { ...DOCUMENT, payload: corruptPayload },
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(palletTokens.requireForDocument).not.toHaveBeenCalled();
    expect(renderer.renderPalletLabel).not.toHaveBeenCalled();
    expect(printerAdapter.print).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('returns the same submitted job for the same requestId without a second print', async () => {
    const { service, printerAdapter, jobs } = setup();
    const first = await service.print(ACTOR, DOCUMENT.id, dto());
    const second = await service.print(ACTOR, DOCUMENT.id, dto());

    expect(second).toEqual(first);
    expect(jobs).toHaveLength(1);
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
  });

  it('does not close an earlier uncertain job after an unrelated successful job', async () => {
    const { service, incidents } = setup();

    await service.print(ACTOR, DOCUMENT.id, dto());

    expect(incidents.resolve).not.toHaveBeenCalledWith(
      'gateway:post:post-1:command:print_delivery_unknown',
      expect.any(String),
    );
  });

  it('allows only one adapter call when the same requestId races concurrently', async () => {
    const { service, printerAdapter, jobs } = setup();

    const results = await Promise.all([
      service.print(ACTOR, DOCUMENT.id, dto()),
      service.print(ACTOR, DOCUMENT.id, dto()),
    ]);

    expect(results.map((result) => result.id)).toEqual(['print-job-1', 'print-job-1']);
    expect(jobs).toHaveLength(1);
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
  });

  it('rejects a new request after submission unless a reprint reason is supplied', async () => {
    const { service } = setup();
    await service.print(ACTOR, DOCUMENT.id, dto());

    await expect(service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('allows a later warehouse print after an ambiguous job is reconciled as failed', async () => {
    const { service, jobs, printerAdapter } = setup();
    jobs.push({
      id: 'reconciled-job-1',
      palletListDocumentId: DOCUMENT.id,
      requestId: REQUEST_1,
      printerId: READY_PRINTER.id,
      gatewayCommandId: 'gateway-command-unknown',
      status: 'failed',
      failureReason: 'admin_reconciled_not_printed',
      reason: null,
      replacesJobId: null,
      createdAt: new Date(NOW.getTime() - 1_000),
      completedAt: new Date(NOW.getTime() - 500),
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2))).resolves.toMatchObject({
      requestId: REQUEST_2,
      status: 'submitted',
    });
    expect(jobs).toHaveLength(2);
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
  });

  it('creates a replacement job and a reprint audit fact when a reason is supplied', async () => {
    const { service, jobs, audit, renderer, palletTokens } = setup();
    await service.print(ACTOR, DOCUMENT.id, dto());

    await service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2, 'Повреждена при наклейке'));

    expect(jobs).toHaveLength(2);
    expect(jobs[1]).toMatchObject({
      replacesJobId: 'print-job-1',
      reason: 'Повреждена при наклейке',
      status: 'submitted',
    });
    expect(audit.record.mock.calls.map(([event]) => event.type)).toContain(
      'audit:pallet_list_reprint_requested',
    );
    expect(palletTokens.requireForDocument).toHaveBeenNthCalledWith(1, DOCUMENT.id);
    expect(palletTokens.requireForDocument).toHaveBeenNthCalledWith(2, DOCUMENT.id);
    expect(renderer.renderPalletLabel).toHaveBeenNthCalledWith(
      1,
      DOCUMENT.payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(renderer.renderPalletLabel).toHaveBeenNthCalledWith(
      2,
      DOCUMENT.payload.label,
      PALLET_TOKEN,
      PALLET_LABEL_PROFILE.templateVersion,
    );
    expect(JSON.stringify(DOCUMENT.payload)).not.toContain(PALLET_TOKEN);
  });

  it('rejects reusing an idempotency key for a different printer or document', async () => {
    const { service, prisma } = setup();
    await service.print(ACTOR, DOCUMENT.id, dto());
    prisma.deviceRuntime.findUnique.mockResolvedValue({ ...READY_PRINTER, id: 'printer-2' });

    await expect(
      service.print(ACTOR, DOCUMENT.id, { ...dto(), printerId: 'printer-2' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns 404 for a missing document or printer', async () => {
    const missingDocument = setup({ document: null });
    await expect(missingDocument.service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const missingPrinter = setup({ printer: null });
    await expect(missingPrinter.service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(missingDocument.incidents.signal).not.toHaveBeenCalled();
    expect(missingPrinter.incidents.signal).not.toHaveBeenCalled();
  });

  it('returns 409 when the immutable document snapshot is not print-ready', async () => {
    const { service } = setup({
      document: { ...DOCUMENT, payload: { ...DOCUMENT.payload, printReady: false } },
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it.each([
    ['disabled', { isEnabled: false }, null],
    ['unbound', { post: null }, 'device:printer-1:connection'],
    ['device offline', { status: 'offline' }, 'device:printer-1:connection'],
    [
      'post offline',
      { post: { ...READY_PRINTER.post, agentStatus: 'offline' } },
      'gateway:post:post-1:liveness',
    ],
    [
      'stale heartbeat',
      { post: { ...READY_PRINTER.post, lastSeenAt: new Date(NOW.getTime() - 91_000) } },
      'gateway:post:post-1:liveness',
    ],
  ])('returns 503 for an unavailable printer: %s', async (_label, patch, fingerprint) => {
    const { service, incidents } = setup({
      printer: { ...READY_PRINTER, ...patch } as typeof READY_PRINTER,
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto(), NOW)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    if (fingerprint) {
      expect(incidents.signal).toHaveBeenCalledWith(expect.objectContaining({ fingerprint }));
    } else {
      expect(incidents.signal).not.toHaveBeenCalled();
    }
  });

  it('marks an explicit adapter failure terminal with only a bounded safe reason', async () => {
    const result = {
      jobId: '',
      printerId: 'printer-1',
      status: 'failed' as const,
      failureReason: 'tcp 9100 unreachable\nbitmapBase64=secret',
    };
    const { service, jobs, audit, incidents } = setup({ printResult: result });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(jobs[0]).toMatchObject({ status: 'failed', completedAt: expect.any(Date) });
    expect(jobs[0].failureReason).not.toMatch(/[\r\n]/);
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_failed',
    ]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('bitmapBase64');
    expect(incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:printer-1:connection',
        targetId: 'printer-1',
      }),
    );
    expect(JSON.stringify(incidents.signal.mock.calls)).not.toMatch(
      /tcp|9100|bitmap|secret|payload|stack/i,
    );
  });

  it('treats a rejected printer adapter call as delivery_unknown without leaking its error', async () => {
    const { service, jobs, audit, incidents } = setup({
      printResult: new Error('gateway timed out with bitmapBase64=secret'),
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(jobs[0]).toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'printer_adapter_rejection_outcome_unknown',
      completedAt: expect.any(Date),
    });
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_delivery_unknown',
    ]);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('bitmapBase64');
    expect(incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-1:command:print_delivery_unknown',
        targetId: 'post-1',
      }),
    );
    expect(incidents.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'device:printer-1:connection' }),
    );
    expect(JSON.stringify(incidents.signal.mock.calls)).not.toMatch(
      /gateway timed out|bitmap|secret|payload|stack/i,
    );
  });

  it('keeps a label rendering error out of device incident ownership', async () => {
    const failed = setup();
    failed.renderer.renderPalletLabel.mockImplementation(() => {
      throw new Error('bitmapBase64=secret renderer stack');
    });

    await expect(failed.service.print(ACTOR, DOCUMENT.id, dto())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    expect(failed.jobs[0]).toMatchObject({ status: 'failed' });
    expect(failed.printerAdapter.print).not.toHaveBeenCalled();
    expect(failed.incidents.signal).not.toHaveBeenCalled();
    expect(failed.incidents.resolve).not.toHaveBeenCalled();
  });

  it('keeps an acknowledged uncertain print non-retryable and requires admin review', async () => {
    const { service, jobs, audit, printerAdapter } = setup({
      printResult: {
        jobId: 'device-job-unknown',
        printerId: 'printer-1',
        status: 'delivery_unknown',
        failureReason: 'printer_delivery_outcome_unknown',
        gatewayCommandId: 'gateway-command-unknown',
      },
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(jobs[0]).toMatchObject({
      status: 'delivery_unknown',
      gatewayCommandId: 'gateway-command-unknown',
      failureReason: 'printer_delivery_outcome_unknown',
      completedAt: expect.any(Date),
    });
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_delivery_unknown',
    ]);

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    await expect(
      service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2, 'Не повторять без проверки')),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(printerAdapter.print).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
  });

  it('marks an acknowledged print unknown when durable finalization fails', async () => {
    const { service, jobs, audit } = setup({
      finalizationError: new Error('database response lost after printer acknowledgement'),
    });

    await expect(service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(jobs[0]).toMatchObject({
      status: 'delivery_unknown',
      gatewayCommandId: 'gateway-command-1',
      failureReason: 'pallet_finalization_conflict_after_acknowledged_print',
      completedAt: expect.any(Date),
    });
    expect(audit.record.mock.calls.map(([event]) => event.type)).toEqual([
      'audit:pallet_list_print_requested',
      'audit:pallet_list_print_delivery_unknown',
    ]);
  });

  it('marks an adapter result outside the printer status contract delivery_unknown', async () => {
    const malformed = setup();
    malformed.printerAdapter.print.mockResolvedValue({
      jobId: 'malformed-job',
      printerId: 'printer-1',
      status: 'unexpected_runtime_status',
    });

    await expect(malformed.service.print(ACTOR, DOCUMENT.id, dto())).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_DELIVERY_UNKNOWN' }),
    });
    expect(malformed.jobs[0]).toMatchObject({
      status: 'delivery_unknown',
      failureReason: 'printer_result_status_unknown',
    });
  });

  it('does not submit a new-key print while the first device call is still in flight', async () => {
    const pending = setup();
    let resolvePrint: ((result: unknown) => void) | undefined;
    pending.printerAdapter.print.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrint = resolve;
        }),
    );

    const first = pending.service.print(ACTOR, DOCUMENT.id, dto());
    while (!resolvePrint) await Promise.resolve();

    await expect(pending.service.print(ACTOR, DOCUMENT.id, dto())).resolves.toMatchObject({
      requestId: REQUEST_1,
      status: 'queued',
    });
    await expect(pending.service.print(ACTOR, DOCUMENT.id, dto(REQUEST_2))).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_PRINT_IN_PROGRESS' }),
    });
    expect(pending.printerAdapter.print).toHaveBeenCalledTimes(1);

    resolvePrint?.({
      jobId: 'device-job-1',
      printerId: 'printer-1',
      status: 'printed',
      gatewayCommandId: 'gateway-command-1',
    });
    await expect(first).resolves.toMatchObject({ status: 'submitted' });
  });
});

describe('WarehouseController pallet print response', () => {
  it('returns HTTP 202 only when an idempotent job is still queued', async () => {
    const result = {
      id: 'print-job-1',
      requestId: REQUEST_1,
      printerId: 'printer-1',
      status: 'queued' as const,
      gatewayCommandId: null,
      message: 'Задание уже выполняется' as const,
    };
    const palletPrint = { print: jest.fn().mockResolvedValue(result) };
    const response = { status: jest.fn() };
    const controller = new WarehouseController(
      {} as never,
      {} as never,
      {} as never,
      palletPrint as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      controller.printPalletList(
        { ...ACTOR, capabilities: [] },
        DOCUMENT.id,
        dto(),
        response as never,
      ),
    ).resolves.toEqual(result);
    expect(response.status).toHaveBeenCalledWith(202);
  });
});
