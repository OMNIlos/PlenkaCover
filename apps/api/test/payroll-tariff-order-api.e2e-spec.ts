import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@plenka/contracts';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { LEGACY_PAYROLL_TARIFF_MATRIX_V1 } from '../src/common/payroll-tariffs/payroll-tariff-engine';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';
import { runE2eWithCleanup } from './e2e-database';

type SeedAccount =
  | 'commercial'
  | 'production'
  | 'operator'
  | 'warehouse'
  | 'finance'
  | 'director'
  | 'admin';
type Bearer = { Authorization: string };

const roles: Array<{ account: SeedAccount; role: Role }> = [
  { account: 'commercial', role: 'commercial' },
  { account: 'production', role: 'production_lead' },
  { account: 'operator', role: 'operator' },
  { account: 'warehouse', role: 'warehouse' },
  { account: 'finance', role: 'finance' },
  { account: 'director', role: 'director' },
  { account: 'admin', role: 'admin' },
];

function createPayload(effectiveFrom: string) {
  return {
    operationKey: randomUUID(),
    name: `Приказ API ${randomUUID().slice(0, 8)}`,
    effectiveFrom,
    matrix: structuredClone(LEGACY_PAYROLL_TARIFF_MATRIX_V1),
  };
}

describe('payroll tariff order API (e2e, Bearer + PostgreSQL)', () => {
  let app: INestApplication;
  let auth: Record<Role, Bearer>;
  const previousDevActor = process.env.AUTH_DEV_XROLE;

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'off';
    // AppModule reads authentication flags during module loading.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const entries = await Promise.all(
      roles.map(async ({ account, role }) => {
        const response = await request(app.getHttpServer())
          .post('/api/auth/login')
          .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
          .expect(201);
        return [role, { Authorization: `Bearer ${response.body.token as string}` }] as const;
      }),
    );
    auth = Object.fromEntries(entries) as Record<Role, Bearer>;
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        { label: 'payroll tariff API application', run: async () => app?.close() },
        {
          label: 'payroll tariff API auth environment',
          run: () => {
            if (previousDevActor === undefined) delete process.env.AUTH_DEV_XROLE;
            else process.env.AUTH_DEV_XROLE = previousDevActor;
          },
        },
      ],
    );
  });

  it('enforces base capabilities for all seven roles and runs the full director workflow', async () => {
    const http = () => request(app.getHttpServer());
    const list = await http()
      .get('/api/director/payroll-tariff-orders')
      .set(auth.director)
      .expect(200);
    expect(list.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'payroll-tariff-order-8-09-25-2025-09-29',
          status: 'published',
        }),
      ]),
    );
    expect(JSON.stringify(list.body)).not.toMatch(/rawPayload|token|password|oneC|device/iu);

    for (const { role } of roles) {
      if (role !== 'director') {
        await http().get('/api/director/payroll-tariff-orders').set(auth[role]).expect(403);
        await http()
          .post('/api/director/payroll-tariff-orders')
          .set(auth[role])
          .send(createPayload(list.body.minimumPublishEffectiveFrom as string))
          .expect(403);
      }
    }

    const created = await http()
      .post('/api/director/payroll-tariff-orders')
      .set(auth.director)
      .send(createPayload(list.body.minimumPublishEffectiveFrom as string))
      .expect(201);
    expect(created.body).toMatchObject({ replayed: false, order: { status: 'draft', revision: 1 } });
    const orderId = created.body.order.id as string;

    const detail = await http()
      .get(`/api/director/payroll-tariff-orders/${orderId}`)
      .set(auth.director)
      .expect(200);
    expect(detail.body.matrix).toEqual(LEGACY_PAYROLL_TARIFF_MATRIX_V1);
    expect(JSON.stringify(detail.body.matrix)).not.toMatch(/rawPayload|oneC|device/iu);

    const updated = await http()
      .patch(`/api/director/payroll-tariff-orders/${orderId}`)
      .set(auth.director)
      .send({
        ...createPayload(list.body.minimumPublishEffectiveFrom as string),
        name: 'Приказ API — уточнённый',
        expectedRevision: 1,
      })
      .expect(200);
    expect(updated.body.order).toMatchObject({ revision: 2, status: 'draft' });

    const review = await http()
      .post(`/api/director/payroll-tariff-orders/${orderId}/review`)
      .set(auth.director)
      .send({ expectedRevision: 2 })
      .expect(200);
    expect(review.body).toMatchObject({
      orderId,
      revision: 2,
      publishable: true,
      matrixHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const published = await http()
      .post(`/api/director/payroll-tariff-orders/${orderId}/publish`)
      .set(auth.director)
      .send({
        operationKey: randomUUID(),
        expectedRevision: 2,
        reviewedMatrixHash: review.body.matrixHash,
      })
      .expect(201);
    expect(published.body.order).toMatchObject({ id: orderId, status: 'published' });
  });

  it('rejects unknown nested fields and maps domain validation to a safe error body', async () => {
    const http = () => request(app.getHttpServer());
    const list = await http()
      .get('/api/director/payroll-tariff-orders')
      .set(auth.director)
      .expect(200);
    const unknown = createPayload(list.body.minimumPublishEffectiveFrom as string);
    Object.assign(unknown.matrix.specialRules.alabuga, { rawPayload: { password: 'secret' } });
    await http()
      .post('/api/director/payroll-tariff-orders')
      .set(auth.director)
      .send(unknown)
      .expect(400);

    const invalid = createPayload(list.body.minimumPublishEffectiveFrom as string);
    invalid.matrix.ladders.urp12h[1]!.maxInclusiveGrams = 750_000;
    const response = await http()
      .post('/api/director/payroll-tariff-orders')
      .set(auth.director)
      .send(invalid)
      .expect(422);
    expect(response.body).toEqual({
      code: 'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      message: expect.any(String),
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({
          path: 'ladders.urp12h[1].maxInclusiveGrams',
          code: 'threshold_not_increasing',
        }),
      ]),
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('honors a database capability grant through the global guard', async () => {
    const prisma = app.get(PrismaService);
    const [finance, admin] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { login: e2eSeedLogin('finance') } }),
      prisma.user.findUniqueOrThrow({ where: { login: e2eSeedLogin('admin') } }),
    ]);
    await prisma.userCapabilityOverride.create({
      data: {
        userId: finance.id,
        capability: 'payroll_tariff:manage',
        effect: 'allow',
        reason: 'E2E delegated tariff workflow',
        createdById: admin.id,
        updatedById: admin.id,
      },
    });

    try {
      const directorList = await request(app.getHttpServer())
        .get('/api/director/payroll-tariff-orders')
        .set(auth.director)
        .expect(200);
      const created = await request(app.getHttpServer())
        .post('/api/director/payroll-tariff-orders')
        .set(auth.finance)
        .send(createPayload(directorList.body.minimumPublishEffectiveFrom as string))
        .expect(201);
      expect(created.body.order.createdById).toBe(finance.id);
    } finally {
      await prisma.userCapabilityOverride.deleteMany({
        where: { userId: finance.id, capability: 'payroll_tariff:manage' },
      });
    }
  });
});
