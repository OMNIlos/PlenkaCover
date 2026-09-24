import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OneCHealthResult, OneCNomenclatureSnapshot } from '@plenka/contracts';
import request from 'supertest';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import type { OneCAdapter } from '../src/integrations/onec/onec.adapter';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

const CAPTURED_AT = '2026-07-29T08:00:00.000Z';
const NOMENCLATURE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

function fakeAdapter(): OneCAdapter {
  const nomenclature: OneCNomenclatureSnapshot = {
    sourceKind: '1C',
    subjectType: 'nomenclature',
    externalId: NOMENCLATURE_ID,
    sourceVersion: 'stable-v1',
    staleness: 'fresh',
    capturedAt: CAPTURED_AT,
    parsed: {
      code: '00-000001',
      article: 'ПВД-020',
      name: 'ПВД 15803-020',
      fullName: 'ПВД 15803-020',
      kindExternalId: 'kind-raw',
      kindName: 'Сырье',
      unitExternalId: 'unit-kg',
      unitName: 'кг',
      deleted: false,
      archived: false,
    },
    rawPayload: { secretFrame: 'admin diagnostics only' },
  };
  const health: OneCHealthResult = {
    mode: 'mock',
    status: 'ready',
    checkedAt: CAPTURED_AT,
    latencyMs: 1,
  };
  return {
    stockPushConfiguration: () => ({ mode: 'mock', enabled: false }),
    checkHealth: async () => health,
    pullNomenclature: async ({ skip = 0 } = {}) => (skip === 0 ? [nomenclature] : []),
    pullCounterparties: async () => [],
    pullOrganizations: async () => [],
    pullWarehouses: async () => [],
    pullInvoices: async () => [],
    pullInvoiceLines: async () => [],
    pullPayments: async () => [],
    pullShipments: async () => [],
    pullShipmentLines: async () => [],
    pullProductionReports: async () => [],
    pullProductionOutputLines: async () => [],
    pullProductionMaterialLines: async () => [],
    pullBalances: async () => [],
    pullCounterparty: async () => {
      throw new Error('Single-record pull is outside this acceptance scenario.');
    },
    pullInvoice: async () => {
      throw new Error('Single-record pull is outside this acceptance scenario.');
    },
    findInvoicesByOrderReference: async () => [],
    findInvoicesByExactNumber: async () => [],
    pullInvoiceByExternalId: async () => {
      throw new Error('Exact invoice pull is outside this acceptance scenario.');
    },
    pullPaymentByExternalId: async () => {
      throw new Error('Exact payment pull is outside this acceptance scenario.');
    },
    pullStock: async () => [],
    pushStock: async () => {
      throw new Error('Writes are disabled in production sync acceptance.');
    },
  };
}

describe('1C production synchronization (e2e, Bearer + PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const savedEnv: Record<string, string | undefined> = {};
  const flags = {
    AUTH_DEV_XROLE: 'off',
    ONEC_BASE_URL: 'http://127.0.0.1:1/e2e-fake-onec',
    ONEC_LIVE: 'true',
    ONEC_PASSWORD: 'e2e-fake-password',
    ONEC_SYNC_ENABLED: 'false',
    ONEC_USERNAME: 'e2e-fake-user',
    ONEC_WRITE: 'false',
  } as const;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(flags)) {
      savedEnv[key] = process.env[key];
      process.env[key] = value;
    }

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module');
    const { PrismaService: PrismaServiceClass } = require('../src/common/prisma/prisma.service');
    const { ONEC_ADAPTER } = require('../src/integrations/onec/onec.adapter');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ONEC_ADAPTER)
      .useValue(fakeAdapter())
      .compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaServiceClass);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
  });

  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('previews without writes, applies exact names and blocks raw payload from business roles', async () => {
    const http = () => request(app.getHttpServer());
    const [adminLogin, commercialLogin] = await Promise.all([
      http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
        .expect(201),
      http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('commercial'), password: e2eSeedPassword() })
        .expect(201),
    ]);
    const asAdmin = { Authorization: `Bearer ${adminLogin.body.token as string}` };
    const asCommercial = {
      Authorization: `Bearer ${commercialLogin.body.token as string}`,
    };
    const physicalStockBefore = await prisma.rawMaterialStock.findMany({
      select: {
        materialId: true,
        actualQty: true,
        factStatus: true,
        revision: true,
      },
      orderBy: { materialId: 'asc' },
    });

    const preview = await http().post('/api/admin/onec/sync/preview').set(asAdmin).expect(201);
    expect(preview.body).toMatchObject({
      status: 'completed',
      counters: { nomenclature: { fetched: 1, created: 1 } },
    });
    await expect(prisma.oneCNomenclatureItem.count()).resolves.toBe(0);
    await expect(
      prisma.rawMaterialDefinition.count({ where: { externalId: NOMENCLATURE_ID } }),
    ).resolves.toBe(0);

    const applied = await http().post('/api/admin/onec/sync/run').set(asAdmin).expect(201);
    expect(applied.body).toMatchObject({
      status: 'completed',
      counters: { nomenclature: { fetched: 1, created: 1 } },
    });
    await expect(prisma.oneCNomenclatureItem.count()).resolves.toBe(1);
    await expect(
      prisma.rawMaterialStock.findMany({
        select: {
          materialId: true,
          actualQty: true,
          factStatus: true,
          revision: true,
        },
        orderBy: { materialId: 'asc' },
      }),
    ).resolves.toEqual(physicalStockBefore);

    const materials = await http().get('/api/material-catalog').set(asCommercial).expect(200);
    expect(materials.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'ПВД 15803-020', kind: 'custom' })]),
    );

    const generic = await http()
      .get('/api/material-catalog/onec')
      .set(asCommercial)
      .query({ search: '15803', page: 1, pageSize: 10 })
      .expect(200);
    expect(generic.body.items).toEqual([
      {
        externalId: NOMENCLATURE_ID,
        code: '00-000001',
        article: 'ПВД-020',
        name: 'ПВД 15803-020',
        kindName: 'Сырье',
        unitName: 'кг',
        archived: false,
      },
    ]);
    expect(JSON.stringify(generic.body)).not.toMatch(/rawPayload|secretFrame|sourceVersion/i);

    const snapshots = await http()
      .get('/api/admin/onec/snapshots')
      .set(asAdmin)
      .query({ subjectType: 'nomenclature', page: 1, pageSize: 10 })
      .expect(200);
    const snapshotId = snapshots.body.items[0]?.id as string;
    expect(snapshotId).toBeTruthy();
    await http().get(`/api/admin/onec/snapshots/${snapshotId}/raw`).set(asCommercial).expect(403);
  });
});
