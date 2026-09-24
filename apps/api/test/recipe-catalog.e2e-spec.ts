import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ROLES } from '@plenka/contracts';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { normalizeCatalogName } from '../src/modules/material-catalog/recipe-catalog.rules';
import { STANDARD_ROLL_DIMENSIONS } from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Bearer = { Authorization: string };

type RecipeResponse = {
  id: string;
  name: string;
  version: {
    id: string;
    version: number;
    ingredients: Array<{
      rawMaterialDefinitionId: string;
      name: string;
      shareBasisPoints: number;
    }>;
  };
};

type RiskItem = {
  rawMaterialDefinitionId: string;
  materialId: string | null;
  plannedNeedQty: number | null;
  stockAvailability: 'available' | 'unavailable';
};

const BASE_PRIMARY_ID = 'rmd-base-primary';
const LOGIN_BY_ROLE: Record<(typeof ROLES)[number], string> = {
  commercial: e2eSeedLogin('commercial'),
  production_lead: e2eSeedLogin('production'),
  operator: e2eSeedLogin('operator'),
  warehouse: e2eSeedLogin('warehouse'),
  finance: e2eSeedLogin('finance'),
  director: e2eSeedLogin('director'),
  admin: e2eSeedLogin('admin'),
};

describe('Material recipe catalog (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let previousDevRole: string | undefined;
  let auth: Record<(typeof ROLES)[number], Bearer>;
  const suiteId = `${Date.now()}-${process.pid}`;

  const http = () => request(app.getHttpServer());
  const command = (
    label: string,
    ingredients: Array<{ rawMaterialDefinitionId: string; shareBasisPoints: number }> = [
      { rawMaterialDefinitionId: BASE_PRIMARY_ID, shareBasisPoints: 10_000 },
    ],
  ) => ({
    clientRequestId: randomUUID(),
    name: `Task 7 ${label} ${suiteId}`,
    ingredients,
  });

  beforeAll(async () => {
    previousDevRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    // The auth mode is fixed before loading the application graph.
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
    const sessions = await Promise.all(
      ROLES.map((role) =>
        http().post('/api/auth/login').send({ login: LOGIN_BY_ROLE[role], password }).expect(201),
      ),
    );
    auth = Object.fromEntries(
      ROLES.map((role, index) => [
        role,
        { Authorization: `Bearer ${sessions[index]!.body.token as string}` },
      ]),
    ) as Record<(typeof ROLES)[number], Bearer>;
  });

  afterAll(async () => {
    await app?.close();
    if (previousDevRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevRole;
  });

  it('enforces the Bearer-session catalog role matrix and rejects anonymous callers', async () => {
    await http().get('/api/material-catalog').expect(401);
    await http().get('/api/recipe-catalog').expect(401);
    await http().post('/api/recipe-catalog').send(command('anonymous')).expect(401);

    for (const role of ROLES) {
      const canRead = ['commercial', 'warehouse', 'production_lead', 'admin'].includes(role);
      const canCreate = ['commercial', 'production_lead'].includes(role);
      const materials = await http()
        .get('/api/material-catalog')
        .set(auth[role])
        .expect(canRead ? 200 : 403);
      await http()
        .get('/api/recipe-catalog')
        .set(auth[role])
        .expect(canRead ? 200 : 403);
      const created = await http()
        .post('/api/recipe-catalog')
        .set(auth[role])
        .send(command(`matrix ${role}`))
        .expect(canCreate ? 201 : 403);

      if (canRead) {
        expect(materials.body).toEqual(
          expect.arrayContaining([{ id: BASE_PRIMARY_ID, name: 'ПВД Первичное', kind: 'base' }]),
        );
      }
      if (canCreate) {
        expect(created.body).toEqual(
          expect.objectContaining({
            id: expect.any(String),
            version: expect.objectContaining({ id: expect.any(String), version: 1 }),
          }),
        );
      }
    }
  });

  it('allows commercial and production-lead creation while keeping runtime projections safe', async () => {
    const commercial = await http()
      .post('/api/recipe-catalog')
      .set(auth.commercial)
      .send(command('commercial create'))
      .expect(201);
    const production = await http()
      .post('/api/recipe-catalog')
      .set(auth.production_lead)
      .send(command('production create'))
      .expect(201);

    expect(commercial.body.id).not.toBe(production.body.id);
    const list = await http().get('/api/recipe-catalog').set(auth.production_lead).expect(200);
    expect(list.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: commercial.body.id }),
        expect.objectContaining({ id: production.body.id }),
      ]),
    );
    const serialized = JSON.stringify(list.body);
    for (const unsafe of [
      'actualQty',
      'externalId',
      'sourceVersion',
      'rawPayload',
      'requestFingerprint',
      'createdById',
    ]) {
      expect(serialized).not.toContain(`"${unsafe}"`);
    }
  });

  it('returns an exact replay without duplicating recipe, version, or audit facts', async () => {
    const body = command('exact replay', [
      { rawMaterialDefinitionId: BASE_PRIMARY_ID, shareBasisPoints: 7_500 },
      { rawMaterialDefinitionId: 'rmd-base-secondary', shareBasisPoints: 2_500 },
    ]);

    const first = await http()
      .post('/api/recipe-catalog')
      .set(auth.commercial)
      .send(body)
      .expect(201);
    const replay = await http()
      .post('/api/recipe-catalog')
      .set(auth.commercial)
      .send(body)
      .expect(201);
    expect(replay.body).toEqual(first.body);

    const recipe = first.body as RecipeResponse;
    expect(recipe.version.ingredients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rawMaterialDefinitionId: 'rmd-base-secondary' }),
      ]),
    );
    await expect(
      prisma.recipeDefinition.count({ where: { clientRequestId: body.clientRequestId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.recipeDefinitionVersion.count({ where: { recipeDefinitionId: recipe.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.recipeIngredient.count({
        where: { recipeDefinitionVersionId: recipe.version.id },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.domainEvent.count({
        where: { type: 'audit:recipe_definition_created', objectId: recipe.id },
      }),
    ).resolves.toBe(1);
    const conflict = await http()
      .post('/api/recipe-catalog')
      .set(auth.commercial)
      .send({ ...body, name: `${body.name} changed` })
      .expect(409);
    expect(conflict.body.code).toBe('RECIPE_REQUEST_ID_CONFLICT');
  });

  it('rolls back every recipe row when a later catalog component is invalid', async () => {
    const body = command('late rollback', [
      { rawMaterialDefinitionId: BASE_PRIMARY_ID, shareBasisPoints: 5_000 },
      { rawMaterialDefinitionId: `missing-${suiteId}`, shareBasisPoints: 5_000 },
    ]);
    const before = await Promise.all([
      prisma.recipeDefinition.count(),
      prisma.recipeDefinitionVersion.count(),
      prisma.recipeIngredient.count(),
      prisma.domainEvent.count(),
    ]);

    const response = await http()
      .post('/api/recipe-catalog')
      .set(auth.production_lead)
      .send(body)
      .expect(409);
    expect(response.body.code).toBe('RAW_MATERIAL_DEFINITION_UNAVAILABLE');

    await expect(
      Promise.all([
        prisma.recipeDefinition.count(),
        prisma.recipeDefinitionVersion.count(),
        prisma.recipeIngredient.count(),
        prisma.domainEvent.count(),
      ]),
    ).resolves.toEqual(before);
    await expect(
      prisma.recipeDefinition.findUnique({ where: { clientRequestId: body.clientRequestId } }),
    ).resolves.toBeNull();
  });

  it('serializes concurrent case-insensitive duplicate names to one winner', async () => {
    const name = `Task 7 concurrent recipe ${suiteId}`;
    const [first, second] = await Promise.all([
      http()
        .post('/api/recipe-catalog')
        .set(auth.commercial)
        .send({ ...command('concurrent A'), name }),
      http()
        .post('/api/recipe-catalog')
        .set(auth.production_lead)
        .send({ ...command('concurrent B'), name: name.toLocaleUpperCase('ru-RU') }),
    ]);

    expect([first.status, second.status].sort()).toEqual([201, 409]);
    const winner = [first, second].find((response) => response.status === 201)!;
    await expect(
      prisma.recipeDefinition.count({
        where: { normalizedName: normalizeCatalogName(name) },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: { type: 'audit:recipe_definition_created', objectId: winner.body.id },
      }),
    ).resolves.toBe(1);
  });

  it('keeps an order snapshot immutable and splits demand while 1C stays hidden', async () => {
    const oneCOperationsBefore = await prisma.oneCStockPushOperation.count();
    await http()
      .get('/api/warehouse/raw-materials/onec-push-preview')
      .set(auth.warehouse)
      .expect(404);
    const isolatedPrimaryName = `Task 7 isolated primary ${suiteId}`;
    const stagedName = `Task 7 catalog-only component ${suiteId}`;
    const isolatedPrimary = await http()
      .post('/api/material-catalog')
      .set(auth.admin)
      .send({ name: isolatedPrimaryName })
      .expect(201);
    const catalogOnly = await http()
      .post('/api/material-catalog')
      .set(auth.admin)
      .send({ name: stagedName })
      .expect(201);
    const createdRecipe = await http()
      .post('/api/recipe-catalog')
      .set(auth.commercial)
      .send(
        command('immutable split', [
          { rawMaterialDefinitionId: isolatedPrimary.body.id, shareBasisPoints: 8_000 },
          { rawMaterialDefinitionId: catalogOnly.body.id, shareBasisPoints: 2_000 },
        ]),
      )
      .expect(201);
    const recipe = createdRecipe.body as RecipeResponse;
    const isolatedPrimaryId = recipe.version.ingredients[0]!.rawMaterialDefinitionId;
    const catalogOnlyId = recipe.version.ingredients[1]!.rawMaterialDefinitionId;

    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(auth.commercial)
      .send({ displayName: `Task 7 snapshot counterparty ${suiteId}` })
      .expect(201);
    const order = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: randomUUID(),
        title: `Task 7 immutable order ${suiteId}`,
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 4,
            filmType: 'Полотно',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            recipeDefinitionVersionId: recipe.version.id,
            ...STANDARD_ROLL_DIMENSIONS,
            plannedWeightKg: 10,
          },
        ],
      })
      .expect(201);
    const positionId = order.body.positions[0].id as string;
    const beforeSnapshot = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: positionId },
      select: {
        recipeDefinitionVersionId: true,
        recipe: {
          select: {
            recipeDefinitionId: true,
            recipeDefinitionVersionId: true,
            recipeVersionNumber: true,
            recipeName: true,
            ingredients: true,
            parameters: true,
          },
        },
      },
    });
    expect(beforeSnapshot).toEqual({
      recipeDefinitionVersionId: recipe.version.id,
      recipe: {
        recipeDefinitionId: recipe.id,
        recipeDefinitionVersionId: recipe.version.id,
        recipeVersionNumber: 1,
        recipeName: recipe.name,
        ingredients: recipe.version.ingredients,
        parameters: [],
      },
    });

    await prisma.$transaction(async (tx) => {
      const next = await tx.recipeDefinitionVersion.create({
        data: { recipeDefinitionId: recipe.id, version: 2 },
      });
      await tx.recipeIngredient.createMany({
        data: [
          {
            recipeDefinitionVersionId: next.id,
            rawMaterialDefinitionId: isolatedPrimaryId,
            sequence: 1,
            shareBasisPoints: 5_000,
          },
          {
            recipeDefinitionVersionId: next.id,
            rawMaterialDefinitionId: catalogOnlyId,
            sequence: 2,
            shareBasisPoints: 5_000,
          },
        ],
      });
    });
    await expect(
      prisma.commercialOrderPosition.findUniqueOrThrow({
        where: { id: positionId },
        select: {
          recipeDefinitionVersionId: true,
          recipe: {
            select: {
              recipeDefinitionId: true,
              recipeDefinitionVersionId: true,
              recipeVersionNumber: true,
              recipeName: true,
              ingredients: true,
              parameters: true,
            },
          },
        },
      }),
    ).resolves.toEqual(beforeSnapshot);

    await http()
      .post(`/api/commercial/orders/${order.body.id}/warehouse-cover/recheck`)
      .set(auth.commercial)
      .send({})
      .expect(201);
    const coverProposal = await http()
      .post(`/api/warehouse/orders/${order.body.id}/cover-proposals`)
      .set(auth.warehouse)
      .send({
        positionId,
        rollIds: [],
        comment: `Task 7 production-only ${suiteId}`,
      })
      .expect(201);
    await http()
      .post(
        `/api/commercial/orders/${order.body.id}/positions/${positionId}/warehouse-cover/` +
          `${coverProposal.body.id as string}/commercial-approval`,
      )
      .set(auth.commercial)
      .send({ expectedVersion: coverProposal.body.version, route: 'production_only' })
      .expect(201);
    const risk = await http()
      .get('/api/commercial/raw-materials?limit=100')
      .set(auth.commercial)
      .expect(200);
    const items = risk.body.items as RiskItem[];
    expect(items.find((item) => item.rawMaterialDefinitionId === isolatedPrimaryId)).toEqual(
      expect.objectContaining({ plannedNeedQty: 32 }),
    );
    expect(items.find((item) => item.rawMaterialDefinitionId === catalogOnlyId)).toEqual(
      expect.objectContaining({
        materialId: null,
        plannedNeedQty: 8,
        stockAvailability: 'unavailable',
      }),
    );

    await http()
      .get('/api/warehouse/raw-materials/onec-push-preview')
      .set(auth.warehouse)
      .expect(404);
    await expect(prisma.oneCStockPushOperation.count()).resolves.toBe(oneCOperationsBefore);
  });

  it('accepts a public base selector and the intentionally seeded historical template', async () => {
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Task 7 selector counterparty ${suiteId}` },
    });
    const baseOrder = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: counterparty.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 1,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            baseRawMaterialDefinitionId: BASE_PRIMARY_ID,
            ...STANDARD_ROLL_DIMENSIONS,
            recipeParameters: [],
          },
        ],
      })
      .expect(201);
    const basePosition = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: baseOrder.body.positions[0].id as string },
      include: { recipe: true },
    });
    expect(basePosition).toEqual(
      expect.objectContaining({
        rawMaterialId: null,
        baseRawMaterialDefinitionId: BASE_PRIMARY_ID,
        recipeDefinitionVersionId: null,
      }),
    );
    expect(basePosition.recipe).toEqual(
      expect.objectContaining({
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: 'ПВД Первичное',
        ingredients: [
          {
            rawMaterialDefinitionId: BASE_PRIMARY_ID,
            name: 'ПВД Первичное',
            shareBasisPoints: 10_000,
          },
        ],
      }),
    );

    const legacyOrder = await http()
      .post('/api/commercial/orders')
      .set(auth.commercial)
      .send({
        clientRequestId: randomUUID(),
        counterpartyId: 'cp-uralpak',
        templateId: 'tpl-uralpak-sleeve-80',
        requestType: 'client_order',
      })
      .expect(201);
    const legacyPosition = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: legacyOrder.body.positions[0].id as string },
      include: { recipe: true },
    });
    expect(legacyPosition).toEqual(
      expect.objectContaining({
        rawMaterialId: 'rm-pvd-15803',
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: null,
      }),
    );
    expect(legacyPosition.recipe).toEqual(
      expect.objectContaining({
        recipeDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeVersionNumber: null,
        recipeName: null,
        ingredients: null,
      }),
    );
  });
});
