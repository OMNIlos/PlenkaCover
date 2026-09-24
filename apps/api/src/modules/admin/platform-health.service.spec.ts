import { PlatformHealthService } from './platform-health.service';

const actor = { userId: 'admin-1', role: 'admin' as const };

function setup() {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]),
    post: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'post-1',
          status: 'active',
          agentStatus: 'online',
          lastSeenAt: new Date(),
        },
      ]),
    },
    gatewayCommand: { count: jest.fn().mockResolvedValue(0) },
    syncJournal: { count: jest.fn().mockResolvedValue(0) },
    operationalCheck: { findFirst: jest.fn().mockResolvedValue(null) },
    operationalIncident: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const onec = {
    checkHealth: jest.fn().mockResolvedValue({
      mode: 'mock',
      status: 'ready',
      checkedAt: '2026-07-13T12:00:00.000Z',
      latencyMs: 1,
    }),
  };
  const checks = { record: jest.fn().mockResolvedValue({}) };
  const incidents = {
    signal: jest.fn().mockResolvedValue({}),
    resolveByFingerprint: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue([]),
    acknowledge: jest.fn(),
    resolve: jest.fn(),
  };
  const adminOneC = { check: jest.fn() };
  const devices = { test: jest.fn() };
  const warehouseCoverage = {
    snapshot: jest.fn().mockResolvedValue({
      currentStates: { awaiting_finance: 2 },
      currentAvailability: { verified_full: 2 },
      openRechecks: {
        finance_request: 1,
        decision_linked_physical_exception: 1,
      },
      processConflicts: {
        total: 3,
        byCode: { P2034: 1, '40001': 0, '40P01': 1, coverage_conflict: 1 },
        resetAt: '2026-07-25T09:30:00.000Z',
      },
    }),
  };
  const service = new PlatformHealthService(
    prisma as never,
    audit as never,
    onec as never,
    checks as never,
    incidents as never,
    adminOneC as never,
    devices as never,
    warehouseCoverage as never,
  );
  return {
    service,
    prisma,
    audit,
    onec,
    checks,
    incidents,
    adminOneC,
    devices,
    warehouseCoverage,
  };
}

describe('PlatformHealthService', () => {
  it('aggregates healthy database, OneC, gateway and background work', async () => {
    const { service, checks, audit } = setup();

    const result = await service.check(actor);

    expect(result.status).toBe('ready');
    expect(result.components.database.status).toBe('ready');
    expect(result.components.onec.status).toBe('ready');
    expect(result.components.gateway.status).toBe('ready');
    expect(result.components.background.status).toBe('ready');
    expect(result.warehouseCoverage).toMatchObject({
      currentStates: { awaiting_finance: 2 },
      processConflicts: { total: 3 },
    });
    expect(checks.record).toHaveBeenCalledTimes(5);
    expect(checks.record).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'platform', targetType: 'aggregate', status: 'passed' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.platform.check_requested' }),
    );
  });

  it('reports optional OneC failure as degraded and signals an incident', async () => {
    const { service, onec, incidents } = setup();
    onec.checkHealth.mockResolvedValue({
      mode: 'http',
      status: 'unavailable',
      checkedAt: '2026-07-13T12:00:00.000Z',
      latencyMs: 20,
      errorCategory: 'auth',
      message: '1С authentication failed.',
    });

    const result = await service.check(actor);

    expect(result.status).toBe('degraded');
    expect(result.components.database.status).toBe('ready');
    expect(result.components.onec.status).toBe('unavailable');
    expect(incidents.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'onec:connection' }),
    );
  });

  it('reports database failure as unavailable without leaking its error', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockRejectedValue(new Error('postgres://user:secret@db/plenka'));

    const result = await service.check(actor);

    expect(result.status).toBe('unavailable');
    expect(result.components.database.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('routes incident recheck to the owning scoped service', async () => {
    const { service, prisma, adminOneC, devices } = setup();
    prisma.operationalIncident.findUnique
      .mockResolvedValueOnce({ id: 'i1', scope: 'onec', targetId: null })
      .mockResolvedValueOnce({ id: 'i1', scope: 'device', targetId: 'device-1' });

    await service.recheckIncident(actor, 'i1');
    expect(adminOneC.check).toHaveBeenCalledWith(actor);

    await service.recheckIncident(actor, 'i1');
    expect(devices.test).toHaveBeenCalledWith(actor, 'device-1');
  });

  it('restores the latest aggregate component snapshot for the admin UI', async () => {
    const { service, prisma } = setup();
    prisma.operationalCheck.findFirst.mockResolvedValue({
      id: 'check-1',
      status: 'degraded',
      completedAt: new Date('2026-07-13T12:00:00.000Z'),
      summary: {
        status: 'degraded',
        service: 'plenka-api',
        components: { database: { status: 'ready', latencyMs: 2 } },
      },
    });

    await expect(service.snapshot()).resolves.toMatchObject({
      status: 'degraded',
      service: 'plenka-api',
      checkedAt: '2026-07-13T12:00:00.000Z',
      components: { database: { status: 'ready', latencyMs: 2 } },
      warehouseCoverage: {
        currentStates: { awaiting_finance: 2 },
        processConflicts: { total: 3 },
      },
    });
    expect(JSON.stringify(await service.snapshot())).not.toMatch(
      /rollCode|counterparty|orderNumber/u,
    );
  });
});
