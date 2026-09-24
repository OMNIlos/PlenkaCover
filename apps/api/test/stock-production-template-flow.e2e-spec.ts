import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  PRIMARY_BASE_MATERIAL_SELECTION,
  STANDARD_ROLL_DIMENSIONS,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Bearer = { Authorization: string };

describe('stock production template order flow (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let previousDevRole: string | undefined;
  let productionLead: Bearer;
  let commercial: Bearer;
  let warehouse: Bearer;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    // Auth mode is fixed while the application graph is loaded.
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

    const password = e2eSeedPassword();
    const [productionLogin, commercialLogin, warehouseLogin] = await Promise.all([
      http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('production'), password })
        .expect(201),
      http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('commercial'), password })
        .expect(201),
      http()
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin('warehouse'), password })
        .expect(201),
    ]);
    productionLead = {
      Authorization: `Bearer ${productionLogin.body.token as string}`,
    };
    commercial = {
      Authorization: `Bearer ${commercialLogin.body.token as string}`,
    };
    warehouse = {
      Authorization: `Bearer ${warehouseLogin.body.token as string}`,
    };
  });

  afterAll(async () => {
    await app?.close();
    if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevRole;
  });

  it('applies one immutable catalog version exactly once and projects only safe provenance', async () => {
    const suffix = randomUUID().slice(0, 8);
    const createdTemplate = await http()
      .post('/api/commercial/stock-production-templates')
      .set(productionLead)
      .send({
        name: `Запасной рукав 80 ${suffix}`,
        description: 'Шаблон производственного запаса',
        positions: [
          {
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80',
            accountingThickness: '80',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            ...STANDARD_ROLL_DIMENSIONS,
            plannedWeightKg: 40,
          },
        ],
      })
      .expect(201);
    const templateId = createdTemplate.body.id as string;
    const templateVersionId = createdTemplate.body.versions[0].id as string;

    const catalog = await http()
      .get('/api/commercial/stock-production-templates')
      .set(commercial)
      .expect(200);
    expect(catalog.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: templateId,
          versions: expect.arrayContaining([
            expect.objectContaining({ id: templateVersionId, version: 1 }),
          ]),
        }),
      ]),
    );

    const createCommand = {
      clientRequestId: randomUUID(),
      requestType: 'stock_reserve',
      title: `Редактируемый запас ${suffix}`,
      stockProductionTemplateId: templateId,
      stockProductionTemplateVersionId: templateVersionId,
      positions: [
        {
          rollCount: 3,
          filmType: 'Полотно',
          actualThickness: '40',
          accountingThickness: '40',
          ...PRIMARY_BASE_MATERIAL_SELECTION,
          ...STANDARD_ROLL_DIMENSIONS,
          plannedWeightKg: 75,
        },
      ],
    };
    const createdOrder = await http()
      .post('/api/commercial/orders')
      .set(commercial)
      .send(createCommand)
      .expect(201);

    const detail = await http()
      .get(`/api/commercial/orders/${createdOrder.body.id as string}`)
      .set(commercial)
      .expect(200);
    expect(detail.body).toMatchObject({
      id: createdOrder.body.id,
      requestType: 'stock_reserve',
      stockProductionTemplate: {
        id: templateId,
        name: createdTemplate.body.name,
        versionId: templateVersionId,
        version: 1,
      },
      positions: [
        expect.objectContaining({
          rollCount: 3,
          filmType: 'Полотно',
          baseRawMaterialDefinitionId: PRIMARY_BASE_MATERIAL_SELECTION.baseRawMaterialDefinitionId,
        }),
      ],
    });
    expect(Object.keys(detail.body.stockProductionTemplate).sort()).toEqual([
      'id',
      'name',
      'version',
      'versionId',
    ]);

    await http().get('/api/commercial/stock-production-templates').set(warehouse).expect(403);

    const replay = await http()
      .post('/api/commercial/orders')
      .set(commercial)
      .send(createCommand)
      .expect(201);
    expect(replay.body.id).toBe(createdOrder.body.id);

    await expect(
      prisma.commercialOrder.count({ where: { clientRequestId: createCommand.clientRequestId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.stockProductionTemplate.findUniqueOrThrow({
        where: { id: templateId },
        select: { usageCount: true },
      }),
    ).resolves.toEqual({ usageCount: 1 });
    await expect(
      prisma.domainEvent.count({
        where: {
          type: 'audit:stock_production_template_applied',
          objectId: createdOrder.body.id as string,
        },
      }),
    ).resolves.toBe(1);
  });
});
