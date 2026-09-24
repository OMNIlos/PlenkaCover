import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { capabilitiesForRole, type Role } from '@plenka/contracts';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { CapabilityGuard } from '../auth/capability.guard';
import { REQUIRE_CAPABILITIES } from '../auth/require-capabilities.decorator';
import { BigBagRegisterController } from './bigbag-register.controller';
import { BigBagRegisterProjectionService } from './bigbag-register-projection.service';

type QueryRow = {
  id: string | null;
  code: string | null;
  material: string | null;
  batch: string | null;
  createdAt: Date | null;
  status: string | null;
  locationKind: string | null;
  postCode: string | null;
  postName: string | null;
  operatorName: string | null;
  currentWeightKg: number | null;
  priceKopecksPerKg: number | null;
  total: number;
};

function queryRow(id: string, overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    id,
    code: `BB-${id}`,
    material: 'ПВД 10803-020',
    batch: null,
    createdAt: new Date('2026-08-08T06:30:00.000Z'),
    status: 'available',
    locationKind: 'warehouse',
    postCode: null,
    postName: null,
    operatorName: null,
    currentWeightKg: 450,
    priceKopecksPerKg: 2_500,
    total: 1,
    ...overrides,
  };
}

function setup(rows: QueryRow[]) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    bigBagUnit: {
      findMany: jest.fn(() => {
        throw new Error('unbounded ORM read is forbidden');
      }),
    },
  };
  return {
    prisma,
    service: new BigBagRegisterProjectionService(prisma as never),
  };
}

function forbiddenKeys(value: unknown): string[] {
  const forbidden = new Set([
    'rawPayload',
    'machineId',
    'registrationStatus',
    'locationRevision',
    'scanToken',
    'composition',
    'priceKopecksPerKg',
    'operatorId',
    'login',
    'sessionId',
    'usageId',
  ]);
  if (Array.isArray(value)) return value.flatMap(forbiddenKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbidden.has(key) ? [key] : []),
    ...forbiddenKeys(child),
  ]);
}

