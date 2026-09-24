import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type {
  PalletLabelLayoutDefinitionV1,
  PalletLabelLayoutDefinitionV2,
  PalletLabelLayoutPublication,
  PalletListPayload,
} from '@plenka/contracts';
import jsQR from 'jsqr';
import request from 'supertest';
import { PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID } from '../src/common/pallet-label-layout/pallet-label-layout-validation-source';
import {
  LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT,
  PUBLISHED_PALLET_LABEL_LAYOUT,
} from '../src/common/pallet-label-layout/pallet-label-layout.validator';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PalletLabelRenderer } from '../src/modules/warehouse/pallet-label.renderer';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';
import { selectAcceptedRowsIntoCurrentPalletFixture } from './warehouse-pallet-e2e-fixture';

const V1_PROFILE = 'pallet-100x150-v1' as const;
const V7_PROFILE = 'pallet-100x100-configurable-v7' as const;

const LAYOUT_A: PalletLabelLayoutDefinitionV2 = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);

type AuthHeaders = Record<string, string>;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function pngBody(response: request.Response): Buffer {
  if (!Buffer.isBuffer(response.body)) throw new Error('Expected a binary PNG response');
  return response.body;
}

function bitmapToRgba(bitmap: Buffer, width: number, height: number): Uint8ClampedArray {
  const bytesPerRow = Math.ceil(width / 8);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = bitmap[y * bytesPerRow + Math.floor(x / 8)];
      const value = (byte & (1 << (7 - (x % 8)))) !== 0 ? 0 : 255;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

async function createAcceptedTask(prisma: PrismaService, label: string) {
  const suffix = randomUUID().slice(0, 8);
  const shortLabel = label.slice(0, 1);
  const order = await prisma.commercialOrder.create({
    data: {
      orderNumber: `L${shortLabel}-${suffix}`,
      creatorRole: 'commercial',
    },
    select: { id: true, orderNumber: true },
  });
  const task = await prisma.warehouseAcceptanceTask.create({
    data: {
      mode: 'receiving',
      status: 'open',
      operationCode: `L${shortLabel}-${suffix}`,
      orderId: order.id,
    },
    select: { id: true },
  });
  await Promise.all(
    ['R01', 'R02'].map((prefix, index) =>
      prisma.scanRow.create({
        data: {
          taskId: task.id,
          rollCode: `${prefix}-${shortLabel}-${suffix}`,
          fromOrderId: order.orderNumber,
          scanStatus: 'accepted',
          lastScanAt: new Date(Date.UTC(2026, 7, 12, 7, index, 0)),
          scannedByName: 'E2E Warehouse',
        },
      }),
    ),
  );
  return task.id;
}

async function oneCSideEffects(prisma: PrismaService) {
  const [stockPushOperations, syncRuns, events] = await Promise.all([
    prisma.oneCStockPushOperation.count(),
    prisma.oneCSyncRun.count(),
    prisma.domainEvent.count({
      where: {
        OR: [{ type: { contains: 'onec' } }, { type: 'audit:sync_retry_requested' }],
      },
    }),
  ]);
  return { stockPushOperations, syncRuns, events };
}

async function retireDisposablePublications(prisma: PrismaService): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "pallet_label_layout_versions" DISABLE TRIGGER USER');
    try {
      await tx.palletLabelLayoutVersion.updateMany({
        where: { profile: V7_PROFILE },
        data: { profile: 'e2e-retired-pallet-100x100-configurable-v7' },
      });
      const activeCount = await tx.palletLabelLayoutVersion.count({
        where: { profile: V7_PROFILE },
      });
      if (activeCount !== 0) throw new Error('Disposable layout publication remained active');
    } finally {
      await tx.$executeRawUnsafe('ALTER TABLE "pallet_label_layout_versions" ENABLE TRIGGER USER');
    }
  });
}

