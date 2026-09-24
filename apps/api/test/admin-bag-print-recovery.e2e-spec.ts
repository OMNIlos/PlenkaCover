import { randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuditService } from '../src/common/audit/audit.service';
import { initializeE2eApp } from './e2e-app';
import { e2eSeedLogin, e2eSeedPassword } from './e2e-credentials';

describe('Admin bag print recovery (real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;
  let adminToken: string;
  let warehouseToken: string;
  const previous = { APP_ENV: process.env.APP_ENV, AUTH_DEV_XROLE: process.env.AUTH_DEV_XROLE };
  beforeAll(async () => {
    process.env.APP_ENV = 'test';
    process.env.AUTH_DEV_XROLE = 'off';
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);
    for (const role of ['admin', 'warehouse'] as const) {
      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ login: e2eSeedLogin(role), password: e2eSeedPassword() })
        .expect(201);
      if (role === 'admin') adminToken = response.body.token;
      else warehouseToken = response.body.token;
    }
  });
  afterAll(async () => {
    await app?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('exposes a safe, admin-only queue of unresolved print jobs', async () => {
    await request(app.getHttpServer())
      .get('/api/admin/print-recovery/unresolved')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/admin/print-recovery/unresolved')
      .set('authorization', `Bearer ${warehouseToken}`)
      .expect(403);
    await request(app.getHttpServer()).get('/api/admin/print-recovery/unresolved').expect(401);
  });
  async function fixture(kind: 'defect_bag' | 'big_bag') {
    if (kind === 'big_bag') {
      const bag = await prisma.bigBagUnit.create({
        data: { code: `RECOVERY-${randomUUID()}`, material: 'ПВД', initialKg: 150, currentKg: 140 },
      });
      const job = await prisma.bigBagLabelPrintJob.create({
        data: {
          requestId: randomUUID(),
          bigBagId: bag.id,
          status: 'uncertain',
          printerId: 'test-printer',
          requestedByRole: 'warehouse',
          failureReason: 'private-device-diagnostic',
        },
      });
      return {
        id: job.id,
        bagId: bag.id,
        code: bag.code,
        path: `/api/admin/print-recovery/big-bags/${job.id}/reconcile`,
      };
    }
    const post = await prisma.post.findFirstOrThrow();
    const operator = await prisma.user.findFirstOrThrow({ where: { role: 'operator' } });
    const session = await prisma.operatorPostSession.create({
      data: { postId: post.id, operatorId: operator.id, status: 'closed' },
    });
    const bag = await prisma.defectBag.create({
      data: {
        code: `DEF-RECOVERY-${randomUUID()}`,
        postSessionId: session.id,
        weightKg: 12.5,
        recordedDefectKg: 10,
        differenceKg: 2.5,
        defectType: 'secondary',
        captureChannel: 'operator_manual',
        weighOperationKey: randomUUID(),
      },
    });
    const job = await prisma.defectBagLabelPrintJob.create({
      data: {
        operationKey: randomUUID(),
        defectBagId: bag.id,
        status: 'delivery_unknown',
        printerId: 'test-printer',
        postId: post.id,
        postSessionId: session.id,
        actorId: operator.id,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(),
        failureReason: 'private-device-diagnostic',
      },
    });
    return {
      id: job.id,
      bagId: bag.id,
      code: bag.code,
      path: `/api/admin/print-recovery/defect-bags/${job.id}/reconcile`,
    };
  }
  const postDecision = (path: string, dto: object, token = adminToken) =>
    request(app.getHttpServer()).post(path).set('authorization', `Bearer ${token}`).send(dto);

  it.each([
    ['defect_bag', 'label_observed'],
    ['defect_bag', 'not_printed'],
    ['big_bag', 'label_observed'],
    ['big_bag', 'not_printed'],
  ] as const)(
    'recovers %s / %s once, preserving measured facts and rejecting changed intent',
    async (kind, outcome) => {
      const target = await fixture(kind);
      const before =
        kind === 'defect_bag'
          ? await prisma.defectBag.findUniqueOrThrow({ where: { id: target.bagId } })
          : await prisma.bigBagUnit.findUniqueOrThrow({ where: { id: target.bagId } });
      const queue = await request(app.getHttpServer())
        .get('/api/admin/print-recovery/unresolved')
        .set('authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(queue.body).toContainEqual({
        kind,
        printJobId: target.id,
        objectCode: target.code,
        createdAt: expect.any(String),
      });
      expect(JSON.stringify(queue.body)).not.toMatch(
        /private-device|leaseToken|gatewayCommandId|scanToken/,
      );
      const dto = { operationKey: randomUUID(), outcome, reason: 'Проверена этикетка у принтера' };
      await postDecision(target.path, dto, warehouseToken).expect(403);
      await postDecision(target.path, { ...dto, reason: '  ' }).expect(400);
      const first = await postDecision(target.path, dto).expect(201);
      const replay = await postDecision(target.path, dto).expect(201);
      expect(replay.body).toEqual(first.body);
      expect(first.body.status).toBe(outcome === 'label_observed' ? 'submitted' : 'failed');
      await postDecision(target.path, { ...dto, reason: 'Другая причина' }).expect(409);
      await postDecision(target.path, { ...dto, operationKey: randomUUID() }).expect(409);
      const after =
        kind === 'defect_bag'
          ? await prisma.defectBag.findUniqueOrThrow({ where: { id: target.bagId } })
          : await prisma.bigBagUnit.findUniqueOrThrow({ where: { id: target.bagId } });
      if (kind === 'big_bag') expect(after).toEqual(before);
      else
        expect(after).toEqual({
          ...before,
          updatedAt: expect.any(Date),
          status: outcome === 'label_observed' ? 'ready_for_warehouse' : 'weighed',
        });
      const events = await prisma.domainEvent.findMany({
        where: { detail: { path: ['operationKey'], equals: dto.operationKey } },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorRole: 'admin',
        reason: dto.reason,
        objectId: kind === 'defect_bag' ? target.bagId : target.code,
      });
    },
  );

  it('serializes the same UUID across different bags and never commits a second decision', async () => {
    const first = await fixture('defect_bag');
    const second = await fixture('big_bag');
    const dto = { operationKey: randomUUID(), outcome: 'not_printed', reason: 'Принтер проверен' };
    const responses = await Promise.all([
      postDecision(first.path, dto),
      postDecision(second.path, dto),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      await prisma.domainEvent.count({
        where: { detail: { path: ['operationKey'], equals: dto.operationKey } },
      }),
    ).toBe(1);
  });

  it('rolls back the job and bag if the durable audit write fails', async () => {
    const target = await fixture('defect_bag');
    const originalRecord = audit.record.bind(audit);
    const spy = jest.spyOn(audit, 'record').mockImplementation((input, tx) => {
      if (input.type === 'audit:defect_bag_label_print_reconciled')
        throw new Error('Injected audit failure');
      return originalRecord(input, tx);
    });
    try {
      await postDecision(target.path, {
        operationKey: randomUUID(),
        outcome: 'label_observed',
        reason: 'Этикетка есть',
      }).expect(500);
      expect(
        await prisma.defectBagLabelPrintJob.findUnique({ where: { id: target.id } }),
      ).toMatchObject({ status: 'delivery_unknown' });
      expect(await prisma.defectBag.findUnique({ where: { id: target.bagId } })).toMatchObject({
        status: 'weighed',
        weightKg: 12.5,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['defect_bag', 'big_bag'] as const)(
    'blocks %s recovery while its unlinked gateway command is still active',
    async (kind) => {
      const target = await fixture(kind);
      const post = await prisma.post.findFirstOrThrow();
      const command = await prisma.gatewayCommand.create({
        data: {
          id: randomUUID(),
          postId: post.id,
          kind: 'print',
          status: 'in_flight',
          payload: { kind: 'big_bag_label', printerId: 'test-printer', bigBagCode: target.code },
        },
      });
      const dto = {
        operationKey: randomUUID(),
        outcome: 'not_printed',
        reason: 'Проверка этикетки',
      };
      await postDecision(target.path, dto)
        .expect(409)
        .expect(({ body }) => expect(body.code).toBe('ADMIN_PRINT_COMMAND_IN_PROGRESS'));
      expect(
        await prisma.domainEvent.count({
          where: { detail: { path: ['operationKey'], equals: dto.operationKey } },
        }),
      ).toBe(0);
      await prisma.gatewayCommand.update({ where: { id: command.id }, data: { status: 'failed' } });
      await postDecision(target.path, dto).expect(201);
    },
  );

  it('treats uppercase and lowercase UUIDs as the same decision', async () => {
    const first = await fixture('defect_bag');
    const second = await fixture('big_bag');
    const key = randomUUID();
    const dto = {
      operationKey: key.toUpperCase(),
      outcome: 'not_printed',
      reason: 'Принтер проверен',
    };
    const result = await postDecision(first.path, dto).expect(201);
    expect(result.body.operationKey).toBe(key);
    await postDecision(first.path, { ...dto, operationKey: key }).expect(201);
    await postDecision(second.path, { ...dto, operationKey: key }).expect(409);
  });
});
