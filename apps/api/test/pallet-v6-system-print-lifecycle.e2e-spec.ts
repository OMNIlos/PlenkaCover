import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PalletListPayload, WarehouseIntakeTaskView } from '@plenka/contracts';
import request from 'supertest';
import { AuditService } from '../src/common/audit/audit.service';
import { PalletTokenService } from '../src/common/pallet-token/pallet-token.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PRINTER_ADAPTER, type PrinterAdapter } from '../src/integrations/printer/printer.adapter';
import {
  buildPalletListPayload,
  PALLET_STORAGE_CONDITIONS,
} from '../src/modules/warehouse/pallet-list.builder';
import { PalletLabelRenderer } from '../src/modules/warehouse/pallet-label.renderer';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { selectAcceptedRowsIntoCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

const V5_PROFILE = 'pallet-100x100-safe-v5' as const;
const V6_PROFILE = 'pallet-100x100-extended-v6' as const;

type AuthHeaders = Record<string, string>;

async function createAcceptedTask(prisma: PrismaService) {
  const suffix = randomUUID().slice(0, 8);
  const order = await prisma.commercialOrder.create({
    data: {
      orderNumber: `V6-${suffix}`,
      creatorRole: 'commercial',
    },
    select: { id: true, orderNumber: true },
  });
  const task = await prisma.warehouseAcceptanceTask.create({
    data: {
      mode: 'receiving',
      status: 'open',
      operationCode: `V6-${suffix}`,
      orderId: order.id,
    },
    select: { id: true },
  });
  const rows = await Promise.all(
    ['R01', 'R02'].map((prefix, index) =>
      prisma.scanRow.create({
        data: {
          taskId: task.id,
          rollCode: `${prefix}-${suffix}`,
          fromOrderId: order.orderNumber,
          scanStatus: 'accepted',
          lastScanAt: new Date(Date.UTC(2026, 7, 10, 7, index, 0)),
          scannedByName: 'E2E Warehouse',
        },
        select: { id: true, rollCode: true },
      }),
    ),
  );
  return { order, rows, task };
}

function pngBody(response: request.Response): Buffer {
  if (!Buffer.isBuffer(response.body)) throw new Error('Expected a binary PNG response');
  return response.body;
}

function pngSha256(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex');
}

describe('pallet v6 browser/system-print lifecycle (e2e, HTTP + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let warehouseAuth: AuthHeaders;
  let printer: PrinterAdapter;
  let renderer: PalletLabelRenderer;
  let palletTokens: PalletTokenService;
  let audit: AuditService;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'on',
    PALLET_LABEL_PROFILE: V6_PROFILE,
  } as const;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    // Runtime configuration is snapshotted while AppModule is imported.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    printer = moduleRef.get(PRINTER_ADAPTER);
    renderer = moduleRef.get(PalletLabelRenderer);
    palletTokens = moduleRef.get(PalletTokenService);
    audit = moduleRef.get(AuditService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('warehouse'), password: e2eSeedPassword() })
      .expect(201);
    warehouseAuth = { Authorization: `Bearer ${login.body.token as string}` };
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        { label: 'pallet v6 application', run: async () => app?.close() },
        {
          label: 'pallet v6 environment',
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

  const preview = (documentId: string) =>
    request(app.getHttpServer())
      .get(`/api/warehouse/pallet-lists/${documentId}/preview`)
      .set(warehouseAuth)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect('Content-Type', /image\/png/u)
      .expect(200);

  it('preserves v5, seals v6, audits idempotent intents and rejects non-browser outputs', async () => {
    const fixture = await createAcceptedTask(prisma);
    const intake = await request(app.getHttpServer())
      .get('/api/warehouse/intake')
      .set(warehouseAuth)
      .expect(200);
    const task = (intake.body.tasks as WarehouseIntakeTaskView[]).find(
      (candidate) => candidate.taskId === fixture.task.id,
    );
    if (!task) throw new Error('The v6 fixture is absent from the warehouse intake projection');

    const historicalRollCodes = task.rolls.map((roll) => roll.rollCode);
    const historicalPayload = buildPalletListPayload(
      {
        ...task,
        rolls: task.rolls.map((roll) => ({
          ...roll,
          orderId: fixture.order.id,
          orderNumber: fixture.order.orderNumber,
        })),
      },
      'E2E Warehouse',
      '2026-08-09T07:00:00.000Z',
      {
        palletId: `V5-HIST-${fixture.order.orderNumber}`,
        rollCodes: historicalRollCodes,
        printReady: true,
      },
      V5_PROFILE,
    );
    const historicalV5 = await prisma.palletListDocument.create({
      data: {
        palletId: historicalPayload.palletId,
        origin: 'legacy',
        rollIds: historicalRollCodes,
        orderIds: [fixture.order.id],
        generatedByRole: 'warehouse',
        format: 'label_100x100',
        fieldSetStatus: 'template_square_v4',
        payload: historicalPayload,
      },
      select: { id: true, payload: true },
    });
    const historicalPreviewBefore = pngBody(await preview(historicalV5.id));
    expect(historicalPreviewBefore.readUInt32BE(16)).toBe(800);
    expect(historicalPreviewBefore.readUInt32BE(20)).toBe(800);

    await selectAcceptedRowsIntoCurrentPalletFixture(app, warehouseAuth, fixture.task.id);
    const sealRequestId = randomUUID();
    const sealed = await request(app.getHttpServer())
      .post(`/api/warehouse/intake/${fixture.task.id}/pallets/current/seal`)
      .set(warehouseAuth)
      .send({ requestId: sealRequestId })
      .expect(200);
    expect(sealed.body).toMatchObject({
      pallet: { status: 'sealed', rollCount: 2 },
      document: {
        documentStatus: 'sealed',
        printStatus: 'not_printed',
        templateVersion: V6_PROFILE,
      },
    });
    const documentId = sealed.body.document.id as string;
    const palletId = sealed.body.pallet.id as string;
    const orderedMembership = (
      await prisma.warehousePalletItem.findMany({
        where: { palletId, releasedAt: null },
        orderBy: { position: 'asc' },
        select: { rollCode: true },
      })
    ).map((item) => item.rollCode);
    const persistedV6 = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: documentId },
      select: { id: true, palletId: true, payload: true, rollIds: true },
    });
    const v6Payload = persistedV6.payload as unknown as PalletListPayload;
    expect(persistedV6.rollIds).toEqual(orderedMembership);
    expect(v6Payload.templateVersion).toBe(V6_PROFILE);
    expect(v6Payload.label.templateVersion).toBe(V6_PROFILE);
    expect(v6Payload.rows.map((row) => row.rollCode)).toEqual(orderedMembership);
    expect(v6Payload.label.rollCodes).toEqual(orderedMembership);
    expect(v6Payload.label.storageConditions).toBe(PALLET_STORAGE_CONDITIONS);

    const v6Preview = pngBody(await preview(documentId));
    expect(v6Preview.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(v6Preview.readUInt32BE(16)).toBe(800);
    expect(v6Preview.readUInt32BE(20)).toBe(800);

    const initialRequestId = randomUUID();
    const initial = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: initialRequestId, kind: 'initial' })
      .expect(200);
    const initialReplay = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: initialRequestId, kind: 'initial' })
      .expect(200);
    expect(initial.body).toMatchObject({
      requestId: initialRequestId,
      palletListDocumentId: documentId,
      kind: 'initial',
      status: 'intent_recorded',
      replayed: false,
    });
    expect(initialReplay.body).toEqual({ ...initial.body, replayed: true });

    const printJobBaseline = await prisma.palletPrintJob.count({
      where: { palletListDocumentId: documentId },
    });
    const gatewayCommandBaseline = await prisma.gatewayCommand.count();
    const documentAuditBaseline = await prisma.domainEvent.count({
      where: { objectId: documentId },
    });
    expect(printJobBaseline).toBe(0);
    const printerSpy = jest.spyOn(printer, 'print');
    const rendererSpy = jest.spyOn(renderer, 'renderPalletLabel');
    const tokenSpy = jest.spyOn(palletTokens, 'requireForDocument');
    const auditSpy = jest.spyOn(audit, 'record');

    await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/print`)
      .set(warehouseAuth)
      .send({ printerId: 'must-not-be-resolved', requestId: randomUUID() })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' });
      });
    for (const format of ['pdf', 'docx', 'xlsx']) {
      await request(app.getHttpServer())
        .get(`/api/warehouse/pallet-lists/${documentId}/export?format=${format}`)
        .set(warehouseAuth)
        .expect(409)
        .expect(({ body }) => {
          expect(body).toMatchObject({ code: 'PALLET_LABEL_EXPORT_UNSUPPORTED' });
        });
    }

    expect(printerSpy).not.toHaveBeenCalled();
    expect(rendererSpy).not.toHaveBeenCalled();
    expect(tokenSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
    await expect(
      prisma.palletPrintJob.count({ where: { palletListDocumentId: documentId } }),
    ).resolves.toBe(printJobBaseline);
    await expect(prisma.gatewayCommand.count()).resolves.toBe(gatewayCommandBaseline);
    await expect(prisma.domainEvent.count({ where: { objectId: documentId } })).resolves.toBe(
      documentAuditBaseline,
    );

    const reprintRequestId = randomUUID();
    const reprintReason = 'Этикетка повреждена при наклеивании';
    await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: reprintRequestId, kind: 'reprint' })
      .expect(400);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: documentId,
          type: 'audit:pallet_list_reprint_requested',
        },
      }),
    ).resolves.toBe(0);
    const reprint = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: reprintRequestId, kind: 'reprint', reason: reprintReason })
      .expect(200);
    const reprintRetry = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: reprintRequestId, kind: 'reprint', reason: reprintReason })
      .expect(200);
    expect(reprint.body).toMatchObject({
      requestId: reprintRequestId,
      kind: 'reprint',
      replayed: false,
    });
    expect(reprintRetry.body).toEqual({ ...reprint.body, replayed: true });
    await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: reprintRequestId, kind: 'reprint', reason: 'Другая причина' })
      .expect(409);

    const intentEvents = await prisma.domainEvent.findMany({
      where: {
        objectId: documentId,
        type: {
          in: ['audit:pallet_list_print_requested', 'audit:pallet_list_reprint_requested'],
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, type: true, reason: true, detail: true },
    });
    expect(intentEvents).toHaveLength(2);
    expect(intentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: initial.body.eventId as string,
          type: 'audit:pallet_list_print_requested',
          reason: null,
        }),
        expect.objectContaining({
          id: reprint.body.eventId as string,
          type: 'audit:pallet_list_reprint_requested',
          reason: reprintReason,
        }),
      ]),
    );
    expect(intentEvents.find((event) => event.id === reprint.body.eventId)?.detail).toMatchObject({
      channel: 'browser_system_print',
      requestId: reprintRequestId,
      intentKind: 'reprint',
    });

    const legacyRequestId = randomUUID();
    const warehouseUser = await prisma.user.findFirstOrThrow({
      where: { role: 'warehouse' },
      select: { id: true },
    });
    const legacyEvent = await prisma.domainEvent.create({
      data: {
        family: 'audit',
        type: 'audit:pallet_list_reprint_requested',
        objectId: documentId,
        actorRole: 'warehouse',
        actorId: warehouseUser.id,
        label: 'Legacy browser reprint intent',
        detail: {
          channel: 'browser_system_print',
          requestId: legacyRequestId,
          intentKind: 'reprint',
          palletId: persistedV6.palletId,
        },
      },
    });
    await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: legacyRequestId, kind: 'reprint' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          eventId: legacyEvent.id,
          requestId: legacyRequestId,
          kind: 'reprint',
          replayed: true,
        });
      });
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: documentId,
          type: 'audit:pallet_list_reprint_requested',
          detail: { path: ['requestId'], equals: legacyRequestId },
        },
      }),
    ).resolves.toBe(1);

    const historicalV5After = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: historicalV5.id },
      select: { payload: true },
    });
    const historicalPreviewAfter = pngBody(await preview(historicalV5.id));
    expect(historicalV5After.payload).toEqual(historicalV5.payload);
    expect((historicalV5After.payload as unknown as PalletListPayload).templateVersion).toBe(
      V5_PROFILE,
    );
    expect(pngSha256(historicalPreviewAfter)).toBe(pngSha256(historicalPreviewBefore));
    await expect(
      prisma.palletListDocument.findUniqueOrThrow({
        where: { id: documentId },
        select: { payload: true },
      }),
    ).resolves.toEqual({ payload: persistedV6.payload });
  });
});