describe('published pallet layout lifecycle (e2e, HTTP + PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let renderer: PalletLabelRenderer;
  let adminAuth: AuthHeaders;
  let warehouseAuth: AuthHeaders;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'on',
    PALLET_LABEL_PROFILE: V1_PROFILE,
    ONEC_LIVE: 'false',
    ONEC_WRITE: 'false',
    ONEC_SYNC_ENABLED: 'false',
    ONEC_FINANCE_SYNC_ENABLED: 'false',
    ONEC_PAYMENT_SYNC_ENABLED: 'false',
    ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'false',
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
    renderer = moduleRef.get(PalletLabelRenderer);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const [adminLogin, warehouseLogin] = await Promise.all([
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
        .expect(201),
      request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('warehouse'), password: e2eSeedPassword() })
        .expect(201),
    ]);
    adminAuth = { Authorization: `Bearer ${adminLogin.body.token as string}` };
    warehouseAuth = { Authorization: `Bearer ${warehouseLogin.body.token as string}` };
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'pallet layout publication disposable-state isolation',
          run: async () => {
            if (prisma) await retireDisposablePublications(prisma);
          },
        },
        { label: 'pallet layout publication application', run: async () => app?.close() },
        {
          label: 'pallet layout publication environment',
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

  const seal = async (taskId: string, expectedProfile: typeof V1_PROFILE | typeof V7_PROFILE) => {
    await selectAcceptedRowsIntoCurrentPalletFixture(app, warehouseAuth, taskId);
    const response = await request(app.getHttpServer())
      .post(`/api/warehouse/intake/${taskId}/pallets/current/seal`)
      .set(warehouseAuth)
      .send({ requestId: randomUUID() });
    expect({ status: response.status, body: response.body }).toMatchObject({
      status: 200,
      body: {
        pallet: { status: 'sealed', rollCount: 2 },
        document: {
          documentStatus: 'sealed',
          printStatus: 'not_printed',
          templateVersion: expectedProfile,
        },
      },
    });
    return response.body.document.id as string;
  };

  it('pins A, keeps its official bytes after B, and records only browser print intent', async () => {
    const gatewayCommandBaseline = await prisma.gatewayCommand.count();
    const printJobBaseline = await prisma.palletPrintJob.count();
    const oneCBaseline = await oneCSideEffects(prisma);

    const sourceDocumentId = PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID;
    const initialBootstrap = await request(app.getHttpServer())
      .get('/api/admin/pallet-label-layout-editor')
      .set(adminAuth)
      .expect(200);
    expect(initialBootstrap.body.activePublication).toBeNull();
    expect(
      (initialBootstrap.body.sources as Array<{ documentId: string }>).map(
        (source) => source.documentId,
      ),
    ).toContain(sourceDocumentId);

    const publishACommand = {
      operationKey: randomUUID(),
      expectedActivePublicationId: null,
      sourceDocumentId,
      reason: 'Публикация макета A для сквозной проверки',
      layout: LAYOUT_A,
    };
    const publishA = await request(app.getHttpServer())
      .post('/api/admin/pallet-label-layout-editor/publish')
      .set(adminAuth)
      .send(publishACommand)
      .expect(200);
    const publicationA = publishA.body.publication as PalletLabelLayoutPublication;
    expect(publishA.body.replayed).toBe(false);
    expect(publicationA).toMatchObject({
      version: 1,
      contentHash: sha256(JSON.stringify(LAYOUT_A)),
      layout: LAYOUT_A,
    });

    const publishAReplay = await request(app.getHttpServer())
      .post('/api/admin/pallet-label-layout-editor/publish')
      .set(adminAuth)
      .send(publishACommand)
      .expect(200);
    expect(publishAReplay.body).toEqual({ publication: publicationA, replayed: true });

    const rejectedCloseTaskId = await createAcceptedTask(prisma, 'CLOSE');
    await selectAcceptedRowsIntoCurrentPalletFixture(app, warehouseAuth, rejectedCloseTaskId);
    const openPallet = await prisma.warehousePallet.findFirstOrThrow({
      where: { taskId: rejectedCloseTaskId, status: 'open' },
      select: { id: true },
    });
    const rejectedCloseBaseline = {
      documents: await prisma.palletListDocument.count(),
      printJobs: await prisma.palletPrintJob.count(),
      tokens: await prisma.palletScanToken.count(),
      gatewayCommands: await prisma.gatewayCommand.count(),
      audits: await prisma.domainEvent.count(),
    };

    await request(app.getHttpServer())
      .post(`/api/warehouse/intake/${rejectedCloseTaskId}/pallets/current/close-and-print`)
      .set(warehouseAuth)
      .send({ printerId: 'must-not-reach-gateway', requestId: randomUUID() })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' });
      });

    await expect(
      prisma.warehousePallet.findUniqueOrThrow({
        where: { id: openPallet.id },
        select: { status: true, closeRequestId: true, sealedAt: true },
      }),
    ).resolves.toEqual({ status: 'open', closeRequestId: null, sealedAt: null });
    await expect(prisma.palletListDocument.count()).resolves.toBe(rejectedCloseBaseline.documents);
    await expect(prisma.palletPrintJob.count()).resolves.toBe(rejectedCloseBaseline.printJobs);
    await expect(prisma.palletScanToken.count()).resolves.toBe(rejectedCloseBaseline.tokens);
    await expect(prisma.gatewayCommand.count()).resolves.toBe(
      rejectedCloseBaseline.gatewayCommands,
    );
    await expect(prisma.domainEvent.count()).resolves.toBe(rejectedCloseBaseline.audits);

    const taskAId = await createAcceptedTask(prisma, 'A');
    const documentAId = await seal(taskAId, V7_PROFILE);
    const documentABefore = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: documentAId },
      select: { id: true, layoutPublicationId: true, payload: true },
    });
    const payloadA = documentABefore.payload as unknown as PalletListPayload;
    expect(documentABefore.layoutPublicationId).toBe(publicationA.id);
    expect(payloadA.templateVersion).toBe(V7_PROFILE);
    expect(payloadA.layoutPublication).toEqual(publicationA);
    const snapshotFingerprintA = sha256(JSON.stringify(documentABefore.payload));

    const documentAuditBeforeRejectedPrint = await prisma.domainEvent.count({
      where: { objectId: documentAId },
    });
    const palletTokenBaseline = await prisma.palletScanToken.count({
      where: { documentId: documentAId },
    });
    expect(palletTokenBaseline).toBe(1);
    await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentAId}/print`)
      .set(warehouseAuth)
      .send({ printerId: 'must-not-reach-gateway', requestId: randomUUID() })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({ code: 'PALLET_LABEL_BROWSER_PRINT_ONLY' });
      });
    await expect(
      prisma.palletScanToken.count({ where: { documentId: documentAId } }),
    ).resolves.toBe(palletTokenBaseline);
    await expect(prisma.domainEvent.count({ where: { objectId: documentAId } })).resolves.toBe(
      documentAuditBeforeRejectedPrint,
    );

    const pngABefore = pngBody(await preview(documentAId));
    expect(pngABefore.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(pngABefore.readUInt32BE(16)).toBe(800);
    expect(pngABefore.readUInt32BE(20)).toBe(800);

    const tokenA = await prisma.palletScanToken.findUniqueOrThrow({
      where: { documentId: documentAId },
      select: { token: true },
    });
    expect(tokenA.token).toMatch(/^plt_[0-9a-f]{64}$/u);
    expect(tokenA.token).not.toBe(`plt_${'0'.repeat(64)}`);
    const officialSvgA = renderer.renderPalletLabelSvg(
      payloadA.label,
      tokenA.token,
      V7_PROFILE,
      publicationA,
    );
    const officialPngA = renderer.renderPalletLabel(
      payloadA.label,
      tokenA.token,
      V7_PROFILE,
      publicationA,
    );
    const qrA = jsQR(bitmapToRgba(officialPngA.bitmap, 800, 800), 800, 800, {
      inversionAttempts: 'dontInvert',
    });
    expect(officialSvgA).not.toContain('ЧЕРНОВИК МАКЕТА');
    expect(officialSvgA).not.toContain('data-preview-qr="true"');
    expect(qrA?.data).toBe(tokenA.token);
    expect(pngABefore).toEqual(officialPngA.png);

    const intentRequestId = randomUUID();
    const intent = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentAId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: intentRequestId, kind: 'initial' })
      .expect(200);
    const intentReplay = await request(app.getHttpServer())
      .post(`/api/warehouse/pallet-lists/${documentAId}/system-print-intents`)
      .set(warehouseAuth)
      .send({ requestId: intentRequestId, kind: 'initial' })
      .expect(200);
    expect(intent.body).toMatchObject({
      requestId: intentRequestId,
      palletListDocumentId: documentAId,
      kind: 'initial',
      status: 'intent_recorded',
      replayed: false,
    });
    expect(intent.body).not.toHaveProperty('printed');
    expect(intent.body).not.toHaveProperty('printedAt');
    expect(intentReplay.body).toEqual({ ...intent.body, replayed: true });
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: documentAId,
          type: 'audit:pallet_list_print_requested',
          detail: { path: ['requestId'], equals: intentRequestId },
        },
      }),
    ).resolves.toBe(1);

    const layoutB = structuredClone(LAYOUT_A);
    const orderB = layoutB.elements.find((element) => element.id === 'order');
    if (!orderB) throw new Error('The V2 layout has no order block');
    orderB.xDots = 44;
    const publishB = await request(app.getHttpServer())
      .post('/api/admin/pallet-label-layout-editor/publish')
      .set(adminAuth)
      .send({
        operationKey: randomUUID(),
        expectedActivePublicationId: publicationA.id,
        sourceDocumentId,
        reason: 'Публикация макета B для проверки неизменности A',
        layout: layoutB,
      })
      .expect(200);
    const publicationB = publishB.body.publication as PalletLabelLayoutPublication;
    expect(publicationB).toMatchObject({
      version: 2,
      contentHash: sha256(JSON.stringify(layoutB)),
      layout: layoutB,
    });
    expect(publicationB.id).not.toBe(publicationA.id);
    expect(publicationB.contentHash).not.toBe(publicationA.contentHash);

    const documentAAfter = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: documentAId },
      select: { layoutPublicationId: true, payload: true },
    });
    const pngAAfter = pngBody(await preview(documentAId));
    expect(documentAAfter.layoutPublicationId).toBe(publicationA.id);
    expect(sha256(JSON.stringify(documentAAfter.payload))).toBe(snapshotFingerprintA);
    expect(pngAAfter).toEqual(pngABefore);
    expect(sha256(pngAAfter)).toBe(sha256(pngABefore));

    const taskBId = await createAcceptedTask(prisma, 'B');
    const documentBId = await seal(taskBId, V7_PROFILE);
    const documentB = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: documentBId },
      select: { layoutPublicationId: true, payload: true },
    });
    const payloadB = documentB.payload as unknown as PalletListPayload;
    expect(documentB.layoutPublicationId).toBe(publicationB.id);
    expect(payloadB.layoutPublication).toEqual(publicationB);
    const pngB = pngBody(await preview(documentBId));
    const tokenB = await prisma.palletScanToken.findUniqueOrThrow({
      where: { documentId: documentBId },
      select: { token: true },
    });
    const svgB = renderer.renderPalletLabelSvg(
      payloadB.label,
      tokenB.token,
      V7_PROFILE,
      publicationB,
    );
    expect(svgB).toContain('data-element-bounds="44,36,390,62"');
    expect(svgB).toContain('Рулонов на палете: 2');
    expect(svgB).not.toContain('<image');
    for (const rollCode of payloadB.label.rollCodes ?? []) {
      expect(svgB).not.toContain(rollCode);
    }
    expect(
      [...svgB.matchAll(/data-layout-element="([^"]+)"/gu)].map((match) => match[1]),
    ).toEqual(['order', 'customer', 'formedAt', 'rollCount', 'storage', 'qr']);
    const counterfactualAForDocumentB = renderer.renderPalletLabel(
      payloadB.label,
      tokenB.token,
      V7_PROFILE,
      publicationA,
    ).png;
    expect(pngB).not.toEqual(counterfactualAForDocumentB);

    const publicationEvents = await prisma.domainEvent.findMany({
      where: { type: 'audit:pallet_label_layout_published' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { objectId: true, reason: true, detail: true },
    });
    expect(publicationEvents).toHaveLength(2);
    expect(publicationEvents).toEqual([
      expect.objectContaining({
        objectId: publicationA.id,
        reason: publishACommand.reason,
        detail: expect.objectContaining({
          version: 1,
          contentHash: publicationA.contentHash,
          sourceDocumentId,
        }),
      }),
      expect.objectContaining({
        objectId: publicationB.id,
        reason: 'Публикация макета B для проверки неизменности A',
        detail: expect.objectContaining({
          version: 2,
          contentHash: publicationB.contentHash,
          sourceDocumentId,
        }),
      }),
    ]);
    await expect(prisma.palletLabelLayoutVersion.count()).resolves.toBe(2);
    await expect(prisma.palletLabelLayoutPublishCommand.count()).resolves.toBe(2);
    await expect(prisma.gatewayCommand.count()).resolves.toBe(gatewayCommandBaseline);
    await expect(prisma.palletPrintJob.count()).resolves.toBe(printJobBaseline);
    await expect(oneCSideEffects(prisma)).resolves.toEqual(oneCBaseline);
  });

  it('keeps V1 active until manual V2 publication and pins both document generations', async () => {
    const pinnedDocument = await prisma.palletListDocument.findFirstOrThrow({
      where: { layoutPublicationId: { not: null } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    const pinnedBefore = pngBody(await preview(pinnedDocument.id));
    const latest = await prisma.palletLabelLayoutVersion.findFirstOrThrow({
      where: { profile: V7_PROFILE },
      orderBy: [{ version: 'desc' }, { id: 'desc' }],
      select: { version: true, publishedById: true },
    });
    const historicalLayout = structuredClone(
      LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT,
    ) as PalletLabelLayoutDefinitionV1;
    historicalLayout.elements.find((element) => element.id === 'product')!.widthDots = 332;
    const historicalPublication = await prisma.palletLabelLayoutVersion.create({
      data: {
        profile: V7_PROFILE,
        version: latest.version + 1,
        definition: historicalLayout,
        contentHash: sha256(JSON.stringify(historicalLayout)),
        sourceDocumentId: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
        publishedById: latest.publishedById,
        reason: 'Имитация безопасного исторического макета до политики ёмкости',
      },
    });

    expect(pngBody(await preview(pinnedDocument.id))).toEqual(pinnedBefore);

    const taskId = await createAcceptedTask(prisma, 'HISTORICAL-ACTIVE');
    await selectAcceptedRowsIntoCurrentPalletFixture(app, warehouseAuth, taskId);
    const openPallet = await prisma.warehousePallet.findFirstOrThrow({
      where: { taskId, status: 'open' },
      select: { id: true },
    });
    const baseline = {
      documents: await prisma.palletListDocument.count(),
      pallets: await prisma.warehousePallet.count({ where: { status: 'sealed' } }),
      tokens: await prisma.palletScanToken.count(),
      audits: await prisma.domainEvent.count(),
      printJobs: await prisma.palletPrintJob.count(),
      gatewayCommands: await prisma.gatewayCommand.count(),
      oneC: await oneCSideEffects(prisma),
    };

    await request(app.getHttpServer())
      .post(`/api/warehouse/intake/${taskId}/pallets/current/seal`)
      .set(warehouseAuth)
      .send({ requestId: randomUUID() })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          pallet: { id: openPallet.id, status: 'sealed' },
          document: {
            warehousePalletId: openPallet.id,
            templateVersion: V7_PROFILE,
          },
        });
      });

    await expect(
      prisma.warehousePallet.findUniqueOrThrow({
        where: { id: openPallet.id },
        select: { status: true, closeRequestId: true, sealedAt: true },
      }),
    ).resolves.toEqual({
      status: 'sealed',
      closeRequestId: expect.any(String),
      sealedAt: expect.any(Date),
    });
    await expect(prisma.palletListDocument.count()).resolves.toBe(baseline.documents + 1);
    await expect(prisma.warehousePallet.count({ where: { status: 'sealed' } })).resolves.toBe(
      baseline.pallets + 1,
    );
    await expect(prisma.palletScanToken.count()).resolves.toBe(baseline.tokens + 1);
    await expect(prisma.domainEvent.count()).resolves.toBeGreaterThan(baseline.audits);
    await expect(prisma.palletPrintJob.count()).resolves.toBe(baseline.printJobs);
    await expect(prisma.gatewayCommand.count()).resolves.toBe(baseline.gatewayCommands);

    const historicalDocument = await prisma.palletListDocument.findFirstOrThrow({
      where: { warehousePalletId: openPallet.id },
      select: { id: true, layoutPublicationId: true, payload: true },
    });
    const historicalPayload = historicalDocument.payload as unknown as PalletListPayload;
    expect(historicalDocument.layoutPublicationId).toBe(historicalPublication.id);
    expect(historicalPayload.layoutPublication?.layout.schemaVersion).toBe(1);
    const historicalPng = pngBody(await preview(historicalDocument.id));

    const legacyBootstrap = await request(app.getHttpServer())
      .get('/api/admin/pallet-label-layout-editor')
      .set(adminAuth)
      .expect(200);
    expect(legacyBootstrap.body.activePublication).toMatchObject({
      id: historicalPublication.id,
      layout: { schemaVersion: 1 },
    });
    expect(legacyBootstrap.body.editorLayout).toMatchObject({
      schemaVersion: 2,
      elements: PUBLISHED_PALLET_LABEL_LAYOUT.elements,
    });

    const publishV2 = await request(app.getHttpServer())
      .post('/api/admin/pallet-label-layout-editor/publish')
      .set(adminAuth)
      .send({
        operationKey: randomUUID(),
        expectedActivePublicationId: historicalPublication.id,
        sourceDocumentId: PALLET_LABEL_LAYOUT_CONTROL_SOURCE_ID,
        reason: 'Ручная публикация V2 после исторического V1',
        layout: PUBLISHED_PALLET_LABEL_LAYOUT,
      })
      .expect(200);
    expect(publishV2.body.publication).toMatchObject({
      version: historicalPublication.version + 1,
      layout: PUBLISHED_PALLET_LABEL_LAYOUT,
    });

    const v2TaskId = await createAcceptedTask(prisma, 'V2-AFTER-V1');
    const v2DocumentId = await seal(v2TaskId, V7_PROFILE);
    const v2Document = await prisma.palletListDocument.findUniqueOrThrow({
      where: { id: v2DocumentId },
      select: { layoutPublicationId: true, payload: true },
    });
    const v2Payload = v2Document.payload as unknown as PalletListPayload;
    expect(v2Document.layoutPublicationId).toBe(publishV2.body.publication.id);
    expect(v2Payload.layoutPublication?.layout.schemaVersion).toBe(2);
    expect(pngBody(await preview(historicalDocument.id))).toEqual(historicalPng);
    await expect(prisma.palletPrintJob.count()).resolves.toBe(baseline.printJobs);
    await expect(prisma.gatewayCommand.count()).resolves.toBe(baseline.gatewayCommands);
    await expect(oneCSideEffects(prisma)).resolves.toEqual(baseline.oneC);
  });
});
