import { randomBytes, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';

type Bearer = { Authorization: string };
type QrFixture = {
  token: string;
  warehouseKind: 'roll' | 'big_bag' | 'pallet';
  directorType: 'roll' | 'big_bag' | 'pallet';
};

const FORBIDDEN_PROJECTION_KEYS = new Set([
  'deviceId',
  'gatewayCommandId',
  'operationKey',
  'payload',
  'rawPayload',
  'requestFingerprint',
  'resultSnapshot',
  'scanToken',
  'secret',
  'token',
]);

function collectKeys(value: unknown, target: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, target);
    return target;
  }
  if (value === null || typeof value !== 'object') return target;
  for (const [key, nested] of Object.entries(value)) {
    target.push(key);
    collectKeys(nested, target);
  }
  return target;
}

function expectSafe(value: unknown, tokens: readonly string[]): void {
  for (const key of collectKeys(value)) expect(FORBIDDEN_PROJECTION_KEYS.has(key)).toBe(false);
  const serialized = JSON.stringify(value);
  for (const token of tokens) expect(serialized).not.toContain(token);
  expect(serialized).not.toMatch(/Неизвестное (?:событие|значение|факт)/u);
}

describe('Platform QR traceability (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let warehouseAuth: Bearer;
  let directorAuth: Bearer;
  let previousDevRole: string | undefined;
  let fixtureId = '';
  let matrix: QrFixture[] = [];

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    // Runtime auth configuration is captured during AppModule evaluation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const login = async (role: 'warehouse' | 'director'): Promise<Bearer> => {
      const response = await http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(role), password: e2eSeedPassword() })
        .expect(201);
      return { Authorization: `Bearer ${response.body.token as string}` };
    };
    [warehouseAuth, directorAuth] = await Promise.all([login('warehouse'), login('director')]);

    fixtureId = randomUUID().replaceAll('-', '').slice(0, 16);
    const rollToken = `prt_${randomBytes(32).toString('hex')}`;
    const bigBagToken = `bbt_${randomBytes(32).toString('hex')}`;
    await prisma.warehouseRoll.create({
      data: {
        id: `qr-e2e-roll-${fixtureId}`,
        rollCode: `QR-E2E-ROLL-${fixtureId}`,
        warehouseStatus: 'received',
        receivedAt: new Date('2026-08-14T06:00:00.000Z'),
        scanToken: { create: { token: rollToken } },
      },
    });
    await prisma.bigBagUnit.create({
      data: {
        id: `qr-e2e-bag-${fixtureId}`,
        code: `QR-E2E-BAG-${fixtureId}`,
        material: 'ПВД первичный',
        batchCode: 'QR-E2E-BATCH',
        status: 'available',
        registrationStatus: 'registered',
        location: 'warehouse',
        initialKg: 500,
        currentKg: 480,
        lastMeasuredKg: 480,
        lastMeasuredAt: new Date('2026-08-14T06:00:00.000Z'),
        lastWarehouseMeasuredKg: 480,
        lastWarehouseMeasuredAt: new Date('2026-08-14T06:00:00.000Z'),
        scanToken: { create: { token: bigBagToken } },
      },
    });
    await prisma.palletListDocument.create({
      data: {
        id: `qr-e2e-pallet-${fixtureId}`,
        palletId: `QR-E2E-PALLET-${fixtureId}`,
        rollIds: [],
        orderIds: [],
        generatedByRole: 'warehouse',
        format: 'pdf',
        fieldSetStatus: 'ready',
        payload: {
          label: {
            palletId: `QR-E2E-PALLET-${fixtureId}`,
            materialMark: 'ПВД',
            productNames: ['Плёнка ПВД'],
            rollCount: 0,
            netKg: 0,
            orderNumbers: [],
            customerAliases: [],
          },
        },
      },
    });
    const palletToken = await prisma.palletScanToken.findUniqueOrThrow({
      where: { documentId: `qr-e2e-pallet-${fixtureId}` },
      select: { token: true },
    });
    matrix = [
      { token: rollToken, warehouseKind: 'roll', directorType: 'roll' },
      { token: bigBagToken, warehouseKind: 'big_bag', directorType: 'big_bag' },
      { token: palletToken.token, warehouseKind: 'pallet', directorType: 'pallet' },
    ];
  });

  afterAll(async () => {
    await runE2eWithCleanup(async () => {
      if (!prisma || !fixtureId) return;
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          ALTER TABLE "roll_scan_tokens" DISABLE TRIGGER "roll_scan_tokens_immutable"
        `;
        await tx.$executeRaw`
          ALTER TABLE "pallet_scan_tokens" DISABLE TRIGGER "pallet_scan_tokens_immutable"
        `;
        await tx.rollScanToken.deleteMany({
          where: { rollCode: `QR-E2E-ROLL-${fixtureId}` },
        });
        await tx.bigBagScanToken.deleteMany({
          where: { bigBagId: `qr-e2e-bag-${fixtureId}` },
        });
        await tx.palletScanToken.deleteMany({
          where: { documentId: `qr-e2e-pallet-${fixtureId}` },
        });
        await tx.warehouseRoll.deleteMany({ where: { id: `qr-e2e-roll-${fixtureId}` } });
        await tx.bigBagUnit.deleteMany({ where: { id: `qr-e2e-bag-${fixtureId}` } });
        await tx.palletListDocument.deleteMany({
          where: { id: `qr-e2e-pallet-${fixtureId}` },
        });
        await tx.$executeRaw`
          ALTER TABLE "roll_scan_tokens" ENABLE TRIGGER "roll_scan_tokens_immutable"
        `;
        await tx.$executeRaw`
          ALTER TABLE "pallet_scan_tokens" ENABLE TRIGGER "pallet_scan_tokens_immutable"
        `;
      });
    }, [
      {
        label: 'close QR traceability e2e app',
        run: async () => {
          if (app) await app.close();
          if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
          else process.env.AUTH_DEV_XROLE = previousDevRole;
        },
      },
    ]);
  });

  it('resolves prt_, bbt_ and plt_ through warehouse and director safe read models', async () => {
    const tokens = matrix.map((item) => item.token);
    for (const smokeCase of matrix) {
      const warehouse = await http()
        .post('/api/warehouse/qr/inspect')
        .set(warehouseAuth)
        .send({ payload: smokeCase.token })
        .expect(200);
      expect(warehouse.body.kind).toBe(smokeCase.warehouseKind);

      const search = await http()
        .get('/api/director/traceability/search')
        .query({ q: smokeCase.token, limit: 12 })
        .set(directorAuth)
        .expect(200);
      expect(search.body).toMatchObject({
        items: [
          {
            objectType: smokeCase.directorType,
            objectId: expect.any(String),
            matchKind: 'exact',
          },
        ],
        nextCursor: null,
      });
      const candidate = search.body.items[0] as { objectId: string; objectType: string };
      const context = await http()
        .get(
          `/api/director/traceability/${encodeURIComponent(candidate.objectType)}/${encodeURIComponent(candidate.objectId)}`,
        )
        .set(directorAuth)
        .expect(200);
      expect(context.body).toMatchObject({
        objectType: smokeCase.directorType,
        objectId: candidate.objectId,
        displayName: expect.any(String),
        statuses: expect.any(Array),
        timeline: expect.any(Array),
        productionFacts: expect.any(Array),
        warehouseFacts: expect.any(Array),
      });
      expectSafe(warehouse.body, tokens);
      expectSafe(search.body, tokens);
      expectSafe(context.body, tokens);
    }
  });
});