describe('BigBagRegisterProjectionService', () => {
  it('accepts only bounded safe scalar page rows already derived by PostgreSQL', async () => {
    const { service } = setup([
      queryRow('available', { total: 7 }),
      queryRow('free-production', {
        locationKind: 'production',
        total: 7,
      }),
      queryRow('active', {
        status: 'in_use',
        locationKind: 'post',
        postCode: 'POST-2',
        postName: 'Экструдер 2',
        operatorName: 'Анна Соколова',
        currentWeightKg: 0,
        total: 7,
      }),
    ]);

    const page = await service.list({ page: 3, pageSize: 2 });

    expect(page).toEqual({
      items: [
        {
          id: 'available',
          code: 'BB-available',
          material: 'ПВД 10803-020',
          batch: null,
          createdAt: '2026-08-08T06:30:00.000Z',
          status: 'available',
          location: { kind: 'warehouse', postCode: null, postName: null },
          operatorName: null,
          currentWeightKg: 450,
          totalKopecks: 1_125_000,
        },
        {
          id: 'free-production',
          code: 'BB-free-production',
          material: 'ПВД 10803-020',
          batch: null,
          createdAt: '2026-08-08T06:30:00.000Z',
          status: 'available',
          location: { kind: 'production', postCode: null, postName: null },
          operatorName: null,
          currentWeightKg: 450,
          totalKopecks: 1_125_000,
        },
        {
          id: 'active',
          code: 'BB-active',
          material: 'ПВД 10803-020',
          batch: null,
          createdAt: '2026-08-08T06:30:00.000Z',
          status: 'in_use',
          location: { kind: 'post', postCode: 'POST-2', postName: 'Экструдер 2' },
          operatorName: 'Анна Соколова',
          currentWeightKg: 0,
          totalKopecks: 0,
        },
      ],
      page: 3,
      pageSize: 2,
      total: 7,
    });
  });

  it('emits one parameterized CTE that searches, counts, orders, and limits in PostgreSQL', async () => {
    const { service, prisma } = setup([queryRow('target', { total: 51, batch: 'ПАРТИЯ-77' })]);

    const page = await service.list({ q: '  POST-2  ', page: 2, pageSize: 1 });

    expect(page.total).toBe(51);
    expect(page.items).toHaveLength(1);
    expect(prisma.bigBagUnit.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const statement = prisma.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(statement.values).toEqual(['post-2', 'all', 1, 1]);
    const sql = statement.strings.join('?');
    expect(sql).toMatch(
      /WITH[\s\S]+open_usage_facts[\s\S]+filtered[\s\S]+LIMIT \?[\s\S]+OFFSET \?/u,
    );
    expect(sql).toMatch(/ORDER BY[\s\S]+code[\s\S]+id/u);
    expect(sql).toMatch(/LEFT JOIN users AS operator_actor/u);
    expect(sql).toMatch(/operator_actor\."displayName"/u);
    expect(sql).toMatch(/bag\.location/u);
    expect(sql).not.toMatch(
      /operator_actor\.login|machineId|registrationStatus|scanToken|rawPayload|device/u,
    );
    expect(forbiddenKeys(page)).toEqual([]);
  });

  it('filters the current view before counting and paginating', async () => {
    const { service, prisma } = setup([queryRow('current', { total: 2 })]);
    const query = { view: 'current' as const, page: 1, pageSize: 25 };

    await service.list(query);

    const statement = prisma.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    expect(statement.values).toEqual(['', 'current', 25, 0]);
    expect(statement.strings.join('?')).toMatch(
      /filtered[\s\S]+input\.view = 'all'[\s\S]+projected\.status <> 'consumed'[\s\S]+totals[\s\S]+LIMIT/u,
    );
    expect(statement.strings.join('?')).toMatch(/projected\.current_weight_kg > 0/u);
  });

  it('drops a contradictory row instead of leaking assignment data outside a post', async () => {
    const { service } = setup([
      queryRow('contradictory', {
        locationKind: 'production',
        operatorName: 'Не должен попасть в ответ',
      }),
    ]);

    await expect(service.list({})).resolves.toMatchObject({ items: [], total: 1 });
  });

  it('handles the bounded empty-page sentinel without fabricating a row or losing total', async () => {
    const { service } = setup([
      {
        id: null,
        code: null,
        material: null,
        batch: null,
        createdAt: null,
        status: null,
        locationKind: null,
        postCode: null,
        postName: null,
        operatorName: null,
        currentWeightKg: null,
        priceKopecksPerKg: null,
        total: 27,
      },
    ]);

    await expect(service.list({ page: 99, pageSize: 25 })).resolves.toEqual({
      items: [],
      page: 99,
      pageSize: 25,
      total: 27,
    });
  });
});

const describePostgres = process.env.BIGBAG_REGISTER_POSTGRES === '1' ? describe : describe.skip;

describePostgres('BigBagRegisterProjectionService PostgreSQL CTE', () => {
  const prisma = new PrismaClient();
  const service = new BigBagRegisterProjectionService(prisma as never);
  const bagIds = [
    'task2-bag-available',
    'task2-bag-valid',
    'task2-bag-zero',
    'task2-bag-closed',
    'task2-bag-multiple',
    'task2-bag-consumed',
    'task2-bag-batch',
    'task2-bag-handoff',
  ];
  const sessionIds = [
    'task2-session-valid',
    'task2-session-closed',
    'task2-session-multi-1',
    'task2-session-multi-2',
  ];
  const postIds = ['task2-post-1', 'task2-post-2', 'task2-post-3', 'task2-post-4'];
  const userIds = ['task2-user-1', 'task2-user-2', 'task2-user-3', 'task2-user-4'];

  beforeAll(async () => {
    await prisma.user.createMany({
      data: userIds.map((id, index) => ({
        id,
        login: `${id}@test.invalid`,
        displayName: `Task 2 operator ${index + 1}`,
        role: 'operator',
      })),
    });
    await prisma.post.createMany({
      data: postIds.map((id, index) => ({
        id,
        code: `TASK2-POST-${index + 1}`,
        name: `Экструдер Task 2-${index + 1}`,
      })),
    });
    await prisma.operatorPostSession.createMany({
      data: sessionIds.map((id, index) => ({
        id,
        operatorId: userIds[index],
        postId: postIds[index],
        status: id === 'task2-session-closed' ? 'closed' : 'active',
        ...(id === 'task2-session-closed' ? { endedAt: new Date('2026-08-08T07:00:00Z') } : {}),
      })),
    });
    await prisma.bigBagUnit.createMany({
      data: [
        {
          id: bagIds[0],
          code: 'BB-TASK2-01',
          material: 'ПВД складской',
          status: 'available',
          location: 'warehouse',
          initialKg: 101,
        },
        {
          id: bagIds[1],
          code: 'BB-TASK2-02',
          material: 'ПВД на посту',
          status: 'in_use',
          location: 'production',
          currentKg: null,
          lastMeasuredKg: 222,
          initialKg: 500,
        },
        {
          id: bagIds[2],
          code: 'BB-TASK2-03',
          material: 'ПВД без связи',
          status: 'in_use',
          location: 'production',
        },
        {
          id: bagIds[3],
          code: 'BB-TASK2-04',
          material: 'ПВД закрытая смена',
          status: 'in_use',
          location: 'production',
        },
        {
          id: bagIds[4],
          code: 'BB-TASK2-05',
          material: 'ПВД несколько связей',
          status: 'in_use',
          location: 'production',
        },
        {
          id: bagIds[5],
          code: 'BB-TASK2-06',
          material: 'ПВД израсходованный',
          status: 'consumed',
          location: 'production',
        },
        {
          id: bagIds[6],
          code: 'BB-TASK2-07',
          material: 'Айка',
          batchCode: 'ПАРТИЯ-TASK2-77',
          status: 'available',
          location: 'warehouse',
        },
        {
          id: bagIds[7],
          code: 'BB-TASK2-HANDOFF',
          material: 'ПВД передача оператора',
          status: 'available',
          location: 'production',
        },
      ],
    });
    await prisma.shiftBagUsage.createMany({
      data: [
        {
          id: 'task2-usage-valid',
          sessionId: sessionIds[0],
          bigBagId: bagIds[1],
          startKg: 500,
        },
        {
          id: 'task2-usage-closed',
          sessionId: sessionIds[1],
          bigBagId: bagIds[3],
          startKg: 500,
        },
        {
          id: 'task2-usage-multi-1',
          sessionId: sessionIds[2],
          bigBagId: bagIds[4],
          startKg: 500,
        },
        {
          id: 'task2-usage-multi-2',
          sessionId: sessionIds[3],
          bigBagId: bagIds[4],
          startKg: 450,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.shiftBagUsage.deleteMany({ where: { id: { startsWith: 'task2-usage-' } } });
    await prisma.bigBagUnit.deleteMany({ where: { id: { in: bagIds } } });
    await prisma.operatorPostSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.post.deleteMany({ where: { id: { in: postIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it('derives authoritative locations, fallback weight, stable bounded pages, and exact searches', async () => {
    await expect(service.list({ page: 1, pageSize: 2 })).resolves.toMatchObject({
      items: [
        { id: bagIds[0], location: { kind: 'warehouse' }, currentWeightKg: 101 },
        {
          id: bagIds[1],
          location: {
            kind: 'post',
            postCode: 'TASK2-POST-1',
            postName: 'Экструдер Task 2-1',
          },
          currentWeightKg: 222,
        },
      ],
      total: 8,
    });
    await expect(service.list({ q: 'Местоположение уточняется' })).resolves.toMatchObject({
      items: [
        { id: bagIds[2], location: { kind: 'unknown' } },
        { id: bagIds[3], location: { kind: 'unknown' } },
        { id: bagIds[4], location: { kind: 'unknown' } },
      ],
      total: 3,
    });
    await expect(service.list({ q: 'Склад' })).resolves.toMatchObject({ total: 2 });
    await expect(service.list({ q: 'in_use' })).resolves.toMatchObject({ total: 4 });
    await expect(service.list({ q: 'TASK2-POST-1' })).resolves.toMatchObject({
      items: [{ id: bagIds[1] }],
      total: 1,
    });
    await expect(service.list({ q: 'ПАРТИЯ-TASK2-77' })).resolves.toMatchObject({
      items: [{ id: bagIds[6] }],
      total: 1,
    });
  });

  it('omits consumed and empty available bags before counting and paginating', async () => {
    const emptyId = 'task2-bag-available-zero';
    await prisma.bigBagUnit.create({
      data: {
        id: emptyId,
        code: 'BB-TASK2-ZERO',
        material: 'ПВД нулевой остаток',
        status: 'available',
        location: 'warehouse',
        currentKg: 0,
      },
    });
    try {
      const current = await service.list({ view: 'current', q: 'TASK2', pageSize: 100 });

      expect(current.total).toBe(7);
      expect(current.items.map((item) => item.id)).not.toContain(bagIds[5]);
      expect(current.items.map((item) => item.id)).not.toContain(emptyId);
      await expect(service.list({ view: 'current', q: 'ZERO' })).resolves.toMatchObject({
        items: [],
        total: 0,
      });
      await expect(service.list({ q: 'BB-TASK2-ZERO' })).resolves.toMatchObject({
        items: [{ id: emptyId }],
        total: 1,
      });
    } finally {
      await prisma.bigBagUnit.delete({ where: { id: emptyId } });
    }
  });

  it('moves one production bag from free to operator A, back to free, then operator B', async () => {
    const bagId = bagIds[7];

    await expect(service.list({ q: 'BB-TASK2-HANDOFF' })).resolves.toMatchObject({
      items: [
        {
          id: bagId,
          location: { kind: 'production', postCode: null, postName: null },
          operatorName: null,
        },
      ],
      total: 1,
    });
    await expect(service.list({ q: 'Свободен' })).resolves.toMatchObject({
      items: [{ id: bagId }],
      total: 1,
    });

    await prisma.$transaction([
      prisma.bigBagUnit.update({ where: { id: bagId }, data: { status: 'in_use' } }),
      prisma.shiftBagUsage.create({
        data: {
          id: 'task2-usage-handoff-a',
          sessionId: sessionIds[0],
          bigBagId: bagId,
          startKg: 500,
        },
      }),
    ]);
    await expect(service.list({ q: 'Task 2 operator 1' })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: bagId,
          location: expect.objectContaining({ kind: 'post' }),
          operatorName: 'Task 2 operator 1',
        }),
      ]),
    });
    await expect(service.list({ q: 'Свободен' })).resolves.toMatchObject({ total: 0 });
    await expect(service.list({ q: 'Используется' })).resolves.toMatchObject({ total: 2 });

    await prisma.$transaction([
      prisma.shiftBagUsage.update({
        where: {
          sessionId_bigBagId: { sessionId: sessionIds[0], bigBagId: bagId },
        },
        data: { closedAt: new Date('2026-08-13T12:00:00.000Z'), endKg: 420 },
      }),
      prisma.bigBagUnit.update({ where: { id: bagId }, data: { status: 'available' } }),
    ]);
    await expect(service.list({ q: 'Свободен' })).resolves.toMatchObject({
      items: [
        {
          id: bagId,
          location: { kind: 'production', postCode: null, postName: null },
          operatorName: null,
        },
      ],
      total: 1,
    });

    await prisma.$transaction([
      prisma.bigBagUnit.update({ where: { id: bagId }, data: { status: 'in_use' } }),
      prisma.shiftBagUsage.create({
        data: {
          id: 'task2-usage-handoff-b',
          sessionId: sessionIds[2],
          bigBagId: bagId,
          startKg: 420,
        },
      }),
    ]);
    await expect(service.list({ q: 'Task 2 operator 3' })).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: bagId,
          location: expect.objectContaining({ kind: 'post' }),
          operatorName: 'Task 2 operator 3',
        }),
      ]),
    });
  });
});

