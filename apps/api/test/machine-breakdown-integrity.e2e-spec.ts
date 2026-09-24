import { randomBytes, randomUUID } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuditService } from '../src/common/audit/audit.service';
import { hashPassword } from '../src/common/auth/password';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';

describe('machine breakdown transactional integrity (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let audit: AuditService;

  const suffix = randomUUID();
  const operatorId = `breakdown-operator-${suffix}`;
  const operatorLogin = `breakdown-operator-${suffix}@test.local`;
  const operatorPassword = randomBytes(18).toString('base64url');
  const rejectOperatorId = `breakdown-reject-operator-${suffix}`;
  const rejectOperatorLogin = `breakdown-reject-operator-${suffix}@test.local`;
  const rejectOperatorPassword = randomBytes(18).toString('base64url');
  const operatorPostId = `breakdown-operator-post-${suffix}`;
  const operatorPostCode = `BREAKDOWN-OP-${suffix}`;
  const shiftId = `breakdown-shift-${suffix}`;
  const directPostId = `breakdown-direct-post-${suffix}`;
  const rollbackPostId = `breakdown-rollback-post-${suffix}`;
  const constraintPostId = `breakdown-constraint-post-${suffix}`;
  const repairRollbackPostId = `repair-rollback-post-${suffix}`;
  const repairRollbackProblemId = `repair-rollback-problem-${suffix}`;
  const repairRacePostId = `repair-race-post-${suffix}`;
  const rejectRacePostId = `reject-race-post-${suffix}`;
  const rejectRaceProblemId = `reject-race-problem-${suffix}`;

  async function waitForBlockedPostLock(): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query LIKE '%FROM "posts"%FOR UPDATE%'
        ) AS waiting
      `;
      if (state?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Timed out waiting for the competing Post row lock');
  }

  async function waitForBlockedPostOperations(expected: number): Promise<void> {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ waiting: number }>>`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%posts%'
      `;
      if ((state?.waiting ?? 0) >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${expected} competing Post operations`);
  }

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    prisma = moduleRef.get(PrismaService);
    audit = moduleRef.get(AuditService);
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await initializeE2eApp(app);

    await prisma.user.createMany({
      data: [
        {
          id: operatorId,
          externalId: operatorId,
          login: operatorLogin,
          passwordHash: hashPassword(operatorPassword),
          displayName: 'Breakdown integrity operator',
          role: Role.operator,
        },
        {
          id: rejectOperatorId,
          externalId: rejectOperatorId,
          login: rejectOperatorLogin,
          passwordHash: hashPassword(rejectOperatorPassword),
          displayName: 'Breakdown reject race operator',
          role: Role.operator,
        },
      ],
    });
    await prisma.post.createMany({
      data: [
        { id: operatorPostId, code: operatorPostCode, name: 'Operator breakdown post' },
        {
          id: directPostId,
          code: `BREAKDOWN-DIRECT-${suffix}`,
          name: 'Direct breakdown post',
        },
        {
          id: rollbackPostId,
          code: `BREAKDOWN-ROLLBACK-${suffix}`,
          name: 'Rollback breakdown post',
        },
        {
          id: constraintPostId,
          code: `BREAKDOWN-CONSTRAINT-${suffix}`,
          name: 'Breakdown uniqueness post',
        },
        {
          id: repairRollbackPostId,
          code: `REPAIR-ROLLBACK-${suffix}`,
          name: 'Repair rollback post',
          status: 'maintenance',
        },
        {
          id: repairRacePostId,
          code: `REPAIR-RACE-${suffix}`,
          name: 'Repair/report race post',
        },
        {
          id: rejectRacePostId,
          code: `REJECT-RACE-${suffix}`,
          name: 'Reject/report race post',
          status: 'broken',
        },
      ],
    });
    await prisma.productionProblem.create({
      data: {
        id: repairRollbackProblemId,
        type: 'machine_breakdown',
        postId: repairRollbackPostId,
        actorRole: Role.production_lead,
        reason: 'Repair rollback fixture',
      },
    });
    await prisma.productionProblem.create({
      data: {
        id: rejectRaceProblemId,
        type: 'machine_breakdown',
        postId: rejectRacePostId,
        actorRole: Role.operator,
        reason: 'Reject/report race fixture',
      },
    });
    await prisma.shift.create({
      data: {
        id: shiftId,
        label: 'Breakdown integrity shift',
        plannedStartAt: new Date(Date.now() - 60_000),
        plannedEndAt: new Date(Date.now() + 60 * 60_000),
        status: 'open',
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId,
        operatorId,
        postId: operatorPostId,
        status: 'locked',
        lockedAt: new Date(),
      },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId,
        operatorId: rejectOperatorId,
        postId: rejectRacePostId,
        status: 'locked',
        lockedAt: new Date(),
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        operatorId,
        postId: operatorPostId,
        shiftId,
        status: 'active',
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        operatorId: rejectOperatorId,
        postId: rejectRacePostId,
        shiftId,
        status: 'active',
      },
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(async () => {
      if (prisma) {
        const postIds = [
          operatorPostId,
          directPostId,
          rollbackPostId,
          constraintPostId,
          repairRollbackPostId,
          repairRacePostId,
          rejectRacePostId,
        ];
        // Immutable breakdown events and their actors remain for isolated-schema teardown.
        await prisma.productionProblem.deleteMany({ where: { postId: { in: postIds } } });
        await prisma.operatorPostSession.deleteMany({
          where: { operatorId: { in: [operatorId, rejectOperatorId] } },
        });
        await prisma.operatorShiftMachineAssignment.deleteMany({ where: { shiftId } });
        await prisma.session.deleteMany({
          where: { userId: { in: [operatorId, rejectOperatorId] } },
        });
        await prisma.shift.deleteMany({ where: { id: shiftId } });
        await prisma.post.deleteMany({ where: { id: { in: postIds } } });
      }
    }, [{ label: 'machine breakdown application', run: async () => app?.close() }]);
  });

  it('serializes concurrent production-lead reports into one problem and one audit pair', async () => {
    const submit = () =>
      request(app.getHttpServer())
        .post(`/api/production/posts/${directPostId}/breakdown`)
        .set({ 'x-role': 'production_lead' })
        .send({ reason: 'Concurrent direct breakdown' });

    const originalRecord = audit.record.bind(audit);
    let releaseFirstAudit: () => void = () => undefined;
    let markFirstAuditEntered: () => void = () => undefined;
    const firstAuditEntered = new Promise<void>((resolve) => {
      markFirstAuditEntered = resolve;
    });
    const firstAuditRelease = new Promise<void>((resolve) => {
      releaseFirstAudit = resolve;
    });
    let held = false;
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (
        !held &&
        input.type === 'problem:machine_breakdown_reported' &&
        input.objectId === directPostId
      ) {
        held = true;
        markFirstAuditEntered();
        await firstAuditRelease;
      }
      return originalRecord(input, client);
    });
    const first = Promise.resolve(submit());
    await firstAuditEntered;
    const second = Promise.resolve(submit());
    let contentionFailure: unknown;
    try {
      await waitForBlockedPostLock();
    } catch (error) {
      contentionFailure = error;
    } finally {
      releaseFirstAudit();
      auditSpy.mockRestore();
    }
    const responses = await Promise.all([first, second]);
    if (contentionFailure) throw contentionFailure;

    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const success = responses.find(({ status }) => status === 201);
    expect(success?.body).toMatchObject({ type: 'machine_breakdown', postId: directPostId });

    const problem = await prisma.productionProblem.findFirstOrThrow({
      where: { postId: directPostId, type: 'machine_breakdown', status: 'open' },
    });
    await expect(
      prisma.productionProblem.count({
        where: { postId: directPostId, type: 'machine_breakdown', status: 'open' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          OR: [
            { objectId: directPostId, type: 'problem:machine_breakdown_reported' },
            { objectId: problem.id, type: 'audit:machine_breakdown_confirmed' },
          ],
        },
      }),
    ).resolves.toBe(2);
  });

  it('deduplicates concurrent operator retries against the same locked post', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: operatorLogin, password: operatorPassword })
      .expect(201);
    const bearer = { Authorization: `Bearer ${login.body.token as string}` };
    const submit = () =>
      request(app.getHttpServer())
        .post('/api/operator/machine-breakdown')
        .set(bearer)
        .send({ type: 'screw_jam', details: 'Concurrent operator breakdown' });

    const [first, second] = await Promise.all([submit(), submit()]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.id).toBe(second.body.id);
    await expect(
      prisma.productionProblem.findUniqueOrThrow({
        where: { id: first.body.id as string },
        select: { machineBreakdownType: true, reason: true },
      }),
    ).resolves.toEqual({
      machineBreakdownType: 'screw_jam',
      reason: 'Клин шнека — Concurrent operator breakdown',
    });
    await expect(
      prisma.productionProblem.count({
        where: { postId: operatorPostId, type: 'machine_breakdown', status: 'open' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: operatorPostId,
          type: {
            in: ['problem:machine_breakdown_reported', 'notification:production_problem_received'],
          },
        },
      }),
    ).resolves.toBe(2);
    const eventDetails = await prisma.domainEvent.findMany({
      where: {
        objectId: operatorPostId,
        type: {
          in: ['problem:machine_breakdown_reported', 'notification:production_problem_received'],
        },
      },
      select: { detail: true },
    });
    expect(eventDetails).toHaveLength(2);
    for (const event of eventDetails) {
      expect(event.detail).toMatchObject({
        machineBreakdownType: 'screw_jam',
        machineBreakdownDetails: 'Concurrent operator breakdown',
      });
    }
  });

  it('rolls the real Post, Problem and first audit fact back when confirmation audit fails', async () => {
    const reason = `Forced audit rollback ${suffix}`;
    const originalRecord = audit.record.bind(audit);
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      const detail = input.detail as { postId?: string } | undefined;
      if (input.type === 'audit:machine_breakdown_confirmed' && detail?.postId === rollbackPostId) {
        throw new Error('forced breakdown audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/production/posts/${rollbackPostId}/breakdown`)
        .set({ 'x-role': 'production_lead' })
        .send({ reason })
        .expect(500);
    } finally {
      auditSpy.mockRestore();
    }

    await expect(
      prisma.post.findUniqueOrThrow({ where: { id: rollbackPostId }, select: { status: true } }),
    ).resolves.toEqual({ status: 'active' });
    await expect(
      prisma.productionProblem.count({ where: { postId: rollbackPostId } }),
    ).resolves.toBe(0);
    await expect(prisma.domainEvent.count({ where: { reason } })).resolves.toBe(0);
  });

  it('rolls a real repair and its problem resolution back when the audit fact fails', async () => {
    const note = `Forced repair rollback ${suffix}`;
    const originalRecord = audit.record.bind(audit);
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (input.type === 'audit:machine_repaired' && input.objectId === repairRollbackPostId) {
        throw new Error('forced repair audit failure');
      }
      return originalRecord(input, client);
    });
    try {
      await request(app.getHttpServer())
        .post(`/api/production/posts/${repairRollbackPostId}/repair`)
        .set({ 'x-role': 'production_lead' })
        .send({ note })
        .expect(500);
    } finally {
      auditSpy.mockRestore();
    }

    await expect(
      prisma.post.findUniqueOrThrow({
        where: { id: repairRollbackPostId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'maintenance' });
    await expect(
      prisma.productionProblem.findUniqueOrThrow({
        where: { id: repairRollbackProblemId },
        select: { status: true, resolvedAt: true, recovery: true },
      }),
    ).resolves.toEqual({ status: 'open', resolvedAt: null, recovery: null });
    await expect(prisma.domainEvent.count({ where: { reason: note } })).resolves.toBe(0);
  });

  it('serializes a repair behind a concurrent report without leaving split state', async () => {
    const reportReason = `Report before repair ${suffix}`;
    const originalRecord = audit.record.bind(audit);
    let releaseReportAudit: () => void = () => undefined;
    let markReportAuditEntered: () => void = () => undefined;
    const reportAuditEntered = new Promise<void>((resolve) => {
      markReportAuditEntered = resolve;
    });
    const reportAuditRelease = new Promise<void>((resolve) => {
      releaseReportAudit = resolve;
    });
    let held = false;
    const auditSpy = jest.spyOn(audit, 'record').mockImplementation(async (input, client) => {
      if (
        !held &&
        input.type === 'problem:machine_breakdown_reported' &&
        input.objectId === repairRacePostId
      ) {
        held = true;
        markReportAuditEntered();
        await reportAuditRelease;
      }
      return originalRecord(input, client);
    });
    const report = Promise.resolve(
      request(app.getHttpServer())
        .post(`/api/production/posts/${repairRacePostId}/breakdown`)
        .set({ 'x-role': 'production_lead' })
        .send({ reason: reportReason }),
    );
    await reportAuditEntered;
    const repair = Promise.resolve(
      request(app.getHttpServer())
        .post(`/api/production/posts/${repairRacePostId}/repair`)
        .set({ 'x-role': 'production_lead' })
        .send({ note: 'Repair after serialized report' }),
    );
    let contentionFailure: unknown;
    try {
      await waitForBlockedPostLock();
    } catch (error) {
      contentionFailure = error;
    } finally {
      releaseReportAudit();
      auditSpy.mockRestore();
    }
    const [reported, repaired] = await Promise.all([report, repair]);
    if (contentionFailure) throw contentionFailure;

    expect([reported.status, repaired.status]).toEqual([201, 201]);
    await expect(
      prisma.post.findUniqueOrThrow({ where: { id: repairRacePostId }, select: { status: true } }),
    ).resolves.toEqual({ status: 'active' });
    await expect(
      prisma.productionProblem.count({
        where: {
          postId: repairRacePostId,
          type: 'machine_breakdown',
          status: 'open',
        },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.productionProblem.count({
        where: {
          postId: repairRacePostId,
          type: 'machine_breakdown',
          status: 'resolved',
        },
      }),
    ).resolves.toBe(1);
  });

  it('serializes reject behind a queued operator report without producing active plus open', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ login: rejectOperatorLogin, password: rejectOperatorPassword })
      .expect(201);
    const bearer = { Authorization: `Bearer ${login.body.token as string}` };
    let releaseBlocker: () => void = () => undefined;
    let markBlockerReady: () => void = () => undefined;
    const blockerReady = new Promise<void>((resolve) => {
      markBlockerReady = resolve;
    });
    const blockerRelease = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "posts" WHERE "id" = ${rejectRacePostId} FOR UPDATE
      `;
      markBlockerReady();
      await blockerRelease;
    });
    await blockerReady;
    const operatorReport = Promise.resolve(
      request(app.getHttpServer())
        .post('/api/operator/machine-breakdown')
        .set(bearer)
        .send({ type: 'drive_stopped', details: 'Operator report queued before reject' }),
    );
    await waitForBlockedPostOperations(1);
    const reject = Promise.resolve(
      request(app.getHttpServer())
        .post(`/api/production/problems/${rejectRaceProblemId}/resolve`)
        .set({ 'x-role': 'production_lead' })
        .send({ resolution: 'reject', note: 'Concurrent reject' }),
    );
    let contentionFailure: unknown;
    try {
      await waitForBlockedPostOperations(2);
    } catch (error) {
      contentionFailure = error;
    } finally {
      releaseBlocker();
      await blocker;
    }
    const [reported, rejected] = await Promise.all([operatorReport, reject]);
    if (contentionFailure) throw contentionFailure;

    expect([reported.status, rejected.status]).toEqual([201, 201]);
    await expect(
      prisma.post.findUniqueOrThrow({ where: { id: rejectRacePostId }, select: { status: true } }),
    ).resolves.toEqual({ status: 'active' });
    await expect(
      prisma.productionProblem.count({
        where: { postId: rejectRacePostId, type: 'machine_breakdown', status: 'open' },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.productionProblem.findUniqueOrThrow({
        where: { id: rejectRaceProblemId },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: 'resolved' });
  });

  it('enforces one open machine_breakdown per post while retaining resolved history', async () => {
    const first = await prisma.productionProblem.create({
      data: {
        type: 'machine_breakdown',
        postId: constraintPostId,
        actorRole: Role.production_lead,
        reason: 'First open breakdown',
      },
    });

    await expect(
      prisma.productionProblem.create({
        data: {
          type: 'machine_breakdown',
          postId: constraintPostId,
          actorRole: Role.production_lead,
          reason: 'Duplicate open breakdown',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await prisma.productionProblem.update({
      where: { id: first.id },
      data: { status: 'resolved', resolvedAt: new Date() },
    });
    await expect(
      prisma.productionProblem.create({
        data: {
          type: 'machine_breakdown',
          postId: constraintPostId,
          actorRole: Role.production_lead,
          reason: 'New breakdown after repair',
        },
      }),
    ).resolves.toMatchObject({ postId: constraintPostId, status: 'open' });
  });
});
