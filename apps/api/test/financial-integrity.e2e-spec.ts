import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuditService } from '../src/common/audit/audit.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Financial and director disputed-action integrity (e2e, real DB)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let financeOrderId: string;
  let decisionId: string;
  const decisionIds: string[] = [];
  let adminAuthorization: string;
  let directorAuthorization: string;
  let financeAuthorization: string;
  const previousDevActor = process.env.AUTH_DEV_XROLE;
  const previousOneCLive = process.env.ONEC_LIVE;
  const previousOneCWrite = process.env.ONEC_WRITE;

  beforeAll(async () => {
    process.env.AUTH_DEV_XROLE = 'off';
    process.env.ONEC_LIVE = 'false';
    process.env.ONEC_WRITE = 'false';
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
    await app.init();

    prisma = app.get(PrismaService);
    audit = app.get(AuditService);
    financeOrderId = (await prisma.financeOrder.findFirstOrThrow({ select: { id: true } })).id;
    decisionId = (
      await prisma.directorDecision.create({
        data: {
          scope: 'finance',
          objectId: `financial-integrity-${Date.now()}`,
          evidence: 'E2E transaction rollback fixture',
        },
      })
    ).id;
    decisionIds.push(decisionId);

    const http = () => request(app.getHttpServer());
    const directorLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('director'), password: e2eSeedPassword() })
      .expect(201);
    const financeLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('finance'), password: e2eSeedPassword() })
      .expect(201);
    const adminLogin = await http()
      .post('/api/auth/login')
      .send({ login: e2eSeedLogin('admin'), password: e2eSeedPassword() })
      .expect(201);
    adminAuthorization = `Bearer ${adminLogin.body.token as string}`;
    directorAuthorization = `Bearer ${directorLogin.body.token as string}`;
    financeAuthorization = `Bearer ${financeLogin.body.token as string}`;
  });

  afterAll(async () => {
    if (prisma && decisionIds.length > 0) {
      await prisma.directorDecision.deleteMany({ where: { id: { in: decisionIds } } });
    }
    await app?.close();
    if (previousDevActor === undefined) delete process.env.AUTH_DEV_XROLE;
    else process.env.AUTH_DEV_XROLE = previousDevActor;
    if (previousOneCLive === undefined) delete process.env.ONEC_LIVE;
    else process.env.ONEC_LIVE = previousOneCLive;
    if (previousOneCWrite === undefined) delete process.env.ONEC_WRITE;
    else process.env.ONEC_WRITE = previousOneCWrite;
  });

  it('rejects invalid status and amount values at the HTTP DTO boundary', async () => {
    const http = () => request(app.getHttpServer());
    const operationKey = randomUUID();
    await http()
      .post(`/api/director/finance/${financeOrderId}/override`)
      .set('Authorization', directorAuthorization)
      .send({ reason: 'approved exception', evidence: 'signed decision', value: 'invented' })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey, operationType: 'cash', amount: -1 })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey: randomUUID(), operationType: 'cash', amount: 10, source: '1C' })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
      .set('Authorization', financeAuthorization)
      .send({ operationType: 'cash', amount: 10 })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey: randomUUID(), operationType: 'cash', amount: 1_000_000_000_000.01 })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-updates`)
      .set('Authorization', financeAuthorization)
      .send({ paymentStatus: 'partial' })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-updates`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey: 'not-a-uuid', paymentStatus: 'partial' })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-updates`)
      .set('Authorization', financeAuthorization)
      .send({
        operationKey: '2c0190d9-4db0-19ff-8358-f6f0a393b44c',
        paymentStatus: 'partial',
      })
      .expect(400);
    await http()
      .post(`/api/finance/orders/${financeOrderId}/payment-updates`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey: randomUUID(), paymentStatus: 'partial', amountPaid: 10 })
      .expect(400);
  });

  it('keeps reconciliation admin-only while finance can resolve a payment allocation', async () => {
    const suffix = randomUUID();
    const counterparty = await prisma.counterparty.create({
      data: { displayName: `FI-7 payment allocation ${suffix}` },
    });
    const commercialOrder = await prisma.commercialOrder.create({
      data: {
        orderNumber: `FI7-${suffix}`,
        creatorRole: 'commercial',
        counterpartyId: counterparty.id,
      },
    });
    const financeOrder = await prisma.financeOrder.create({
      data: {
        commercialOrderId: commercialOrder.id,
        invoiceStatus: 'invoiced',
        invoiceSyncState: 'posted',
        invoiceNumber: `INV-FI7-${suffix}`,
        invoiceCurrency: 'RUB',
        amountValue: '100.00',
        externalId: `invoice-fi7-${suffix}`,
      },
    });
    const receipt = await prisma.paymentReceipt.create({
      data: {
        externalId: `receipt-fi7-${suffix}`,
        number: `PAY-FI7-${suffix}`,
        receivedAt: new Date(),
        amount: '25.00',
        currency: 'RUB',
        posted: true,
        sourceStatus: 'fresh',
        matchState: 'proposal',
        matchKind: 'invoice_number_proposal',
        candidateFinanceOrderIds: [financeOrder.id],
        capturedAt: new Date(),
      },
    });
    const http = () => request(app.getHttpServer());

    const adminRows = await http()
      .get('/api/finance/reconciliation')
      .set('Authorization', adminAuthorization)
      .expect(200);
    expect(adminRows.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: receipt.id, remainingAmount: '25.00' }),
      ]),
    );
    await http()
      .get('/api/finance/reconciliation')
      .set('Authorization', financeAuthorization)
      .expect(403);

    const operationKey = randomUUID();
    await http()
      .post(`/api/finance/payment-allocations/${receipt.id}/resolve`)
      .set('Authorization', financeAuthorization)
      .send({
        operationKey,
        reason: 'FI-7 verified finance allocation',
        allocations: [{ financeOrderId: financeOrder.id, amount: 25 }],
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(
          expect.objectContaining({ receiptId: receipt.id, allocatedAmount: '25.00' }),
        );
      });
    const allocation = await prisma.financePaymentAllocation.findFirstOrThrow({
      where: { receiptId: receipt.id, financeOrderId: financeOrder.id },
      select: { amount: true, createdByRole: true, matchKind: true },
    });
    expect({ ...allocation, amount: allocation.amount.toFixed(2) }).toEqual({
      amount: '25.00',
      createdByRole: 'finance',
      matchKind: 'manual',
    });
    await expect(
      prisma.financePaymentAllocationCommand.findUniqueOrThrow({
        where: { operationKey },
        select: { actorRole: true, receiptId: true },
      }),
    ).resolves.toEqual({ actorRole: 'finance', receiptId: receipt.id });
  });

  it('claims concurrent payment updates once, normalizes UUID aliases, and rejects drift', async () => {
    const operationKey = randomUUID();
    const uppercaseAlias = operationKey.toUpperCase();
    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey: randomUUID(), operationType: 'cash', amount: 0.01 })
      .expect(201);
    const paymentEventsBefore = await prisma.domainEvent.count({
      where: { objectId: financeOrderId, type: 'audit:payment_status_updated' },
    });
    const lockEventsBefore = await prisma.domainEvent.count({
      where: { type: 'audit:commercial_order_locked_by_payment' },
    });
    const paymentOperationsBefore = await prisma.paymentOperation.count({
      where: { financeOrderId },
    });
    const submit = (key: string, paymentStatus = 'partial') =>
      request(app.getHttpServer())
        .post(`/api/finance/orders/${financeOrderId}/payment-updates`)
        .set('Authorization', financeAuthorization)
        .send({ operationKey: key, paymentStatus });

    const [left, right] = await Promise.all([submit(operationKey), submit(uppercaseAlias)]);

    expect([left.status, right.status]).toEqual([201, 201]);
    const aggregateAfterClaim = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrderId },
      select: { paymentStatus: true, updatedAt: true },
    });
    const replay = await submit(uppercaseAlias);
    expect(replay.status).toBe(201);
    await expect(
      prisma.financeOrder.findUniqueOrThrow({
        where: { id: financeOrderId },
        select: { paymentStatus: true, updatedAt: true },
      }),
    ).resolves.toEqual(aggregateAfterClaim);
    expect(aggregateAfterClaim.paymentStatus).toBe('partial');

    await expect(
      prisma.financePaymentUpdateCommand.count({
        where: { financeOrderId, operationKey },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.financePaymentUpdateCommand.findUniqueOrThrow({
        where: { financeOrderId_operationKey: { financeOrderId, operationKey } },
      }),
    ).resolves.toMatchObject({
      operationKey,
      actorRole: 'finance',
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(prisma.paymentOperation.count({ where: { financeOrderId } })).resolves.toBe(
      paymentOperationsBefore,
    );
    await expect(
      prisma.domainEvent.count({
        where: { objectId: financeOrderId, type: 'audit:payment_status_updated' },
      }),
    ).resolves.toBe(paymentEventsBefore + 1);
    await expect(
      prisma.domainEvent.count({ where: { type: 'audit:commercial_order_locked_by_payment' } }),
    ).resolves.toBe(lockEventsBefore + 1);

    const changedStatus = await submit(operationKey, 'paid');
    expect(changedStatus.status).toBe(409);
    expect(changedStatus.body).toMatchObject({ code: 'FINANCE_PAYMENT_UPDATE_KEY_CONFLICT' });
  });

  it('records concurrent lower/upper payment-key aliases exactly once and rejects drift', async () => {
    const operationKey = randomUUID();
    const uppercaseAlias = operationKey.toUpperCase();
    const amount = 7654.32;
    const submit = (key: string, nextAmount = amount) =>
      request(app.getHttpServer())
        .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
        .set('Authorization', financeAuthorization)
        .send({ operationKey: key, operationType: 'cash', amount: nextAmount });

    const [left, right] = await Promise.all([submit(operationKey), submit(uppercaseAlias)]);

    expect([left.status, right.status]).toEqual([201, 201]);
    expect(left.body.id).toBe(right.body.id);
    await expect(
      prisma.paymentOperation.count({ where: { financeOrderId, operationKey } }),
    ).resolves.toBe(1);
    const events = await prisma.domainEvent.findMany({
      where: { objectId: financeOrderId, type: 'audit:cash_operation_recorded' },
      select: { detail: true },
    });
    expect(
      events.filter(
        (event) =>
          event.detail &&
          typeof event.detail === 'object' &&
          !Array.isArray(event.detail) &&
          event.detail.operationKey === operationKey,
      ),
    ).toHaveLength(1);

    const drift = await submit(uppercaseAlias, amount + 0.01);
    expect(drift.status).toBe(409);
    expect(drift.body).toMatchObject({ code: 'FINANCE_OPERATION_KEY_CONFLICT' });
  });

  it('replays a sequential uppercase payment-key alias without another row or audit', async () => {
    const operationKey = randomUUID();
    const submit = (key: string) =>
      request(app.getHttpServer())
        .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
        .set('Authorization', financeAuthorization)
        .send({ operationKey: key, operationType: 'cash', amount: 2345.67 });

    const first = await submit(operationKey);
    const replay = await submit(operationKey.toUpperCase());

    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.body.id).toBe(first.body.id);
    await expect(
      prisma.paymentOperation.count({ where: { financeOrderId, operationKey } }),
    ).resolves.toBe(1);
    await expect(
      prisma.paymentOperation.count({
        where: { financeOrderId, operationKey: operationKey.toUpperCase() },
      }),
    ).resolves.toBe(0);
    const events = await prisma.domainEvent.findMany({
      where: { objectId: financeOrderId, type: 'audit:cash_operation_recorded' },
      select: { detail: true },
    });
    expect(
      events.filter(
        (event) =>
          event.detail &&
          typeof event.detail === 'object' &&
          !Array.isArray(event.detail) &&
          event.detail.operationKey === operationKey,
      ),
    ).toHaveLength(1);
  });

  it('keeps 1C source retry hidden and side-effect free while the runtime is disabled', async () => {
    const operationKey = randomUUID();
    const eventsBefore = await prisma.domainEvent.count({
      where: {
        objectId: financeOrderId,
        type: { in: ['audit:sync_retry_requested', 'integration.onec_imported'] },
      },
    });

    await request(app.getHttpServer())
      .post(`/api/finance/orders/${financeOrderId}/source-retry`)
      .set('Authorization', financeAuthorization)
      .send({ operationKey })
      .expect(404);

    await expect(prisma.syncJournal.count({ where: { operationKey } })).resolves.toBe(0);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: financeOrderId,
          type: { in: ['audit:sync_retry_requested', 'integration.onec_imported'] },
        },
      }),
    ).resolves.toBe(eventsBefore);
  });

  it('rejects non-canonical idempotency keys at the database boundary', async () => {
    const paymentKey = randomUUID().toUpperCase();
    const journalKey = randomUUID().toUpperCase();
    const invalidPaymentUpdateKey = '2c0190d9-4db0-19ff-8358-f6f0a393b44c';
    try {
      await expect(
        prisma.paymentOperation.create({
          data: {
            financeOrderId,
            operationKey: paymentKey,
            operationType: 'cash',
            amount: 1,
            source: 'manual_platform',
            createdByRole: 'finance',
          },
        }),
      ).rejects.toThrow('payment_operations_operationKey_lowercase_check');
      await expect(
        prisma.syncJournal.create({
          data: {
            financeOrderId,
            operationKey: journalKey,
            entity: 'finance_order',
            status: 'error',
            ownerRole: 'finance',
          },
        }),
      ).rejects.toThrow('sync_journals_operationKey_lowercase_check');
      await expect(
        prisma.financePaymentUpdateCommand.create({
          data: {
            financeOrderId,
            operationKey: invalidPaymentUpdateKey,
            requestFingerprint: '0'.repeat(64),
            actorRole: 'finance',
          },
        }),
      ).rejects.toThrow('finance_payment_update_commands_operationKey_format_check');
      await expect(
        prisma.paymentOperation.count({ where: { operationKey: paymentKey } }),
      ).resolves.toBe(0);
      await expect(prisma.syncJournal.count({ where: { operationKey: journalKey } })).resolves.toBe(
        0,
      );
      await expect(
        prisma.financePaymentUpdateCommand.count({
          where: { operationKey: invalidPaymentUpdateKey },
        }),
      ).resolves.toBe(0);
    } finally {
      await prisma.paymentOperation.deleteMany({ where: { operationKey: paymentKey } });
      await prisma.syncJournal.deleteMany({ where: { operationKey: journalKey } });
      await prisma.financePaymentUpdateCommand.deleteMany({
        where: { operationKey: invalidPaymentUpdateKey },
      });
    }
  });

  it('allows exactly one concurrent director decision and returns its persisted timestamp', async () => {
    const decision = await prisma.directorDecision.create({
      data: {
        scope: 'finance',
        objectId: `financial-cas-${Date.now()}`,
        evidence: 'Concurrent decision fixture',
      },
    });
    decisionIds.push(decision.id);
    const approve = request(app.getHttpServer())
      .post(`/api/director/decisions/${decision.id}/approve`)
      .set('Authorization', directorAuthorization);
    const returnDecision = request(app.getHttpServer())
      .post(`/api/director/decisions/${decision.id}/return`)
      .set('Authorization', directorAuthorization)
      .send({ note: 'Return after concurrent review' });

    const responses = await Promise.all([approve, returnDecision]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const winner = responses.find((response) => response.status === 201)!;
    const persisted = await prisma.directorDecision.findUniqueOrThrow({
      where: { id: decision.id },
    });
    expect(winner.body.status).toBe(persisted.status);
    expect(new Date(winner.body.updatedAt).toISOString()).toBe(persisted.updatedAt.toISOString());
    await expect(
      prisma.domainEvent.count({
        where: { objectId: decision.id, type: 'audit:director_decision_resolved' },
      }),
    ).resolves.toBe(1);
  });

  it('rolls back both finance indicators and both override audits when apply audit fails', async () => {
    const before = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrderId },
      include: { commercialOrder: { select: { paymentStatus: true } } },
    });
    const eventWhere = {
      objectId: financeOrderId,
      type: {
        in: [
          'audit:director_finance_override_requested',
          'audit:director_finance_override_applied',
        ],
      },
    };
    const eventsBefore = await prisma.domainEvent.count({ where: eventWhere });
    const targetStatus = before.paymentStatus === 'paid' ? 'unpaid' : 'paid';
    const originalRecord = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:director_finance_override_applied') {
        throw new Error('forced finance override audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/director/finance/${financeOrderId}/override`)
        .set('Authorization', directorAuthorization)
        .send({
          reason: 'E2E finance rollback proof',
          evidence: 'Signed reconciliation statement',
          value: targetStatus,
        })
        .expect(500);
    } finally {
      spy.mockRestore();
    }

    const after = await prisma.financeOrder.findUniqueOrThrow({
      where: { id: financeOrderId },
      include: { commercialOrder: { select: { paymentStatus: true } } },
    });
    expect(after.paymentStatus).toBe(before.paymentStatus);
    expect(after.commercialOrder.paymentStatus).toBe(before.commercialOrder.paymentStatus);
    await expect(prisma.domainEvent.count({ where: eventWhere })).resolves.toBe(eventsBefore);
  });

  it('rolls back decision resolution when its audit append fails', async () => {
    const eventsBefore = await prisma.domainEvent.count({
      where: { objectId: decisionId, type: 'audit:director_decision_resolved' },
    });
    const originalRecord = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:director_decision_resolved') {
        throw new Error('forced director decision audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/director/decisions/${decisionId}/approve`)
        .set('Authorization', directorAuthorization)
        .expect(500);
    } finally {
      spy.mockRestore();
    }

    await expect(
      prisma.directorDecision.findUniqueOrThrow({ where: { id: decisionId } }),
    ).resolves.toMatchObject({ status: 'pending' });
    await expect(
      prisma.domainEvent.count({
        where: { objectId: decisionId, type: 'audit:director_decision_resolved' },
      }),
    ).resolves.toBe(eventsBefore);
  });

  it('rolls back a payment operation when its required audit append fails', async () => {
    const operationKey = randomUUID();
    const operationsBefore = await prisma.paymentOperation.count({
      where: { financeOrderId, operationType: 'cash', amount: 4321.09 },
    });
    const eventsBefore = await prisma.domainEvent.count({
      where: { objectId: financeOrderId, type: 'audit:cash_operation_recorded' },
    });
    const originalRecord = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:cash_operation_recorded') {
        throw new Error('forced payment operation audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/finance/orders/${financeOrderId}/payment-operations`)
        .set('Authorization', financeAuthorization)
        .send({ operationKey, operationType: 'cash', amount: 4321.09 })
        .expect(500);
    } finally {
      spy.mockRestore();
    }

    await expect(
      prisma.paymentOperation.count({
        where: { financeOrderId, operationType: 'cash', amount: 4321.09 },
      }),
    ).resolves.toBe(operationsBefore);
    await expect(
      prisma.domainEvent.count({
        where: { objectId: financeOrderId, type: 'audit:cash_operation_recorded' },
      }),
    ).resolves.toBe(eventsBefore);
  });
});