describe('BigBagRegisterController access and role parity', () => {
  let app: INestApplication;
  const projection = {
    list: jest.fn().mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BigBagRegisterController],
      providers: [{ provide: BigBagRegisterProjectionService, useValue: projection }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const role = req.header('x-test-role') as Role;
      Object.assign(req, {
        actor: { userId: `${role}-1`, role, capabilities: capabilitiesForRole(role) },
      });
      next();
    });
    app.useGlobalGuards(new CapabilityGuard(moduleRef.get(Reflector)));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  beforeEach(() => projection.list.mockClear());

  it('uses one role-neutral route guarded only by raw_material:read', () => {
    expect(
      Reflect.getMetadata(REQUIRE_CAPABILITIES, BigBagRegisterController.prototype.list),
    ).toEqual(['raw_material:read']);
  });

  it('accepts the current register view', async () => {
    await request(app.getHttpServer())
      .get('/api/raw-materials/big-bags?view=current')
      .set('x-test-role', 'director')
      .expect(200);

    expect(projection.list).toHaveBeenCalledWith({ page: 1, pageSize: 25, view: 'current' });
  });

  it('returns identical data to Commerce, Production, Director, and Warehouse', async () => {
    for (const role of ['commercial', 'production_lead', 'director', 'warehouse'] as const) {
      await request(app.getHttpServer())
        .get('/api/raw-materials/big-bags?q=%D0%B0%D0%B9%D0%BA%D0%B0&page=2&pageSize=10')
        .set('x-test-role', role)
        .expect(200)
        .expect({ items: [], page: 1, pageSize: 25, total: 0 });
    }
    for (const role of ['operator', 'finance', 'admin'] as const) {
      await request(app.getHttpServer())
        .get('/api/raw-materials/big-bags')
        .set('x-test-role', role)
        .expect(403);
    }
    for (let call = 1; call <= 4; call += 1) {
      expect(projection.list).toHaveBeenNthCalledWith(call, {
        q: 'айка',
        page: 2,
        pageSize: 10,
      });
    }
  });
});
