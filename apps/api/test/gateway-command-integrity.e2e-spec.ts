import { randomUUID } from 'node:crypto';
import { ConflictException, type INestApplication, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { loadRuntimeConfig } from '../src/common/runtime-config';
import { gatewayCommandIncident } from '../src/common/operational-incidents/device-incident-signals';
import type { OperationalIncidentsService } from '../src/common/operational-incidents/operational-incidents.service';
import type { PrismaService } from '../src/common/prisma/prisma.service';
import { GatewayService } from '../src/modules/gateway/gateway.service';
import { runE2eWithCleanup } from './e2e-database';
import { holdAdvisoryFingerprint } from './postgres-advisory-barrier';

describe('Gateway command delivery integrity (e2e, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gateway: GatewayService;
  let incidents: OperationalIncidentsService;
  let moscowPrisma: PrismaClient;
  let moscowGateway: GatewayService;
  let post1: { id: string };
  let post2: { id: string };
  const commandIds: string[] = [];
  const eventIds: string[] = [];
  const incidentPostIds: string[] = [];

  beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { AppModule } = require('../src/app.module');
    const { PrismaService: PrismaServiceClass } = require('../src/common/prisma/prisma.service');
    const {
      GatewayService: GatewayServiceClass,
    } = require('../src/modules/gateway/gateway.service');
    const {
      OperationalIncidentsService: OperationalIncidentsServiceClass,
    } = require('../src/common/operational-incidents/operational-incidents.service');
    /* eslint-enable @typescript-eslint/no-require-imports */
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaServiceClass);
    gateway = moduleRef.get(GatewayServiceClass);
    incidents = moduleRef.get(OperationalIncidentsServiceClass);
    post1 = await prisma.post.findUniqueOrThrow({
      where: { code: 'POST-1' },
      select: { id: true },
    });
    post2 = await prisma.post.findUniqueOrThrow({
      where: { code: 'POST-2' },
      select: { id: true },
    });
    const databaseUrl = new URL(process.env.DATABASE_URL!);
    const callerOptions = databaseUrl.searchParams
      .get('options')
      ?.replace(/-c\s+timezone=[^\s]+/gu, '')
      .trim();
    databaseUrl.searchParams.set(
      'options',
      [callerOptions, '-c timezone=Europe/Moscow'].filter(Boolean).join(' '),
    );
    moscowPrisma = new PrismaClient({
      datasources: { db: { url: databaseUrl.toString() } },
    });
    await moscowPrisma.$connect();
    moscowGateway = new GatewayService(
      moscowPrisma as unknown as PrismaService,
      { record: async () => undefined } as never,
      loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '5000' }),
      { reconcileFingerprints: async () => undefined } as never,
      { reconcilePost: async () => undefined } as never,
    );
  });

  afterEach(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [
        {
          label: 'gateway command fixtures',
          run: async () => {
            await prisma.gatewayCommand.deleteMany({ where: { id: { in: commandIds } } });
            commandIds.splice(0);
          },
        },
        {
          label: 'gateway event fixtures',
          run: async () => {
            await prisma.gatewayEvent.deleteMany({ where: { eventId: { in: eventIds } } });
            eventIds.splice(0);
          },
        },
        {
          label: 'gateway incident fixtures',
          run: async () => {
            await prisma.operationalIncident.deleteMany({
              where: { targetId: { in: incidentPostIds } },
            });
          },
        },
        {
          label: 'gateway post fixtures',
          run: async () => {
            await prisma.post.deleteMany({ where: { id: { in: incidentPostIds } } });
            incidentPostIds.splice(0);
          },
        },
        {
          // Immutable command events remain until guarded isolated-schema teardown.
          label: 'gateway immutable event retention',
          run: () => undefined,
        },
      ],
    );
  });

  afterAll(async () => {
    await moscowPrisma?.$disconnect();
    await app?.close();
  });

  async function queued(
    kind: 'read_scale' | 'print' | 'device_test' | 'device_recover' = 'read_scale',
    createdAt?: Date,
  ) {
    const id = randomUUID();
    commandIds.push(id);
    return prisma.gatewayCommand.create({
      data: {
        id,
        postId: post1.id,
        kind,
        payload: {},
        deadlineAt: new Date(Date.now() + 30_000),
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  const scaleResult = (grossKg: number) => ({
    ok: true,
    deviceId: 'dev-scale-1',
    status: 'ready',
    stable: true,
    grossKg,
  });

  it('atomically leases a command to only one of two concurrent polls', async () => {
    const command = await queued();

    const [a, b] = await Promise.all([
      gateway.pollCommands(post1.id),
      gateway.pollCommands(post1.id),
    ]);
    const delivered = [...a, ...b].filter((item) => item.id === command.id);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      status: 'in_flight',
      attempt: 1,
      leaseToken: expect.any(String),
      leaseExpiresAt: expect.any(Date),
      serverTime: expect.any(Date),
      executionBudgetMs: expect.any(Number),
    });
  });

  it('keeps command defaults and leases valid in a Europe/Moscow database session', async () => {
    const timezone =
      await moscowPrisma.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TIME ZONE');
    expect(timezone).toEqual([{ TimeZone: 'Europe/Moscow' }]);

    const commandId = randomUUID();
    commandIds.push(commandId);
    await moscowPrisma.gatewayCommand.create({
      data: {
        id: commandId,
        postId: post1.id,
        kind: 'read_scale',
        payload: {},
        deadlineAt: new Date(Date.now() + 5_000),
      },
    });

    const [claim] = await moscowGateway.pollCommands(post1.id);
    expect(claim).toMatchObject({
      id: commandId,
      status: 'in_flight',
      attempt: 1,
      leaseToken: expect.any(String),
      executionBudgetMs: expect.any(Number),
    });
    expect(claim.executionBudgetMs).toBeGreaterThan(0);
    expect(claim.executionBudgetMs).toBeLessThanOrEqual(5_000);
    await expect(
      moscowGateway.resolveCommand(commandId, scaleResult(2.5), post1.id, claim.leaseToken!),
    ).resolves.toEqual({ ok: true, deduped: false, status: 'done' });

    const legacyId = randomUUID();
    commandIds.push(legacyId);
    const defaulted = await moscowPrisma.gatewayCommand.create({
      data: { id: legacyId, postId: post1.id, kind: 'read_scale', payload: {} },
    });
    expect(defaulted.deadlineAt.getTime() - defaulted.createdAt.getTime()).toBeGreaterThanOrEqual(
      29_000,
    );
    expect(defaulted.deadlineAt.getTime() - defaulted.createdAt.getTime()).toBeLessThanOrEqual(
      31_000,
    );

    await moscowPrisma.$executeRawUnsafe(
      `UPDATE "gateway_commands" SET "status" = 'in_flight' WHERE "id" = $1`,
      legacyId,
    );
    const legacyClaim = await moscowPrisma.gatewayCommand.findUniqueOrThrow({
      where: { id: legacyId },
    });
    expect(legacyClaim.leaseToken).toMatch(/^legacy-/u);
    expect(legacyClaim.leaseExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(legacyClaim.leaseExpiresAt?.getTime()).toBeLessThanOrEqual(
      legacyClaim.deadlineAt.getTime(),
    );
  });

  it('claims at most one command so a volatile agent never owns an unsafe batch tail', async () => {
    const tiedCreatedAt = new Date();
    const first = await queued('print', tiedCreatedAt);
    const second = await queued('print', tiedCreatedAt);

    const claimed = await gateway.pollCommands(post1.id);
    const expected = [first, second].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    )[0]!;
    const queuedTail = expected.id === first.id ? second : first;

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(expected.id);
    await expect(
      prisma.gatewayCommand.findUniqueOrThrow({ where: { id: queuedTail.id } }),
    ).resolves.toMatchObject({ status: 'queued', leaseToken: null, attempt: 0 });
  });

  it('keeps one command in flight when two polls race over two queued commands', async () => {
    const tiedCreatedAt = new Date();
    const first = await queued('print', tiedCreatedAt);
    const second = await queued('print', tiedCreatedAt);

    const [a, b] = await Promise.all([
      gateway.pollCommands(post1.id),
      gateway.pollCommands(post1.id),
    ]);
    const delivered = [...a, ...b];
    const persisted = await prisma.gatewayCommand.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.id).toBe(persisted[0]?.id);
    expect(persisted.map(({ status, attempt }) => ({ status, attempt }))).toEqual([
      { status: 'in_flight', attempt: 1 },
      { status: 'queued', attempt: 0 },
    ]);
  });

  it('accepts a leased result without any in-memory pending promise after an API restart', async () => {
    const command = await queued();
    const [claim] = await gateway.pollCommands(post1.id);

    await expect(
      gateway.resolveCommand(command.id, scaleResult(2.5), post1.id, claim.leaseToken!),
    ).resolves.toEqual({ ok: true, deduped: false, status: 'done' });

    await expect(
      prisma.gatewayCommand.findUniqueOrThrow({ where: { id: command.id } }),
    ).resolves.toMatchObject({
      status: 'done',
      result: scaleResult(2.5),
      resultFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('dedupes one failed recovery episode and resolves it after a successful command', async () => {
    const failed = await queued('device_recover');
    const [failedClaim] = await gateway.pollCommands(post1.id);
    const failedResult = {
      ok: false,
      status: 'failed',
      reasonCode: 'private-token=secret rawPayload=frame',
    };

    await expect(
      gateway.resolveCommand(failed.id, failedResult, post1.id, failedClaim.leaseToken!),
    ).resolves.toEqual({ ok: true, deduped: false, status: 'failed' });
    await expect(
      gateway.resolveCommand(failed.id, failedResult, post1.id, failedClaim.leaseToken!),
    ).resolves.toEqual({ ok: true, deduped: true, status: 'failed' });

    const fingerprint = `gateway:post:${post1.id}:command:device_recover_failed`;
    const incident = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    expect(incident).toMatchObject({
      status: 'open',
      scope: 'post',
      targetId: post1.id,
    });
    const opened = await prisma.domainEvent.findMany({
      where: { type: 'admin.incident.opened', objectId: incident.id },
    });
    expect(opened).toHaveLength(1);
    expect(JSON.stringify({ incident, opened })).not.toMatch(
      /private-token|secret|rawPayload|frame/i,
    );

    const recovered = await queued('device_recover');
    const [recoveredClaim] = await gateway.pollCommands(post1.id);
    await expect(
      gateway.resolveCommand(
        recovered.id,
        { ok: true, status: 'recovering', deviceId: 'dev-scale-1' },
        post1.id,
        recoveredClaim.leaseToken!,
      ),
    ).resolves.toEqual({ ok: true, deduped: false, status: 'done' });

    await expect(
      prisma.operationalIncident.findUniqueOrThrow({ where: { fingerprint } }),
    ).resolves.toMatchObject({ status: 'resolved' });
    await expect(
      prisma.domainEvent.count({
        where: { type: 'admin.incident.resolved', objectId: incident.id },
      }),
    ).resolves.toBe(1);
  });

  const createIncidentPost = async () => {
    const isolatedPost = await prisma.post.create({
      data: {
        code: `ORDERING-${randomUUID()}`,
        name: 'Recovery incident ordering post',
        status: 'active',
      },
    });
    incidentPostIds.push(isolatedPost.id);
    return isolatedPost;
  };

  const createTerminal = async (
    postId: string,
    id: string,
    status: 'done' | 'failed' | 'expired' | 'delivery_unknown',
    createdAt: Date,
  ) => {
    commandIds.push(id);
    return prisma.gatewayCommand.create({
      data: {
        id,
        postId,
        kind: 'device_recover',
        status,
        createdAt,
        deadlineAt: new Date(createdAt.getTime() + 30_000),
        resolvedAt: createdAt,
      },
    });
  };

  it('makes a blocked timeout/poll failure callback apply a newer done vector', async () => {
    const post = await createIncidentPost();
    const oldCreatedAt = new Date(Date.now() - 60_000);
    const oldCommandId = `recover-timeout-${randomUUID()}`;
    commandIds.push(oldCommandId);
    await prisma.gatewayCommand.create({
      data: {
        id: oldCommandId,
        postId: post.id,
        kind: 'device_recover',
        status: 'queued',
        createdAt: oldCreatedAt,
        deadlineAt: new Date(Date.now() - 30_000),
      },
    });
    const deliveryUnknownFingerprint = `gateway:post:${post.id}:command:device_recover_delivery_unknown`;
    await incidents.signal(gatewayCommandIncident(post.id, 'device_recover_delivery_unknown'));

    const barrier = await holdAdvisoryFingerprint(prisma, deliveryUnknownFingerprint);
    const oldPollProjection = gateway.pollCommands(post.id);
    try {
      await barrier.waitUntilBlocked(oldPollProjection, 'older timeout/poll recovery projection');
      await expect(
        prisma.gatewayCommand.findUniqueOrThrow({ where: { id: oldCommandId } }),
      ).resolves.toMatchObject({ status: 'expired' });
      await createTerminal(
        post.id,
        `recover-done-${randomUUID()}`,
        'done',
        new Date(oldCreatedAt.getTime() + 1_000),
      );
    } finally {
      await barrier.release();
    }
    await oldPollProjection;
    await expect(
      prisma.operationalIncident.findUniqueOrThrow({
        where: { fingerprint: deliveryUnknownFingerprint },
      }),
    ).resolves.toMatchObject({ status: 'resolved' });
  });

  it('makes a blocked done callback apply a newer failure vector', async () => {
    const post = await createIncidentPost();
    const oldCreatedAt = new Date(Date.now() - 60_000);
    const oldCommandId = `recover-done-${randomUUID()}`;
    const leaseToken = `lease-${randomUUID()}`;
    commandIds.push(oldCommandId);
    await prisma.gatewayCommand.create({
      data: {
        id: oldCommandId,
        postId: post.id,
        kind: 'device_recover',
        status: 'in_flight',
        createdAt: oldCreatedAt,
        deadlineAt: new Date(Date.now() + 30_000),
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 20_000),
      },
    });
    const deliveryUnknownFingerprint = `gateway:post:${post.id}:command:device_recover_delivery_unknown`;
    const failedFingerprint = `gateway:post:${post.id}:command:device_recover_failed`;

    const barrier = await holdAdvisoryFingerprint(prisma, deliveryUnknownFingerprint);
    const oldDoneProjection = gateway.resolveCommand(
      oldCommandId,
      { ok: true, status: 'recovering' },
      post.id,
      leaseToken,
    );
    try {
      await barrier.waitUntilBlocked(oldDoneProjection, 'older successful recovery projection');
      await expect(
        prisma.gatewayCommand.findUniqueOrThrow({ where: { id: oldCommandId } }),
      ).resolves.toMatchObject({ status: 'done' });
      await createTerminal(
        post.id,
        `recover-failed-${randomUUID()}`,
        'failed',
        new Date(oldCreatedAt.getTime() + 1_000),
      );
    } finally {
      await barrier.release();
    }
    await oldDoneProjection;
    const converged = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint: failedFingerprint },
    });
    expect(converged.status).toBe('open');
    expect(JSON.stringify(converged)).not.toMatch(
      /rawPayload|result|reasonCode|credential|secret|bitmap|stack/i,
    );
  });

  it('dedupes the exact result and rejects plus audits a conflicting terminal result', async () => {
    const command = await queued();
    const [claim] = await gateway.pollCommands(post1.id);
    const result = scaleResult(2.5);
    await gateway.resolveCommand(command.id, result, post1.id, claim.leaseToken!);

    await expect(
      gateway.resolveCommand(
        command.id,
        { grossKg: 2.5, stable: true, status: 'ready', deviceId: 'dev-scale-1', ok: true },
        post1.id,
        claim.leaseToken!,
      ),
    ).resolves.toEqual({ ok: true, deduped: true, status: 'done' });
    await expect(
      gateway.resolveCommand(command.id, scaleResult(9), post1.id, claim.leaseToken!),
    ).rejects.toBeInstanceOf(ConflictException);

    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: { type: 'gateway:command_result_conflict', objectId: command.id },
      }),
    ).resolves.toBeTruthy();
  });

  it('linearizes concurrent result races into one fact, one dedupe or one audited conflict', async () => {
    const same = await queued();
    const [sameClaim] = await gateway.pollCommands(post1.id);
    const identical = await Promise.all([
      gateway.resolveCommand(same.id, scaleResult(2.5), post1.id, sameClaim.leaseToken!),
      gateway.resolveCommand(
        same.id,
        { grossKg: 2.5, stable: true, status: 'ready', deviceId: 'dev-scale-1', ok: true },
        post1.id,
        sameClaim.leaseToken!,
      ),
    ]);
    expect(identical.map((item) => item.deduped).sort()).toEqual([false, true]);

    const divergent = await queued();
    const claims = await gateway.pollCommands(post1.id);
    const divergentClaim = claims.find((claim) => claim.id === divergent.id)!;
    const raced = await Promise.allSettled([
      gateway.resolveCommand(divergent.id, scaleResult(2.5), post1.id, divergentClaim.leaseToken!),
      gateway.resolveCommand(divergent.id, scaleResult(9), post1.id, divergentClaim.leaseToken!),
    ]);

    expect(raced.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(
      raced.find((item): item is PromiseRejectedResult => item.status === 'rejected')!.reason,
    ).toBeInstanceOf(ConflictException);
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: { type: 'gateway:command_result_conflict', objectId: divergent.id },
      }),
    ).resolves.toBeTruthy();
  });

  it('returns an indistinguishable 404 when another post tries to resolve the command', async () => {
    const command = await queued();
    const [claim] = await gateway.pollCommands(post1.id);

    await expect(
      gateway.resolveCommand(command.id, scaleResult(2), post2.id, claim.leaseToken!),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reclaims only a safe expired lease and rejects the stale result token', async () => {
    const command = await queued('read_scale');
    const [first] = await gateway.pollCommands(post1.id);
    await prisma.gatewayCommand.update({
      where: { id: command.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    const [second] = await gateway.pollCommands(post1.id);
    expect(second.id).toBe(command.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attempt).toBe(2);

    await expect(
      gateway.resolveCommand(command.id, scaleResult(2), post1.id, first.leaseToken!),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      gateway.resolveCommand(command.id, scaleResult(2), post1.id, second.leaseToken!),
    ).resolves.toMatchObject({ status: 'done' });
  });

  it('never reissues a print but accepts the exact late result from its expired lease', async () => {
    const command = await queued('print');
    const [claim] = await gateway.pollCommands(post1.id);
    await prisma.gatewayCommand.update({
      where: { id: command.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(gateway.pollCommands(post1.id)).resolves.toEqual([]);
    const stored = await prisma.gatewayCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored).toMatchObject({
      status: 'delivery_unknown',
      result: expect.objectContaining({ ok: false, status: 'delivery_unknown' }),
      resultFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    await expect(
      gateway.resolveCommand(
        command.id,
        { ok: true, status: 'submitted', jobId: 'late-device-job' },
        post1.id,
        claim.leaseToken!,
      ),
    ).resolves.toEqual({ ok: true, deduped: false, recovered: true, status: 'done' });
    await expect(
      prisma.gatewayCommand.findUniqueOrThrow({ where: { id: command.id } }),
    ).resolves.toMatchObject({ status: 'done' });
    await expect(
      prisma.domainEvent.findFirstOrThrow({
        where: { type: 'gateway:command_recovered', objectId: command.id },
      }),
    ).resolves.toMatchObject({
      oldValue: { status: 'delivery_unknown' },
      newValue: { status: 'done' },
    });
  });

  it('temporarily gives the predecessor poll writer a rollback-compatible lease', async () => {
    const command = await queued();

    await expect(
      prisma.gatewayCommand.update({ where: { id: command.id }, data: { status: 'in_flight' } }),
    ).resolves.toMatchObject({
      status: 'in_flight',
      leaseToken: expect.stringMatching(/^legacy-/u),
      leaseExpiresAt: expect.any(Date),
      attempt: 1,
    });
  });

  it('dedupes concurrent ingest atomically without losing the scoped status side effect', async () => {
    const eventId = `gateway-concurrent-${randomUUID()}`;
    eventIds.push(eventId);
    const input = {
      eventId,
      kind: 'status' as const,
      payload: { deviceId: 'dev-scale-1', status: 'ready' },
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => gateway.ingest(post1.id, input)),
    );

    expect(results.filter((result) => result.deduped === false)).toHaveLength(1);
    expect(results.filter((result) => result.deduped === true)).toHaveLength(7);
    await expect(prisma.gatewayEvent.count({ where: { postId: post1.id, eventId } })).resolves.toBe(
      1,
    );
  });

  it('rejects a divergent HTTP ingest replay without storing a second event', async () => {
    const eventId = `gateway-divergent-${randomUUID()}`;
    eventIds.push(eventId);
    const firstPayload = {
      code: 'scan-1',
      metadata: { first: 1, second: 2 },
      sequence: ['a', 'b'],
    };

    await request(app.getHttpServer())
      .post('/gateway/ingest')
      .set('x-agent-token', 'agent-post-1')
      .send({ eventId, kind: 'scan', payload: firstPayload })
      .expect(201);
    await request(app.getHttpServer())
      .post('/gateway/ingest')
      .set('x-agent-token', 'agent-post-1')
      .send({
        eventId,
        kind: 'scan',
        payload: { sequence: ['a', 'b'], metadata: { second: 2, first: 1 }, code: 'scan-1' },
      })
      .expect(201)
      .expect(({ body }) => expect(body).toMatchObject({ deduped: true }));
    await request(app.getHttpServer())
      .post('/gateway/ingest')
      .set('x-agent-token', 'agent-post-1')
      .send({ eventId, kind: 'scan', payload: { ...firstPayload, sequence: ['b', 'a'] } })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('GATEWAY_EVENT_ID_CONFLICT'));

    await expect(prisma.gatewayEvent.count({ where: { postId: post1.id, eventId } })).resolves.toBe(
      1,
    );
    await expect(
      prisma.gatewayEvent.findUniqueOrThrow({
        where: { postId_eventId: { postId: post1.id, eventId } },
      }),
    ).resolves.toMatchObject({ payload: firstPayload, rawPayload: null });
  });
});
