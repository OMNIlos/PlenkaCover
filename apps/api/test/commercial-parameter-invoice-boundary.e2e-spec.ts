import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import {
  approveProductionOnlyCover,
  PRIMARY_BASE_MATERIAL_SELECTION,
} from './commercial-e2e-helpers';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

type Headers = Record<string, string>;

type HandoffFixture = {
  financeOrderId: string;
  orderId: string;
  positionId: string;
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

const RACE_DEADLINE_MS = 12_000;
const INVOICE_LOCK_CODE = 'COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE';

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withRaceDeadline<T>(operation: () => Promise<T>): Promise<T> {
  let deadline: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Invoice/amendment race exceeded ${RACE_DEADLINE_MS} ms`)),
          RACE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function waitForInvoiceBoundaryLockWaiters(
  prisma: PrismaService,
  minimumWaiters: number,
): Promise<void> {
  await withRaceDeadline(async () => {
    for (;;) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND wait_event ILIKE '%advisory%'
      `);
      if ((row?.count ?? 0) >= minimumWaiters) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
}

async function raceFromInvoiceBoundaryBarrier<L, R>(
  observer: PrismaService,
  orderId: string,
  left: () => Promise<L>,
  right: () => Promise<R>,
): Promise<readonly [PromiseSettledResult<L>, PromiseSettledResult<R>]> {
  const blocker = new PrismaClient();
  const rowLocked = deferred();
  const releaseRow = deferred();
  const holder = blocker.$transaction(
    async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`commercial-invoice-boundary:${orderId}`}, 0)
        )::text AS "lock"
      `);
      rowLocked.resolve();
      await releaseRow.promise;
    },
    { timeout: RACE_DEADLINE_MS },
  );

  try {
    await withRaceDeadline(() => rowLocked.promise);
    // The invoice request waits on this boundary. Amendment attempts never wait inside their
    // Serializable transaction; they restart so the next attempt gets a fresh snapshot.
    const leftResult = left();
    const rightResult = right();
    await waitForInvoiceBoundaryLockWaiters(observer, 1);
    releaseRow.resolve();
    const settled = await withRaceDeadline(() => Promise.allSettled([leftResult, rightResult]));
    await holder;
    return settled as readonly [PromiseSettledResult<L>, PromiseSettledResult<R>];
  } finally {
    releaseRow.resolve();
    await Promise.allSettled([holder, blocker.$disconnect()]);
  }
}

function fulfilledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status !== 'fulfilled') throw result.reason;
  return result.value;
}

describe('Commercial parameter invoice boundary (e2e, Bearer + PostgreSQL)', () => {
  jest.setTimeout(120_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let asCommercial: Headers;
  let asFinance: Headers;
  let savedAuthDevXRole: string | undefined;

  const http = () => request(app.getHttpServer());

  async function bearerFor(account: Parameters<typeof e2eSeedLogin>[0]): Promise<Headers> {
    const response = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin(account), password: e2eSeedPassword() })
      .expect(201);
    return { Authorization: `Bearer ${response.body.token as string}` };
  }

  async function createHandoffFixture(label: string): Promise<HandoffFixture> {
    const suffix = randomUUID().slice(0, 8);
    const counterparty = await http()
      .post('/api/commercial/counterparties')
      .set(asCommercial)
      .send({ displayName: `Invoice boundary ${label} ${suffix}` })
      .expect(201);
    const created = await http()
      .post('/api/commercial/orders')
      .set(asCommercial)
      .send({
        clientRequestId: randomUUID(),
        mode: 'submit',
        counterpartyId: counterparty.body.id,
        requestType: 'client_order',
        positions: [
          {
            rollCount: 2,
            filmType: 'Рукав',
            actualThickness: '80 мкм',
            accountingThickness: '78 мкм',
            ...PRIMARY_BASE_MATERIAL_SELECTION,
            widthMm: 1500,
            plannedLengthM: 300,
            comment: 'Исходные параметры',
            recipeParameters: [{ label: 'Сырьё', value: 'ПВД первичное' }],
          },
        ],
      })
      .expect(201);
    await approveProductionOnlyCover(app, prisma, asCommercial, created.body);
    await http()
      .post(`/api/commercial/orders/${created.body.id}/invoice-handoff`)
      .set(asCommercial)
      .send({ amount: 125_000, note: `Invoice boundary ${label}` })
      .expect(201);

    const financeOrders = await http().get('/api/finance/orders').set(asFinance).expect(200);
    const financeOrder = financeOrders.body.find(
      (candidate: { commercialOrder?: { id: string } }) =>
        candidate.commercialOrder?.id === created.body.id,
    );
    expect(financeOrder).toBeTruthy();

    return {
      financeOrderId: financeOrder.id as string,
      orderId: created.body.id as string,
      positionId: created.body.positions[0].id as string,
    };
  }

  beforeAll(async () => {
    savedAuthDevXRole = process.env.AUTH_DEV_XROLE;
    process.env.AUTH_DEV_XROLE = 'off';
    // App configuration is evaluated during import; exercise real per-user inbox receipts.
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
    [asCommercial, asFinance] = await Promise.all([bearerFor('commercial'), bearerFor('finance')]);
  });

  afterAll(async () => {
    await app?.close();
    if (savedAuthDevXRole === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = savedAuthDevXRole;
  });

  it('amends every governed parameter before invoice, notifies finance once, then locks both routes', async () => {
    const fixture = await createHandoffFixture('lifecycle');
    const before = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    const initialPosition = before.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );
    expect(before.body.edit).toMatchObject({
      parametersAllowed: false,
      parametersAmendable: true,
      parametersLockReason: null,
    });

    const eventCountBeforeAmendment = await prisma.domainEvent.count({
      where: { objectId: fixture.orderId },
    });
    const notificationCountBefore = await prisma.domainEvent.count({
      where: {
        objectId: fixture.orderId,
        type: 'notification:commercial_order_amended',
      },
    });
    const amendment = {
      kind: 'update_position',
      operationKey: randomUUID(),
      expectedOrderVersion: before.body.version,
      expectedPositionVersion: initialPosition.version,
      reason: 'Клиент уточнил параметры до выставления счёта',
      positionId: fixture.positionId,
      changes: {
        rollCount: 4,
        filmType: 'Полотно',
        actualThickness: '90 мкм',
        accountingThickness: '88 мкм',
        widthMm: 1600,
        plannedLengthM: 320,
        plannedWeightKg: 55,
        baseRawMaterialDefinitionId: 'rmd-base-secondary',
        spoolType: '152 мм',
        birka: 'Маркировка клиента',
        manualBirka: 'Бирка №42',
        recipeParameters: [
          { label: 'Сырьё', value: 'ПВД вторичное' },
          { label: 'Добавка', value: 'Стабилизатор 2%' },
        ],
        comment: 'Уточнено клиентом',
      },
    };
    await http()
      .post(`/api/commercial/orders/${fixture.orderId}/amendments`)
      .set(asCommercial)
      .send(amendment)
      .expect(201);

    const updated = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    const updatedPosition = updated.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );
    expect(updatedPosition).toMatchObject({
      rollCount: 4,
      filmType: 'Полотно',
      actualThickness: '90 мкм',
      accountingThickness: '88 мкм',
      widthMm: 1600,
      plannedLengthM: 320,
      plannedWeightKg: 55,
      baseRawMaterialDefinitionId: 'rmd-base-secondary',
      spoolType: '152 мм',
      birka: 'Маркировка клиента',
      manualBirka: 'Бирка №42',
      comment: 'Уточнено клиентом',
      version: initialPosition.version + 1,
    });

    const persistedPosition = await prisma.commercialOrderPosition.findUniqueOrThrow({
      where: { id: fixture.positionId },
      select: {
        baseRawMaterialDefinitionId: true,
        recipe: { select: { parameters: true } },
      },
    });
    expect(persistedPosition).toEqual({
      baseRawMaterialDefinitionId: 'rmd-base-secondary',
      recipe: {
        parameters: [
          { label: 'Сырьё', value: 'ПВД вторичное' },
          { label: 'Добавка', value: 'Стабилизатор 2%' },
        ],
      },
    });

    const eventCountAfterAmendment = await prisma.domainEvent.count({
      where: { objectId: fixture.orderId },
    });
    expect(eventCountAfterAmendment - eventCountBeforeAmendment).toBe(3);
    const notificationEvents = await prisma.domainEvent.findMany({
      where: {
        objectId: fixture.orderId,
        type: 'notification:commercial_order_amended',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(notificationEvents).toHaveLength(notificationCountBefore + 1);
    const notificationEvent = notificationEvents.at(-1)!;
    expect(notificationEvent.detail).toMatchObject({
      orderId: fixture.orderId,
      financeOrderId: fixture.financeOrderId,
      positionId: fixture.positionId,
      positionIds: [fixture.positionId],
      changedFields: [
        'accountingThickness',
        'actualThickness',
        'baseRawMaterialDefinitionId',
        'birka',
        'comment',
        'filmType',
        'manualBirka',
        'plannedLengthM',
        'plannedWeightKg',
        'recipeParameters',
        'rollCount',
        'spoolType',
        'widthMm',
      ],
      recipientRoles: expect.arrayContaining(['finance']),
    });

    const financeInbox = await http()
      .get('/api/finance/notifications?limit=100')
      .set(asFinance)
      .expect(200);
    const amendmentItems = financeInbox.body.items.filter(
      (item: { eventType: string; orderId: string | null }) =>
        item.eventType === 'notification:commercial_order_amended' &&
        item.orderId === fixture.orderId,
    );
    expect(amendmentItems).toHaveLength(1);
    expect(amendmentItems[0]).toMatchObject({
      id: notificationEvent.id,
      orderId: fixture.orderId,
      financeOrderId: fixture.financeOrderId,
      positionId: fixture.positionId,
      cta: { kind: 'finance_order', targetId: fixture.financeOrderId },
    });
    expect(amendmentItems[0].body).toContain(
      'Коммерция изменила параметры заявки: учётная толщина, фактическая толщина',
    );
    expect(amendmentItems[0].body).toContain('количество рулонов');
    expect(amendmentItems[0].body).toContain('ширина');

    await http()
      .put(`/api/finance/notifications/${notificationEvent.id}/read`)
      .set(asFinance)
      .expect(200)
      .expect({ ok: true, eventId: notificationEvent.id });
    const inboxAfterRead = await http()
      .get('/api/finance/notifications?limit=100')
      .set(asFinance)
      .expect(200);
    expect(
      inboxAfterRead.body.items.filter(
        (item: { eventType: string; orderId: string | null }) =>
          item.eventType === 'notification:commercial_order_amended' &&
          item.orderId === fixture.orderId,
      ),
    ).toHaveLength(0);

    await http()
      .post(`/api/finance/orders/${fixture.financeOrderId}/invoices`)
      .set(asFinance)
      .send({ amount: 125_000, paymentTermsType: 'prepay_50_postpay_50_30d' })
      .expect(201);
    const afterInvoice = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    const lockedPosition = afterInvoice.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );
    expect(afterInvoice.body.edit).toMatchObject({
      parametersAllowed: false,
      parametersAmendable: false,
      parametersLockReason: 'invoice_issued',
    });
    const boundaryEventCount = await prisma.domainEvent.count({
      where: { objectId: fixture.orderId },
    });

    await http()
      .post(`/api/commercial/orders/${fixture.orderId}/amendments`)
      .set(asCommercial)
      .send({
        ...amendment,
        operationKey: randomUUID(),
        expectedOrderVersion: afterInvoice.body.version,
        expectedPositionVersion: lockedPosition.version,
        changes: { widthMm: 1650 },
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe(INVOICE_LOCK_CODE);
      });
    await http()
      .patch(`/api/commercial/orders/${fixture.orderId}/positions/${fixture.positionId}`)
      .set(asCommercial)
      .send({ expectedVersion: lockedPosition.version, widthMm: 1650 })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe(INVOICE_LOCK_CODE);
      });

    const afterRejectedChanges = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    expect(
      afterRejectedChanges.body.positions.find(
        (position: { id: string }) => position.id === fixture.positionId,
      ),
    ).toMatchObject({
      version: lockedPosition.version,
      rollCount: 4,
      filmType: 'Полотно',
      actualThickness: '90 мкм',
      accountingThickness: '88 мкм',
      widthMm: 1600,
      plannedLengthM: 320,
      plannedWeightKg: 55,
      baseRawMaterialDefinitionId: 'rmd-base-secondary',
      spoolType: '152 мм',
      birka: 'Маркировка клиента',
      manualBirka: 'Бирка №42',
      comment: 'Уточнено клиентом',
    });
    await expect(prisma.domainEvent.count({ where: { objectId: fixture.orderId } })).resolves.toBe(
      boundaryEventCount,
    );
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: fixture.orderId,
          type: 'notification:commercial_order_amended',
        },
      }),
    ).resolves.toBe(notificationCountBefore + 1);
  });

  it('treats an unchanged HTTP recipe snapshot as a no-op without versions or notifications', async () => {
    const fixture = await createHandoffFixture('recipe-no-op');
    const before = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    const initialPosition = before.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );
    const eventCountBefore = await prisma.domainEvent.count({
      where: { objectId: fixture.orderId },
    });

    await http()
      .post(`/api/commercial/orders/${fixture.orderId}/amendments`)
      .set(asCommercial)
      .send({
        kind: 'update_position',
        operationKey: randomUUID(),
        expectedOrderVersion: before.body.version,
        expectedPositionVersion: initialPosition.version,
        reason: 'Повторно сохранена неизменная рецептура',
        positionId: fixture.positionId,
        changes: {
          recipeParameters: [{ label: 'Сырьё', value: 'ПВД первичное' }],
        },
      })
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe('COMMERCIAL_AMENDMENT_NO_CHANGES');
      });

    const after = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    expect(after.body.version).toBe(before.body.version);
    expect(
      after.body.positions.find((position: { id: string }) => position.id === fixture.positionId)
        .version,
    ).toBe(initialPosition.version);
    await expect(prisma.domainEvent.count({ where: { objectId: fixture.orderId } })).resolves.toBe(
      eventCountBefore,
    );
  });

  it('serializes simultaneous invoice issuance and amendment without deadlock or a late commit', async () => {
    const fixture = await createHandoffFixture('race');
    const before = await http()
      .get(`/api/commercial/orders/${fixture.orderId}`)
      .set(asCommercial)
      .expect(200);
    const initialPosition = before.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );

    const [invoiceResult, amendmentResult] = await raceFromInvoiceBoundaryBarrier(
      prisma,
      fixture.orderId,
      async () =>
        http()
          .post(`/api/finance/orders/${fixture.financeOrderId}/invoices`)
          .set(asFinance)
          .send({ amount: 125_000, paymentTermsType: 'prepay_50_postpay_50_30d' }),
      async () =>
        http()
          .post(`/api/commercial/orders/${fixture.orderId}/amendments`)
          .set(asCommercial)
          .send({
            kind: 'update_position',
            operationKey: randomUUID(),
            expectedOrderVersion: before.body.version,
            expectedPositionVersion: initialPosition.version,
            reason: 'Одновременное изменение со счётом',
            positionId: fixture.positionId,
            changes: { widthMm: 1750 },
          }),
    );
    const invoiceResponse = fulfilledValue(invoiceResult);
    const amendmentResponse = fulfilledValue(amendmentResult);
    expect(invoiceResponse.status).toBe(201);
    expect([201, 409]).toContain(amendmentResponse.status);
    if (amendmentResponse.status === 409) {
      expect(amendmentResponse.body.code).toBe(INVOICE_LOCK_CODE);
    }

    const [finalOrder, financeBoundary, amendmentEvents, notificationCount] = await Promise.all([
      http().get(`/api/commercial/orders/${fixture.orderId}`).set(asCommercial).expect(200),
      prisma.financeOrder.findUniqueOrThrow({
        where: { id: fixture.financeOrderId },
        select: { invoiceStatus: true, invoiceIssuedAt: true },
      }),
      prisma.domainEvent.findMany({
        where: {
          objectId: fixture.orderId,
          type: 'audit:commercial_order_amended',
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.domainEvent.count({
        where: {
          objectId: fixture.orderId,
          type: 'notification:commercial_order_amended',
        },
      }),
    ]);
    const finalPosition = finalOrder.body.positions.find(
      (position: { id: string }) => position.id === fixture.positionId,
    );
    expect(financeBoundary.invoiceStatus).toBe('invoiced');
    expect(financeBoundary.invoiceIssuedAt).not.toBeNull();

    if (amendmentResponse.status === 201) {
      expect(finalPosition).toMatchObject({
        widthMm: 1750,
        version: initialPosition.version + 1,
      });
      expect(amendmentEvents).toHaveLength(1);
      expect(notificationCount).toBe(1);
      expect(amendmentEvents[0]!.createdAt.getTime()).toBeLessThanOrEqual(
        financeBoundary.invoiceIssuedAt!.getTime(),
      );
    } else {
      expect(finalPosition).toMatchObject({
        widthMm: initialPosition.widthMm,
        version: initialPosition.version,
      });
      expect(amendmentEvents).toHaveLength(0);
      expect(notificationCount).toBe(0);
    }

    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: fixture.orderId,
          type: 'audit:commercial_order_amended',
          createdAt: { gt: financeBoundary.invoiceIssuedAt! },
        },
      }),
    ).resolves.toBe(0);
  });
});
