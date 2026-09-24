import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../src/common/audit/audit.service';
import {
  deviceConnectionFingerprint,
  deviceConnectionIncident,
  postLivenessFingerprint,
  postLivenessIncident,
} from '../src/common/operational-incidents/device-incident-signals';
import { OperationalIncidentsModule } from '../src/common/operational-incidents/operational-incidents.module';
import {
  GATEWAY_INCIDENT_RECONCILER_ENABLED,
  GatewayIncidentReconciler,
} from '../src/common/operational-incidents/gateway-incident-reconciler.service';
import { OperationalIncidentsService } from '../src/common/operational-incidents/operational-incidents.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RoleInboxModule } from '../src/common/role-inbox/role-inbox.module';
import { RoleInboxProjectionService } from '../src/common/role-inbox/role-inbox.service';
import { runE2eWithCleanup } from './e2e-database';
import { holdAdvisoryFingerprint } from './postgres-advisory-barrier';

describe('Operational incident episodes and admin receipts (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let incidents: OperationalIncidentsService;
  let gatewayIncidents: GatewayIncidentReconciler;
  let inbox: RoleInboxProjectionService;
  const suffix = randomUUID().replaceAll('-', '');
  const fingerprint = `onec:${suffix}:connection`;
  const signal = {
    fingerprint,
    scope: 'onec',
    targetType: 'connection',
    targetId: suffix,
    severity: 'critical',
    title: '1С недоступна',
    message: 'Connection failed token=secret',
    recovery: 'Inspect raw adapter payload',
  } as const;
  let adminA: {
    userId: string;
    role: 'admin';
    capabilities: [];
  };
  let adminB: typeof adminA;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [OperationalIncidentsModule, RoleInboxModule],
    })
      .overrideProvider(GATEWAY_INCIDENT_RECONCILER_ENABLED)
      .useValue(false)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    incidents = moduleRef.get(OperationalIncidentsService);
    gatewayIncidents = moduleRef.get(GatewayIncidentReconciler);
    inbox = moduleRef.get(RoleInboxProjectionService);

    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          login: `incident-admin-a-${suffix}`,
          displayName: 'Incident admin A',
          role: 'admin',
        },
      }),
      prisma.user.create({
        data: {
          login: `incident-admin-b-${suffix}`,
          displayName: 'Incident admin B',
          role: 'admin',
        },
      }),
    ]);
    adminA = { userId: userA.id, role: 'admin', capabilities: [] };
    adminB = { userId: userB.id, role: 'admin', capabilities: [] };
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'operational incident testing module', run: () => moduleRef.close() }],
    );
  });

  it('creates one episode under contention and keeps two admin receipts independent', async () => {
    await Promise.all(Array.from({ length: 8 }, () => incidents.signal(signal)));

    const incident = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    const openedEvents = await prisma.domainEvent.findMany({
      where: { type: 'admin.incident.opened', objectId: incident.id },
    });
    expect(openedEvents).toHaveLength(1);
    expect(openedEvents[0]).toMatchObject({
      objectId: incident.id,
      detail: null,
      reason: null,
      oldValue: { status: null },
      newValue: { status: 'open' },
    });
    expect(JSON.stringify(openedEvents[0])).not.toMatch(/token=secret|raw adapter payload/i);

    const beforeRefresh = incident.lastSeenAt;
    await incidents.signal({ ...signal, message: 'Still unavailable' });
    const refreshed = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    expect(refreshed.lastSeenAt.getTime()).toBeGreaterThanOrEqual(beforeRefresh.getTime());
    await expect(
      prisma.domainEvent.count({
        where: { type: 'admin.incident.opened', objectId: incident.id },
      }),
    ).resolves.toBe(1);

    const eventId = openedEvents[0]!.id;
    const [pageA, pageB] = await Promise.all([
      inbox.list(adminA, 'admin', { limit: 100 }),
      inbox.list(adminB, 'admin', { limit: 100 }),
    ]);
    expect(pageA.items.find((item) => item.id === eventId)?.unread).toBe(true);
    expect(pageB.items.find((item) => item.id === eventId)?.unread).toBe(true);

    await inbox.markRead(adminA, 'admin', eventId);
    const [afterA, unchangedB] = await Promise.all([
      inbox.list(adminA, 'admin', { limit: 100 }),
      inbox.list(adminB, 'admin', { limit: 100 }),
    ]);
    expect(afterA.items.some((item) => item.id === eventId)).toBe(false);
    expect(unchangedB.items.find((item) => item.id === eventId)?.unread).toBe(true);

    await inbox.markRead(adminB, 'admin', eventId);
    await expect(
      prisma.notificationReceipt.count({
        where: { eventId, userId: { in: [adminA.userId, adminB.userId] } },
      }),
    ).resolves.toBe(2);
  });

  it('reopens a resolved episode exactly once under contention', async () => {
    const incident = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    await incidents.resolve(adminA, incident.id, 'Recovery verified');

    await Promise.all(Array.from({ length: 8 }, () => incidents.signal(signal)));

    const reopened = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    expect(reopened).toMatchObject({
      status: 'open',
      acknowledgedAt: null,
      acknowledgedById: null,
      resolvedAt: null,
      resolvedById: null,
    });
    const reopenedEvents = await prisma.domainEvent.findMany({
      where: { type: 'admin.incident.reopened', objectId: incident.id },
    });
    expect(reopenedEvents).toHaveLength(1);
    expect(reopenedEvents[0]).toMatchObject({
      detail: null,
      reason: null,
      oldValue: { status: 'resolved' },
      newValue: { status: 'open' },
    });
    expect(JSON.stringify(reopenedEvents[0])).not.toMatch(/token=secret|raw adapter payload/i);
  });

  it('resolves one active episode idempotently under concurrent recovery signals', async () => {
    const incident = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint },
    });
    const before = await prisma.domainEvent.count({
      where: { type: 'admin.incident.resolved', objectId: incident.id },
    });

    await expect(
      Promise.all(
        Array.from({ length: 8 }, () =>
          incidents.resolveByFingerprint(adminA, fingerprint, 'Concurrent recovery verified'),
        ),
      ),
    ).resolves.toHaveLength(8);

    await expect(
      prisma.operationalIncident.findUniqueOrThrow({ where: { fingerprint } }),
    ).resolves.toMatchObject({ status: 'resolved' });
    await expect(
      prisma.domainEvent.count({
        where: { type: 'admin.incident.resolved', objectId: incident.id },
      }),
    ).resolves.toBe(before + 1);
  });

  it('serializes source observation across workers and converges to the newest action', async () => {
    const orderedFingerprint = `device:${suffix}:ordered`;
    const probeFingerprint = `device:${suffix}:probe`;
    const orderedSignal = {
      fingerprint: orderedFingerprint,
      scope: 'device',
      targetType: 'scale',
      targetId: suffix,
      severity: 'warning',
      title: 'Весы недоступны',
      message: 'Устройство не подтвердило готовность.',
      recovery: 'Проверить подключение.',
    } as const;
    let releaseFirst!: () => void;
    const firstMayApply = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstObserved!: () => void;
    const firstIsObserving = new Promise<void>((resolve) => {
      firstObserved = resolve;
    });
    let secondObserved = false;

    const olderSignal = incidents.reconcileFingerprints([orderedFingerprint], async () => {
      firstObserved();
      await firstMayApply;
      return [{ kind: 'signal', signal: orderedSignal }];
    });
    await Promise.race([
      firstIsObserving,
      olderSignal.then(
        () => {
          throw new Error('First reconciliation completed before its observer was released.');
        },
        (error: unknown) => Promise.reject(error),
      ),
    ]);
    const newerResolve = incidents.reconcileFingerprints([orderedFingerprint], async (tx) => {
      secondObserved = true;
      const current = await tx.operationalIncident.findUnique({
        where: { fingerprint: orderedFingerprint },
      });
      return current
        ? [
            {
              kind: 'resolve',
              fingerprint: orderedFingerprint,
              actor: adminA,
              reason: 'Newest durable source is healthy',
            } as const,
          ]
        : [{ kind: 'noop', fingerprint: orderedFingerprint } as const];
    });

    try {
      await incidents.reconcileFingerprints([probeFingerprint], async () => [
        { kind: 'noop', fingerprint: probeFingerprint },
      ]);
      expect(secondObserved).toBe(false);
    } finally {
      releaseFirst();
    }
    await Promise.all([olderSignal, newerResolve]);

    const converged = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint: orderedFingerprint },
    });
    expect(converged.status).toBe('resolved');
    await expect(
      prisma.domainEvent.count({
        where: {
          objectId: converged.id,
          type: { in: ['admin.incident.opened', 'admin.incident.resolved'] },
        },
      }),
    ).resolves.toBe(2);

    await expect(
      Promise.all([
        incidents.reconcileFingerprints([`post:${suffix}:z`, `device:${suffix}:a`], async () => [
          { kind: 'noop', fingerprint: `post:${suffix}:z` },
          { kind: 'noop', fingerprint: `device:${suffix}:a` },
        ]),
        incidents.reconcileFingerprints([`device:${suffix}:a`, `post:${suffix}:z`], async () => [
          { kind: 'noop', fingerprint: `device:${suffix}:a` },
          { kind: 'noop', fingerprint: `post:${suffix}:z` },
        ]),
      ]),
    ).resolves.toHaveLength(2);
  });

  it('re-reads post and device source after the ordering lock instead of applying stale state', async () => {
    const now = new Date();
    const post = await prisma.post.create({
      data: {
        code: `INCIDENT-${suffix}`,
        name: 'Incident ordering post',
        status: 'active',
        agentStatus: 'offline',
        lastSeenAt: new Date(now.getTime() - 600_000),
      },
    });
    const device = await prisma.deviceRuntime.create({
      data: {
        code: `INCIDENT-SCALE-${suffix}`,
        label: 'Incident ordering scale',
        kind: 'scale',
        status: 'offline',
        isEnabled: true,
        postId: post.id,
        lastSeenAt: new Date(now.getTime() - 600_000),
      },
    });
    const postFingerprint = postLivenessFingerprint(post.id);
    const deviceFingerprint = deviceConnectionFingerprint(device.id);
    await incidents.signal(postLivenessIncident(post.id));
    await incidents.signal(deviceConnectionIncident(device.id, device.kind));

    const postBarrier = await holdAdvisoryFingerprint(prisma, postFingerprint);
    const postProjection = gatewayIncidents.reconcilePost(post.id, [device.id], now);
    try {
      await postBarrier.waitUntilBlocked(postProjection, 'older offline post projection');
      await prisma.post.update({
        where: { id: post.id },
        data: { agentStatus: 'online', lastSeenAt: now },
      });
    } finally {
      await postBarrier.release();
    }
    await postProjection;
    await expect(
      prisma.operationalIncident.findUniqueOrThrow({ where: { fingerprint: postFingerprint } }),
    ).resolves.toMatchObject({ status: 'resolved' });

    await prisma.deviceRuntime.update({
      where: { id: device.id },
      data: { status: 'ready', lastSeenAt: now },
    });
    const readyBarrier = await holdAdvisoryFingerprint(prisma, deviceFingerprint);
    const offlineProjection = gatewayIncidents.reconcilePost(post.id, [device.id], now);
    try {
      await readyBarrier.waitUntilBlocked(offlineProjection, 'older ready device projection');
      await prisma.deviceRuntime.update({
        where: { id: device.id },
        data: { status: 'offline', lastSeenAt: now },
      });
    } finally {
      await readyBarrier.release();
    }
    await offlineProjection;
    await expect(
      prisma.operationalIncident.findUniqueOrThrow({ where: { fingerprint: deviceFingerprint } }),
    ).resolves.toMatchObject({ status: 'open' });

    await incidents.resolveByFingerprint(adminA, deviceFingerprint, 'Prepare recovery ordering');
    const offlineBarrier = await holdAdvisoryFingerprint(prisma, deviceFingerprint);
    const readyProjection = gatewayIncidents.reconcilePost(post.id, [device.id], now);
    try {
      await offlineBarrier.waitUntilBlocked(readyProjection, 'older offline device projection');
      await prisma.deviceRuntime.update({
        where: { id: device.id },
        data: { status: 'ready', lastSeenAt: now },
      });
    } finally {
      await offlineBarrier.release();
    }
    await readyProjection;
    const recovered = await prisma.operationalIncident.findUniqueOrThrow({
      where: { fingerprint: deviceFingerprint },
    });
    expect(recovered.status).toBe('resolved');
    expect(JSON.stringify(recovered)).not.toMatch(
      /rawPayload|parsedPayload|agentTokenHash|credential|bitmap|stack/i,
    );
  });

  it('rolls back incident creation when lifecycle audit persistence fails', async () => {
    const rollbackFingerprint = `onec:${suffix}:rollback`;
    const failingModule = await Test.createTestingModule({
      imports: [OperationalIncidentsModule],
    })
      .overrideProvider(GATEWAY_INCIDENT_RECONCILER_ENABLED)
      .useValue(false)
      .overrideProvider(AuditService)
      .useValue({ record: jest.fn().mockRejectedValue(new Error('audit unavailable')) })
      .compile();
    await failingModule.init();
    const failingService = failingModule.get(OperationalIncidentsService);
    const failingPrisma = failingModule.get(PrismaService);

    await expect(
      failingService.signal({ ...signal, fingerprint: rollbackFingerprint }),
    ).rejects.toThrow('audit unavailable');
    await expect(
      failingPrisma.operationalIncident.findUnique({
        where: { fingerprint: rollbackFingerprint },
      }),
    ).resolves.toBeNull();

    await failingModule.close();
  });
});
