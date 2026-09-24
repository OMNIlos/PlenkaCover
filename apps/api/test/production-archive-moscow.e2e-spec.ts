import { randomUUID } from 'node:crypto';
import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Role } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';

describe('Production archive Moscow calendar boundary (e2e, real DB)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let counterpartyId: string | null = null;
  let commercialOrderId: string | null = null;
  let productionOrderId: string | null = null;
  const dispatchIds: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const asProduction = { 'x-role': 'production_lead' };

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'on';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    const counterparty = await prisma.counterparty.create({
      data: { displayName: `Archive Moscow ${suffix}` },
    });
    counterpartyId = counterparty.id;
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `ARCHIVE-MSK-${suffix}`,
        creatorRole: Role.commercial,
        counterpartyId: counterparty.id,
      },
    });
    commercialOrderId = commercialOrder.id;
    const productionOrder = await prisma.productionOrder.create({
      data: { commercialOrderId: commercialOrder.id, approvalState: 'approved' },
    });
    productionOrderId = productionOrder.id;

    const rows = await Promise.all(
      [
        ['before', '2026-07-09T20:59:59.999Z'],
        ['start', '2026-07-09T21:00:00.000Z'],
        ['end', '2026-07-10T20:59:59.999Z'],
        ['next', '2026-07-10T21:00:00.000Z'],
      ].map(([label, completedAt], queueRank) =>
        prisma.rollDispatchItem.create({
          data: {
            rollCode: `ARCHIVE-MSK-${label}-${suffix}`,
            productionOrderId: productionOrder.id,
            queueRank,
            status: 'done',
            completedAt: new Date(completedAt),
          },
        }),
      ),
    );
    dispatchIds.push(...rows.map(({ id }) => id));
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'archive Moscow dispatch rows',
          run: async () => {
            await prisma.rollDispatchItem.deleteMany({ where: { id: { in: dispatchIds } } });
          },
        },
        {
          label: 'archive Moscow production order',
          run: async () => {
            if (productionOrderId) {
              await prisma.productionOrder.delete({ where: { id: productionOrderId } });
            }
          },
        },
        {
          label: 'archive Moscow commercial order',
          run: async () => {
            if (commercialOrderId) {
              await prisma.commercialOrder.delete({ where: { id: commercialOrderId } });
            }
          },
        },
        {
          label: 'archive Moscow counterparty',
          run: async () => {
            if (counterpartyId) {
              await prisma.counterparty.delete({ where: { id: counterpartyId } });
            }
          },
        },
        { label: 'archive Moscow application', run: () => app.close() },
      ],
    );
  });

  it('includes exactly the persisted instants inside one Europe/Moscow business day', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/production/roll-dispatch')
      .set(asProduction)
      .query({ scope: 'archive', date: '2026-07-10' })
      .expect(200);

    const candidateCodes = (response.body as Array<{ rollCode: string }>)
      .map(({ rollCode }) => rollCode)
      .filter((rollCode) => rollCode.endsWith(suffix));
    expect(candidateCodes).toEqual([`ARCHIVE-MSK-start-${suffix}`, `ARCHIVE-MSK-end-${suffix}`]);
  });

  it('rejects an impossible calendar date without changing the persisted archive', async () => {
    const before = await prisma.rollDispatchItem.count({ where: { id: { in: dispatchIds } } });

    await request(app.getHttpServer())
      .get('/api/production/roll-dispatch')
      .set(asProduction)
      .query({ scope: 'archive', dateFrom: '2026-02-30' })
      .expect(409);

    const after = await prisma.rollDispatchItem.count({ where: { id: { in: dispatchIds } } });
    expect({ before, after }).toEqual({ before: 4, after: 4 });
  });

  it.each([
    [{ scope: 'typo', date: '2026-07-10' }, 400],
    [{ scope: 'archive' }, 400],
    [{ scope: 'archive', dateFrom: '2026-07-11', dateTo: '2026-07-10' }, 400],
    [{ scope: 'archive', dateFrom: '2025-01-01', dateTo: '2026-07-10' }, 400],
  ] as const)('rejects an unsafe archive query %j before changing facts', async (query, status) => {
    const before = await prisma.rollDispatchItem.count({ where: { id: { in: dispatchIds } } });

    await request(app.getHttpServer())
      .get('/api/production/roll-dispatch')
      .set(asProduction)
      .query(query)
      .expect(status);

    const after = await prisma.rollDispatchItem.count({ where: { id: { in: dispatchIds } } });
    expect({ before, after }).toEqual({ before: 4, after: 4 });
  });
});
