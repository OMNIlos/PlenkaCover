import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PRINTER_ADAPTER, type PrinterAdapter } from '../src/integrations/printer/printer.adapter';
import { PalletPrintService } from '../src/modules/warehouse/pallet-print.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { enableSimulatedDevices } from './simulated-device-fixture';

type Fixture = Awaited<ReturnType<typeof createAcceptedTask>>;
type SealedFixture = Fixture & {
  documentId: string;
  palletId: string;
  printJobId: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

const IMMUTABLE_PALLET_EVIDENCE_SELECT = {
  acceptanceTaskId: true,
  createdAt: true,
  fieldSetStatus: true,
  format: true,
  generatedByRole: true,
  id: true,
  orderIds: true,
  origin: true,
  palletId: true,
  payload: true,
  rollIds: true,
  scanToken: { select: { createdAt: true, documentId: true, token: true } },
  warehousePalletId: true,
  printJobs: {
    orderBy: { id: 'asc' as const },
    select: {
      completedAt: true,
      createdAt: true,
      failureReason: true,
      gatewayCommandId: true,
      id: true,
      palletListDocumentId: true,
      printerId: true,
      reason: true,
      replacesJobId: true,
      requestId: true,
      status: true,
    },
  },
  printReconciliations: {
    orderBy: { id: 'asc' as const },
    select: {
      actorId: true,
      createdAt: true,
      id: true,
      operationKey: true,
      outcome: true,
      palletListDocumentId: true,
      printJobId: true,
      reason: true,
      result: true,
    },
  },
} as const;

async function createAcceptedTask(prisma: PrismaService, label: string, rollCount = 2) {
  const suffix = `${label}-${randomUUID().replaceAll('-', '')}`;
  const order = await prisma.commercialOrder.create({
    data: {
      orderNumber: `PALLET-E2E-${suffix}`,
      creatorRole: 'commercial',
    },
    select: { id: true, orderNumber: true },
  });
  const task = await prisma.warehouseAcceptanceTask.create({
    data: {
      mode: 'receiving',
      status: 'open',
      operationCode: `ПР-PALLET-${suffix}`,
      orderId: order.id,
    },
    select: { id: true },
  });
  const rows = await Promise.all(
    Array.from({ length: rollCount }, async (_value, index) =>
      prisma.scanRow.create({
        data: {
          taskId: task.id,
          rollCode: `PALLET-E2E-ROLL-${index + 1}-${suffix}`,
          fromOrderId: order.id,
          scanStatus: 'accepted',
          lastScanAt: new Date(Date.UTC(2026, 7, 7, 8, index, 0)),
          scannedByName: 'E2E Warehouse',
        },
        select: { id: true, rollCode: true },
      }),
    ),
  );
  return { order, rows, suffix, task };
}

describe('explicit pallet composition and annulment (e2e, HTTP + real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let warehouseAuth: Record<string, string>;
  let warehouseActorId: string;
  let warehouseSessionId: string;
  let printerId: string;
  let printerAdapter: PrinterAdapter;
  let palletPrint: PalletPrintService;
  let restoreDevices: (() => Promise<void>) | null = null;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'on',
    DEVICE_GATEWAY_PRINTER: 'on',
    GATEWAY_SIMULATOR: 'on',
  } as const;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }
    // Env-backed adapter selection happens while AppModule is imported.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    printerAdapter = moduleRef.get(PRINTER_ADAPTER);
    palletPrint = moduleRef.get(PalletPrintService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    restoreDevices = await enableSimulatedDevices(prisma, ['dev-printer-1']);
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('warehouse'), password: e2eSeedPassword() })
      .expect(201);
    warehouseAuth = { Authorization: `Bearer ${login.body.token as string}` };
    warehouseActorId = login.body.user.id as string;
    warehouseSessionId = (
      await prisma.session.findFirstOrThrow({
        where: { userId: warehouseActorId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      })
    ).id;
    const printers = await request(app.getHttpServer())
      .get('/api/warehouse/printers')
      .set(warehouseAuth)
      .expect(200);
    const printer = (
      printers.body as Array<{ id: string; post: { code: string }; ready: boolean }>
    ).find((candidate) => candidate.ready && candidate.post.code === 'POST-1');
    if (!printer) throw new Error('POST-1 simulated pallet printer is not ready');
    printerId = printer.id;
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'pallet lifecycle simulated devices',
          run: async () => restoreDevices?.(),
        },
        { label: 'pallet lifecycle application', run: async () => app?.close() },
        {
          label: 'pallet lifecycle environment',
          run: () => {
            for (const [key, value] of Object.entries(savedEnv)) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
          },
        },
      ],
    );
  });

  const select = (fixture: Fixture, rowId: string, operationKey: string, selected = true) =>
    request(app.getHttpServer())
      .put(`/api/warehouse/intake/${fixture.task.id}/pallet-selection/${rowId}`)
      .set(warehouseAuth)
      .send({ operationKey, selected });

  const voidPallet = (
    fixture: Pick<Fixture, 'task'>,
    palletId: string,
    operationKey: string,
    reasonCode: 'wrong_composition' | 'print_problem' | 'other' = 'wrong_composition',
    note = 'E2E verified annulment',
  ) =>
    request(app.getHttpServer())
      .post(`/api/warehouse/intake/${fixture.task.id}/pallets/${palletId}/void`)
      .set(warehouseAuth)
      .send({
        operationKey,
        reasonCode,
        note,
      });

  const seal = async (fixture: Fixture, rowIndexes = [0]): Promise<SealedFixture> => {
    for (const rowIndex of rowIndexes) {
      await select(fixture, fixture.rows[rowIndex].id, randomUUID()).expect(200);
    }
    const closeRequestId = randomUUID();
    const response = await request(app.getHttpServer())
      .post(`/api/warehouse/intake/${fixture.task.id}/pallets/current/close-and-print`)
      .set(warehouseAuth)
      .send({ printerId, requestId: closeRequestId })
      .expect(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        pallet: expect.objectContaining({ status: 'sealed' }),
        document: expect.objectContaining({
          documentStatus: 'sealed',
          printStatus: 'submitted',
        }),
        printJob: expect.objectContaining({ status: 'submitted' }),
      }),
    );
    return {
      ...fixture,
      documentId: response.body.document.id as string,
      palletId: response.body.pallet.id as string,
      printJobId: response.body.printJob.id as string,
    };
  };

  const recordReceivingEvidence = async (fixture: Fixture) => {
    await Promise.all(
      fixture.rows.map((row) => {
        const operationId = `pallet-close-evidence-${randomUUID()}`;
        return prisma.warehouseOperation.create({
          data: {
            id: operationId,
            operationKey: randomUUID(),
            kind: 'receiving_scan',
            status: 'succeeded',
            taskId: fixture.task.id,
            scanRowId: row.id,
            rollCode: row.rollCode,
            actorId: warehouseActorId,
            sessionId: warehouseSessionId,
            captureChannel: 'warehouse_role_action',
            requestFingerprint: 'e'.repeat(64),
            safeResult: {
              operationId,
              taskId: fixture.task.id,
              rollCode: row.rollCode,
              mode: 'receiving',
              scanStatus: 'accepted',
            },
            httpStatus: 200,
            completedAt: new Date(),
          },
        });
      }),
    );
  };

  it('selects an accepted row and replays the exact operation while rejecting a new fingerprint', async () => {
    const fixture = await createAcceptedTask(prisma, 'replay', 1);
    const operationKey = randomUUID();

    const first = await select(fixture, fixture.rows[0].id, operationKey).expect(200);
    const replay = await select(fixture, fixture.rows[0].id, operationKey).expect(200);
    const conflict = await select(fixture, fixture.rows[0].id, operationKey, false).expect(409);

    expect(replay.body).toEqual(first.body);
    expect(conflict.body).toMatchObject({
      code: 'WAREHOUSE_PALLET_SELECTION_OPERATION_CONFLICT',
    });
    await expect(prisma.warehousePalletCommand.count({ where: { operationKey } })).resolves.toBe(1);
    await expect(
      prisma.warehousePalletItem.count({
        where: { scanRowId: fixture.rows[0].id, releasedAt: null },
      }),
    ).resolves.toBe(1);
  });

  it('linearizes same-row and sibling-row selection races without duplicate or split membership', async () => {
    const fixture = await createAcceptedTask(prisma, 'selection-race', 3);
    const sameRow = await Promise.all([
      select(fixture, fixture.rows[0].id, randomUUID()).expect(200),
      select(fixture, fixture.rows[0].id, randomUUID()).expect(200),
    ]);
    expect(sameRow[0].body.activePallet.id).toBe(sameRow[1].body.activePallet.id);

    await Promise.all([
      select(fixture, fixture.rows[1].id, randomUUID()).expect(200),
      select(fixture, fixture.rows[2].id, randomUUID()).expect(200),
    ]);

    const openPallets = await prisma.warehousePallet.findMany({
      where: { taskId: fixture.task.id, status: 'open' },
      include: {
        items: {
          where: { releasedAt: null },
          orderBy: { position: 'asc' },
          select: { position: true, scanRowId: true },
        },
      },
    });
    expect(openPallets).toHaveLength(1);
    expect(openPallets[0].items.map((item) => item.position)).toEqual([1, 2, 3]);
    expect(openPallets[0].items.map((item) => item.scanRowId).sort()).toEqual(
      fixture.rows.map((row) => row.id).sort(),
    );
    const memberships = await prisma.warehousePalletItem.groupBy({
      by: ['scanRowId'],
      where: { scanRowId: { in: fixture.rows.map((row) => row.id) }, releasedAt: null },
      _count: { _all: true },
    });
    expect(memberships).toHaveLength(3);
    expect(memberships.every((membership) => membership._count._all === 1)).toBe(true);
  });

  it('locks every selected row after sealing and exposes the server-owned lock projection', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'sealed-lock', 2), [0, 1]);

    const locked = await select(sealed, sealed.rows[0].id, randomUUID(), false).expect(409);
    expect(locked.body).toMatchObject({
      code: 'WAREHOUSE_PALLET_SELECTION_LOCKED',
      palletId: sealed.palletId,
      palletStatus: 'sealed',
    });

    const intake = await request(app.getHttpServer())
      .get('/api/warehouse/intake')
      .set(warehouseAuth)
      .expect(200);
    const task = (
      intake.body.tasks as Array<{
        taskId: string;
        rolls: Array<{
          scanRowId: string;
          palletSelection: {
            locked: boolean;
            palletId: string | null;
            selected: boolean;
          };
        }>;
      }>
    ).find((candidate) => candidate.taskId === sealed.task.id);
    expect(task?.rolls.map((roll) => roll.palletSelection)).toEqual([
      { locked: true, palletId: sealed.palletId, palletCode: expect.any(String), selected: true },
      { locked: true, palletId: sealed.palletId, palletCode: expect.any(String), selected: true },
    ]);
  });

  it('voids a sealed pallet without mutating its document, QR token or print evidence', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'void-evidence', 2), [0, 1]);
    const before = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: sealed.documentId },
      select: IMMUTABLE_PALLET_EVIDENCE_SELECT,
    });
    expect(before.printJobs).toHaveLength(1);
    expect(before.printJobs[0]?.id).toBe(sealed.printJobId);
    expect(before.printReconciliations).toEqual([]);
    const operationKey = randomUUID();

    const response = await voidPallet(sealed, sealed.palletId, operationKey).expect(200);
    expect(response.body).toMatchObject({
      id: sealed.documentId,
      warehousePalletId: sealed.palletId,
      documentStatus: 'voided',
    });

    const after = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: sealed.documentId },
      select: IMMUTABLE_PALLET_EVIDENCE_SELECT,
    });
    expect(after).toEqual(before);
    expect(before.scanToken?.token).toMatch(/^plt_[0-9a-f]{64}$/u);

    const memberships = await prisma.warehousePalletItem.findMany({
      where: { palletId: sealed.palletId },
      orderBy: { position: 'asc' },
      select: { releasedAt: true, releaseReason: true, scanRowId: true },
    });
    expect(memberships).toHaveLength(2);
    expect(
      memberships.every(
        (membership) =>
          membership.releasedAt instanceof Date && membership.releaseReason === 'pallet_voided',
      ),
    ).toBe(true);
    await expect(
      prisma.warehousePalletItem.count({
        where: { palletId: sealed.palletId, releasedAt: null },
      }),
    ).resolves.toBe(0);

    const audit = await prisma.domainEvent.findMany({
      where: {
        actorId: warehouseActorId,
        OR: [
          { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
          { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(audit).toHaveLength(2);
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: warehouseActorId,
          objectId: sealed.palletId,
          type: 'audit:warehouse_pallet_voided',
          reason: 'wrong_composition',
          oldValue: { status: 'sealed' },
          newValue: { status: 'voided' },
          detail: expect.objectContaining({
            taskId: sealed.task.id,
            palletId: sealed.palletId,
            documentId: sealed.documentId,
            releasedRollCount: 2,
          }),
        }),
        expect.objectContaining({
          actorId: warehouseActorId,
          objectId: sealed.documentId,
          type: 'audit:pallet_list_voided',
          reason: 'wrong_composition',
          oldValue: { documentStatus: 'sealed' },
          newValue: { documentStatus: 'voided' },
          detail: expect.objectContaining({
            taskId: sealed.task.id,
            warehousePalletId: sealed.palletId,
            releasedRollCount: 2,
          }),
        }),
      ]),
    );

    const inspected = await request(app.getHttpServer())
      .post('/api/warehouse/qr/inspect')
      .set(warehouseAuth)
      .send({ payload: before.scanToken!.token })
      .expect(200);
    expect(inspected.body).toMatchObject({
      kind: 'pallet',
      pallet: {
        documentStatus: 'voided',
        status: 'voided',
      },
    });
    expect(JSON.stringify(inspected.body)).not.toContain(before.scanToken!.token);
    expect(JSON.stringify(inspected.body)).not.toContain('E2E verified annulment');

    await expect(
      prisma.palletScanToken.update({
        where: { documentId: sealed.documentId },
        data: {
          token: `plt_${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`,
        },
      }),
    ).rejects.toThrow(/pallet scan tokens are immutable/u);
    await expect(
      prisma.palletScanToken.delete({ where: { documentId: sealed.documentId } }),
    ).rejects.toThrow(/pallet scan tokens are immutable/u);
    await expect(
      prisma.palletListDocument.delete({ where: { id: sealed.documentId } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('closes an intake and then rejects pallet annulment without mutation, command or audit', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'closed-immutable', 1), [0]);
    await recordReceivingEvidence(sealed);
    await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${sealed.task.id}/close`)
      .set(warehouseAuth)
      .send({ mode: 'full' })
      .expect(201);

    const operationKey = randomUUID();
    const before = await prisma.warehousePallet.findUniqueOrThrow({
      where: { id: sealed.palletId },
      include: {
        items: { orderBy: { position: 'asc' } },
        document: true,
      },
    });
    const voidAuditsBefore = await prisma.domainEvent.count({
      where: {
        OR: [
          { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
          { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
        ],
      },
    });

    const rejected = await voidPallet(sealed, sealed.palletId, operationKey).expect(409);
    expect(rejected.body).toMatchObject({ code: 'WAREHOUSE_TASK_CLOSED' });
    const after = await prisma.warehousePallet.findUniqueOrThrow({
      where: { id: sealed.palletId },
      include: {
        items: { orderBy: { position: 'asc' } },
        document: true,
      },
    });
    expect(after).toEqual(before);
    await expect(prisma.warehousePalletCommand.count({ where: { operationKey } })).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [
            { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
            { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
          ],
        },
      }),
    ).resolves.toBe(voidAuditsBefore);
  });

  it('rejects close after pallet annulment and preserves the reloadable nonclosed state without close audit', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'void-before-close', 1), [0]);
    await recordReceivingEvidence(sealed);
    const operationKey = randomUUID();

    await voidPallet(sealed, sealed.palletId, operationKey).expect(200);
    const rejected = await request(app.getHttpServer())
      .post(`/api/warehouse/tasks/${sealed.task.id}/close`)
      .set(warehouseAuth)
      .send({ mode: 'full' })
      .expect(409);
    expect(rejected.body).toMatchObject({
      code: 'WAREHOUSE_TASK_PALLET_EVIDENCE_INCOMPLETE',
      scanRowId: sealed.rows[0].id,
      rollCode: sealed.rows[0].rollCode,
    });

    const reloaded = await request(app.getHttpServer())
      .get(`/api/warehouse/tasks/${sealed.task.id}`)
      .set(warehouseAuth)
      .expect(200);
    expect(reloaded.body).toMatchObject({ id: sealed.task.id, status: 'open' });
    await expect(
      prisma.warehousePallet.findUniqueOrThrow({
        where: { id: sealed.palletId },
        select: {
          status: true,
          voidedAt: true,
          items: { select: { releasedAt: true, releaseReason: true } },
          document: { select: { voidedAt: true } },
        },
      }),
    ).resolves.toEqual({
      status: 'voided',
      voidedAt: expect.any(Date),
      items: [{ releasedAt: expect.any(Date), releaseReason: 'pallet_voided' }],
      document: { voidedAt: expect.any(Date) },
    });
    await expect(
      prisma.domainEvent.count({
        where: { objectId: sealed.task.id, type: 'audit:warehouse_acceptance_task_closed' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [
            { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
            { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
          ],
        },
      }),
    ).resolves.toBe(2);
  });

  it('serializes concurrent intake close and pallet annulment on the task row', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'close-void-race', 1), [0]);
    await recordReceivingEvidence(sealed);
    const operationKey = randomUUID();

    const [closed, voided] = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/warehouse/tasks/${sealed.task.id}/close`)
        .set(warehouseAuth)
        .send({ mode: 'full' }),
      voidPallet(sealed, sealed.palletId, operationKey),
    ]);
    expect([201, 409]).toContain(closed.status);
    expect([200, 409]).toContain(voided.status);
    expect([
      [201, 409],
      [409, 200],
    ]).toContainEqual([closed.status, voided.status]);

    const pallet = await prisma.warehousePallet.findUniqueOrThrow({
      where: { id: sealed.palletId },
      include: {
        items: { select: { releasedAt: true, releaseReason: true } },
        document: { select: { voidedAt: true } },
      },
    });
    const [commands, voidAudits] = await Promise.all([
      prisma.warehousePalletCommand.count({ where: { operationKey, kind: 'void_pallet' } }),
      prisma.domainEvent.count({
        where: {
          OR: [
            { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
            { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
          ],
        },
      }),
    ]);
    const reloaded = await request(app.getHttpServer())
      .get(`/api/warehouse/tasks/${sealed.task.id}`)
      .set(warehouseAuth)
      .expect(200);
    const closeAudits = await prisma.domainEvent.count({
      where: { objectId: sealed.task.id, type: 'audit:warehouse_acceptance_task_closed' },
    });
    if (closed.status === 201) {
      expect(closed.body).toMatchObject({ id: sealed.task.id, status: 'closed' });
      expect(voided.body).toMatchObject({ code: 'WAREHOUSE_TASK_CLOSED' });
      expect(reloaded.body).toMatchObject({ id: sealed.task.id, status: 'closed' });
      expect(pallet).toMatchObject({
        status: 'sealed',
        voidedAt: null,
        items: [{ releasedAt: null, releaseReason: null }],
        document: { voidedAt: null },
      });
      expect({ commands, voidAudits }).toEqual({ commands: 0, voidAudits: 0 });
      expect(closeAudits).toBe(1);
    } else {
      expect(closed.body).toMatchObject({
        code: 'WAREHOUSE_TASK_PALLET_EVIDENCE_INCOMPLETE',
        scanRowId: sealed.rows[0].id,
        rollCode: sealed.rows[0].rollCode,
      });
      expect(voided.body).toMatchObject({
        warehousePalletId: sealed.palletId,
        documentStatus: 'voided',
      });
      expect(reloaded.body).toMatchObject({ id: sealed.task.id, status: 'open' });
      expect(pallet).toMatchObject({
        status: 'voided',
        voidedAt: expect.any(Date),
        items: [{ releasedAt: expect.any(Date), releaseReason: 'pallet_voided' }],
        document: { voidedAt: expect.any(Date) },
      });
      expect({ commands, voidAudits }).toEqual({ commands: 1, voidAudits: 2 });
      expect(closeAudits).toBe(0);
    }
  });

  it('accepts a 500-character void note and rejects 501 characters before any database mutation', async () => {
    const accepted = await seal(await createAcceptedTask(prisma, 'void-note-500', 1), [0]);
    await voidPallet(accepted, accepted.palletId, randomUUID(), 'other', 'x'.repeat(500)).expect(
      200,
    );
    await expect(
      prisma.palletListDocument.findUniqueOrThrow({
        where: { id: accepted.documentId },
        select: { voidNote: true },
      }),
    ).resolves.toEqual({ voidNote: 'x'.repeat(500) });

    const rejected = await seal(await createAcceptedTask(prisma, 'void-note-501', 1), [0]);
    const operationKey = randomUUID();
    const response = await voidPallet(
      rejected,
      rejected.palletId,
      operationKey,
      'other',
      'x'.repeat(501),
    ).expect(400);
    expect(response.body).toMatchObject({
      error: 'Bad Request',
      statusCode: 400,
    });
    expect(JSON.stringify(response.body)).not.toMatch(/P20|constraint|pallet_list_documents/u);
    await expect(prisma.warehousePalletCommand.count({ where: { operationKey } })).resolves.toBe(0);
    await expect(
      prisma.warehousePallet.findUniqueOrThrow({
        where: { id: rejected.palletId },
        select: { status: true, voidedAt: true },
      }),
    ).resolves.toEqual({ status: 'sealed', voidedAt: null });
    await expect(
      prisma.palletListDocument.findUniqueOrThrow({
        where: { id: rejected.documentId },
        select: { voidedAt: true, voidNote: true },
      }),
    ).resolves.toEqual({ voidedAt: null, voidNote: null });
  });

  it('lets a queued print claim win, blocks annulment, then voids only after the terminal outcome', async () => {
    const fixture = await createAcceptedTask(prisma, 'print-wins-void-race', 1);
    const selected = await select(fixture, fixture.rows[0].id, randomUUID()).expect(200);
    const palletId = selected.body.activePallet.id as string;
    const requestId = randomUUID();
    const operationKey = randomUUID();
    const adapterStarted = deferred<void>();
    const adapterResult = deferred<{
      jobId: string;
      printerId: string;
      status: 'printed';
      gatewayCommandId: string;
    }>();
    const printSpy = jest.spyOn(printerAdapter, 'print').mockImplementationOnce(async () => {
      adapterStarted.resolve();
      return adapterResult.promise;
    });

    const closePromise = request(app.getHttpServer())
      .post(`/api/warehouse/intake/${fixture.task.id}/pallets/current/close-and-print`)
      .set(warehouseAuth)
      .send({ printerId, requestId })
      .expect(200)
      .then((response) => response);

    try {
      await adapterStarted.promise;
      const blocked = await voidPallet(fixture, palletId, operationKey).expect(409);
      expect(blocked.body).toMatchObject({
        code: 'WAREHOUSE_PALLET_VOID_PRINT_IN_PROGRESS',
        printJobId: expect.any(String),
      });
      await expect(
        prisma.warehousePallet.findUniqueOrThrow({
          where: { id: palletId },
          select: {
            status: true,
            voidedAt: true,
            items: {
              where: { releasedAt: null },
              select: { scanRowId: true },
            },
            document: {
              select: {
                id: true,
                voidedAt: true,
                printJobs: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { id: true, status: true, completedAt: true },
                },
              },
            },
          },
        }),
      ).resolves.toEqual({
        status: 'sealed',
        voidedAt: null,
        items: [{ scanRowId: fixture.rows[0].id }],
        document: {
          id: expect.any(String),
          voidedAt: null,
          printJobs: [
            {
              id: blocked.body.printJobId as string,
              status: 'queued',
              completedAt: null,
            },
          ],
        },
      });
      await expect(prisma.warehousePalletCommand.count({ where: { operationKey } })).resolves.toBe(
        0,
      );

      adapterResult.resolve({
        jobId: 'e2e-print-winner',
        printerId,
        status: 'printed',
        gatewayCommandId: `e2e-gateway-${requestId}`,
      });
      const closed = await closePromise;
      expect(closed.body).toMatchObject({
        pallet: { id: palletId, status: 'sealed' },
        printJob: {
          id: blocked.body.printJobId as string,
          status: 'submitted',
        },
      });

      const voided = await voidPallet(fixture, palletId, operationKey).expect(200);
      const replay = await voidPallet(fixture, palletId, operationKey).expect(200);
      expect(replay.body).toEqual(voided.body);
      await expect(
        prisma.warehousePallet.findUniqueOrThrow({
          where: { id: palletId },
          select: {
            status: true,
            voidedAt: true,
            items: {
              select: { releasedAt: true, releaseReason: true },
            },
            document: {
              select: {
                voidedAt: true,
                printJobs: {
                  where: { id: blocked.body.printJobId as string },
                  select: { status: true },
                },
              },
            },
          },
        }),
      ).resolves.toEqual({
        status: 'voided',
        voidedAt: expect.any(Date),
        items: [{ releasedAt: expect.any(Date), releaseReason: 'pallet_voided' }],
        document: {
          voidedAt: expect.any(Date),
          printJobs: [{ status: 'submitted' }],
        },
      });
      await expect(
        prisma.warehousePalletItem.count({ where: { palletId, releasedAt: null } }),
      ).resolves.toBe(0);
      await expect(
        prisma.warehousePalletCommand.count({ where: { operationKey, kind: 'void_pallet' } }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            OR: [
              { objectId: palletId, type: 'audit:warehouse_pallet_voided' },
              { objectId: voided.body.id as string, type: 'audit:pallet_list_voided' },
            ],
          },
        }),
      ).resolves.toBe(2);
      expect(printSpy).toHaveBeenCalledTimes(1);
    } finally {
      adapterResult.resolve({
        jobId: 'e2e-print-winner',
        printerId,
        status: 'printed',
        gatewayCommandId: `e2e-gateway-${requestId}`,
      });
      printSpy.mockRestore();
    }
  });

  it('lets annulment win before the print claim and never calls the physical adapter', async () => {
    const fixture = await createAcceptedTask(prisma, 'void-wins-print-race', 1);
    const selected = await select(fixture, fixture.rows[0].id, randomUUID()).expect(200);
    const palletId = selected.body.activePallet.id as string;
    const requestId = randomUUID();
    const operationKey = randomUUID();
    const printStageReached = deferred<void>();
    const continuePrint = deferred<void>();
    const originalPrint = palletPrint.print.bind(palletPrint);
    const adapterSpy = jest.spyOn(printerAdapter, 'print');
    const serviceSpy = jest.spyOn(palletPrint, 'print').mockImplementationOnce(async (...args) => {
      printStageReached.resolve();
      await continuePrint.promise;
      return originalPrint(...args);
    });
    const closePromise = request(app.getHttpServer())
      .post(`/api/warehouse/intake/${fixture.task.id}/pallets/current/close-and-print`)
      .set(warehouseAuth)
      .send({ printerId, requestId })
      .expect(409)
      .then((response) => response);

    try {
      await printStageReached.promise;
      const voided = await voidPallet(fixture, palletId, operationKey).expect(200);
      const replay = await voidPallet(fixture, palletId, operationKey).expect(200);
      expect(replay.body).toEqual(voided.body);

      continuePrint.resolve();
      const closed = await closePromise;
      expect(closed.body).toMatchObject({
        code: 'PALLET_PRINT_DOCUMENT_VOIDED',
        documentId: voided.body.id as string,
        warehousePalletId: palletId,
      });
      expect(adapterSpy).not.toHaveBeenCalled();

      await expect(
        prisma.warehousePallet.findUniqueOrThrow({
          where: { id: palletId },
          select: {
            status: true,
            items: {
              select: { releasedAt: true, releaseReason: true },
            },
            document: {
              select: {
                id: true,
                voidedAt: true,
                printJobs: { select: { id: true, status: true } },
              },
            },
          },
        }),
      ).resolves.toEqual({
        status: 'voided',
        items: [{ releasedAt: expect.any(Date), releaseReason: 'pallet_voided' }],
        document: {
          id: voided.body.id as string,
          voidedAt: expect.any(Date),
          printJobs: [],
        },
      });
      await expect(
        prisma.warehousePalletItem.count({ where: { palletId, releasedAt: null } }),
      ).resolves.toBe(0);
      await expect(
        prisma.warehousePalletCommand.count({ where: { operationKey, kind: 'void_pallet' } }),
      ).resolves.toBe(1);
      await expect(
        prisma.domainEvent.count({
          where: {
            OR: [
              { objectId: palletId, type: 'audit:warehouse_pallet_voided' },
              { objectId: voided.body.id as string, type: 'audit:pallet_list_voided' },
            ],
          },
        }),
      ).resolves.toBe(2);
    } finally {
      continuePrint.resolve();
      serviceSpy.mockRestore();
      adapterSpy.mockRestore();
    }
  });

  it('commits one concurrent void mutation, replays it, and rejects a conflicting reuse', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'void-race', 1), [0]);
    const operationKey = randomUUID();

    const [first, replay] = await Promise.all([
      voidPallet(sealed, sealed.palletId, operationKey).expect(200),
      voidPallet(sealed, sealed.palletId, operationKey).expect(200),
    ]);
    expect(replay.body).toEqual(first.body);
    const conflict = await voidPallet(
      sealed,
      sealed.palletId,
      operationKey,
      'print_problem',
    ).expect(409);
    expect(conflict.body).toMatchObject({
      code: 'WAREHOUSE_PALLET_VOID_OPERATION_CONFLICT',
    });
    await expect(
      prisma.warehousePalletCommand.count({
        where: { kind: 'void_pallet', operationKey },
      }),
    ).resolves.toBe(1);
    const emitted = await prisma.domainEvent.findMany({
      where: {
        actorId: warehouseActorId,
        OR: [
          { objectId: sealed.palletId, type: 'audit:warehouse_pallet_voided' },
          { objectId: sealed.documentId, type: 'audit:pallet_list_voided' },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(emitted).toHaveLength(2);
    expect(emitted.map((event) => event.type).sort()).toEqual([
      'audit:pallet_list_voided',
      'audit:warehouse_pallet_voided',
    ]);
  });

  it('serializes concurrent void and next-pallet opening without a split state', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'void-open-race', 2), [0]);

    const [voided, opened] = await Promise.all([
      voidPallet(sealed, sealed.palletId, randomUUID()).expect(200),
      select(sealed, sealed.rows[1].id, randomUUID()).expect(200),
    ]);
    expect(voided.body.documentStatus).toBe('voided');
    expect(opened.body.activePallet).toMatchObject({
      status: 'open',
      totalCount: 1,
      rows: [expect.objectContaining({ rollCode: sealed.rows[1].rollCode })],
    });

    const pallets = await prisma.warehousePallet.findMany({
      where: { taskId: sealed.task.id },
      orderBy: { sequenceNo: 'asc' },
      include: {
        items: {
          where: { releasedAt: null },
          select: { scanRowId: true },
        },
      },
    });
    expect(pallets).toHaveLength(2);
    expect(pallets[0]).toMatchObject({
      id: sealed.palletId,
      status: 'voided',
      items: [],
    });
    expect(pallets[1]).toMatchObject({
      id: opened.body.activePallet.id as string,
      status: 'open',
      items: [{ scanRowId: sealed.rows[1].id }],
    });
    expect(pallets.filter((pallet) => pallet.status === 'open')).toHaveLength(1);
  });

  it('allows a membership released by annulment to enter a new physical pallet', async () => {
    const sealed = await seal(await createAcceptedTask(prisma, 'released-reselect', 1), [0]);
    await voidPallet(sealed, sealed.palletId, randomUUID()).expect(200);

    const selected = await select(sealed, sealed.rows[0].id, randomUUID()).expect(200);
    expect(selected.body.activePallet).toMatchObject({
      status: 'open',
      sequenceNo: 2,
      totalCount: 1,
      rows: [expect.objectContaining({ rollCode: sealed.rows[0].rollCode })],
    });
    expect(selected.body.activePallet.id).not.toBe(sealed.palletId);

    const memberships = await prisma.warehousePalletItem.findMany({
      where: { scanRowId: sealed.rows[0].id },
      orderBy: { createdAt: 'asc' },
      select: { palletId: true, releasedAt: true, releaseReason: true },
    });
    expect(memberships).toEqual([
      {
        palletId: sealed.palletId,
        releasedAt: expect.any(Date),
        releaseReason: 'pallet_voided',
      },
      {
        palletId: selected.body.activePallet.id as string,
        releasedAt: null,
        releaseReason: null,
      },
    ]);
  });
});
