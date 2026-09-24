import { Logger } from '@nestjs/common';
import { GATEWAY_CAPABILITIES } from '@plenka/contracts';
import { GatewayIncidentReconciler } from './gateway-incident-reconciler.service';
import type { IncidentReporterAction } from './operational-incident-reporter.service';

const NOW = new Date('2026-07-25T12:00:00.000Z');

function setup() {
  const initialPosts = [
    {
      id: 'post-online',
      code: 'POST-ONLINE',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: new Date(NOW.getTime() - 10_000),
    },
    {
      id: 'post-stale',
      code: 'POST-STALE',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: new Date(NOW.getTime() - 120_000),
    },
    {
      id: 'post-legacy',
      code: 'POST-LEGACY',
      status: 'active',
      agentStatus: 'unknown',
      lastSeenAt: null,
    },
  ];
  const prisma = {
    post: {
      findMany: jest.fn().mockResolvedValue(initialPosts),
      findUnique: jest
        .fn()
        .mockImplementation(({ where: { id } }) =>
          Promise.resolve(initialPosts.find((post) => post.id === id) ?? null),
        ),
    },
    deviceRuntime: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'scale-ready',
          code: 'SCALE-READY',
          kind: 'scale',
          status: 'ready',
          isEnabled: true,
          postId: 'post-online',
          lastSeenAt: new Date(NOW.getTime() - 10_000),
          post: { status: 'active' },
        },
        {
          id: 'printer-offline',
          code: 'PRINTER-OFFLINE',
          kind: 'printer',
          status: 'offline',
          isEnabled: true,
          postId: 'post-online',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
        {
          id: 'scanner-stale',
          code: 'SCANNER-STALE',
          kind: 'scanner',
          status: 'ready',
          isEnabled: true,
          postId: 'post-online',
          lastSeenAt: new Date(NOW.getTime() - 120_000),
          post: { status: 'active' },
        },
        {
          id: 'device-on-stale-post',
          code: 'DEVICE-ON-STALE-POST',
          kind: 'scale',
          status: 'offline',
          isEnabled: true,
          postId: 'post-stale',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
        {
          id: 'disabled-printer',
          code: 'DISABLED-PRINTER',
          kind: 'printer',
          status: 'offline',
          isEnabled: false,
          postId: 'post-online',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
        {
          id: 'scale-legacy',
          code: 'SCALE-LEGACY',
          kind: 'scale',
          status: 'ready',
          isEnabled: true,
          postId: 'post-legacy',
          lastSeenAt: null,
          post: { status: 'active' },
        },
      ]),
    },
  };
  const reporter = {
    signal: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
    reconcileFingerprints: jest.fn().mockResolvedValue(undefined),
  };
  reporter.reconcileFingerprints.mockImplementation(
    async (
      _fingerprints: string[],
      observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
    ) => {
      const actions = await observe(prisma);
      for (const action of actions) {
        if (action.kind === 'signal') await reporter.signal(action.signal);
        if (action.kind === 'resolve') await reporter.resolve(action.fingerprint, action.reason);
      }
    },
  );
  const service = new GatewayIncidentReconciler(prisma as never, reporter as never, true);
  return { service, prisma, reporter };
}

describe('GatewayIncidentReconciler', () => {
  const previousStale = process.env.GATEWAY_STALE_AFTER_SEC;
  const previousOffline = process.env.GATEWAY_OFFLINE_AFTER_SEC;

  beforeAll(() => {
    process.env.GATEWAY_STALE_AFTER_SEC = '90';
    process.env.GATEWAY_OFFLINE_AFTER_SEC = '300';
  });

  afterAll(() => {
    if (previousStale === undefined) delete process.env.GATEWAY_STALE_AFTER_SEC;
    else process.env.GATEWAY_STALE_AFTER_SEC = previousStale;
    if (previousOffline === undefined) delete process.env.GATEWAY_OFFLINE_AFTER_SEC;
    else process.env.GATEWAY_OFFLINE_AFTER_SEC = previousOffline;
  });

  it('uses safe bounded selects and reconciles one stable episode through stale and recovery', async () => {
    const { service, prisma, reporter } = setup();

    await service.reconcileNow(NOW);

    expect(prisma.post.findMany).toHaveBeenCalledWith({
      select: { id: true },
    });
    expect(prisma.deviceRuntime.findMany).toHaveBeenNthCalledWith(1, {
      where: { postId: { not: null } },
      select: { id: true, postId: true },
    });
    expect(
      JSON.stringify([prisma.post.findMany.mock.calls, prisma.deviceRuntime.findMany.mock.calls]),
    ).not.toMatch(/rawPayload|parsedPayload|agentTokenHash|payload|result/);

    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-stale:liveness',
        targetId: 'post-stale',
      }),
    );
    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:printer-offline:connection',
        targetId: 'printer-offline',
      }),
    );
    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'device:scanner-stale:connection',
        targetId: 'scanner-stale',
      }),
    );
    expect(reporter.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'device-on-stale-post' }),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'device:device-on-stale-post:connection',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'device:disabled-printer:connection',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'gateway:post:post-online:liveness',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'device:scale-ready:connection',
      expect.any(String),
    );
    expect(JSON.stringify(reporter.signal.mock.calls)).not.toMatch(
      /rawPayload|parsedPayload|agentTokenHash|token|bitmap|credential|stack/i,
    );

    reporter.signal.mockClear();
    reporter.resolve.mockClear();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-stale',
        code: 'POST-STALE',
        status: 'active',
        agentStatus: 'online',
        lastSeenAt: NOW,
      },
    ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-stale',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'scanner-stale',
        code: 'SCANNER-STALE',
        kind: 'scanner',
        status: 'ready',
        isEnabled: true,
        postId: 'post-stale',
        lastSeenAt: NOW,
        post: { status: 'active' },
      },
    ]);

    await service.reconcileNow(NOW);

    expect(reporter.resolve).toHaveBeenCalledWith(
      'gateway:post:post-stale:liveness',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'device:scanner-stale:connection',
      expect.any(String),
    );
  });

  it('treats discovery as ids only and cannot reopen a post after a newer online heartbeat', async () => {
    const { service, prisma, reporter } = setup();
    const actions: IncidentReporterAction[] = [];
    prisma.post.findMany.mockResolvedValue([{ id: 'post-1' }]);
    prisma.deviceRuntime.findMany
      .mockResolvedValueOnce([{ id: 'scale-1', postId: 'post-1' }])
      .mockResolvedValueOnce([
        {
          id: 'scale-1',
          kind: 'scale',
          status: 'ready',
          isEnabled: true,
          postId: 'post-1',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
      ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    reporter.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        actions.push(...(await observe(prisma)));
      },
    );

    await service.reconcileNow(NOW);

    expect(prisma.post.findMany).toHaveBeenCalledWith({ select: { id: true } });
    expect(prisma.deviceRuntime.findMany).toHaveBeenNthCalledWith(1, {
      where: { postId: { not: null } },
      select: { id: true, postId: true },
    });
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'resolve',
          fingerprint: 'gateway:post:post-1:liveness',
        }),
      ]),
    );
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({
            fingerprint: 'gateway:post:post-1:liveness',
          }),
        }),
      ]),
    );
    expect(
      JSON.stringify([
        prisma.post.findMany.mock.calls,
        prisma.post.findUnique.mock.calls,
        prisma.deviceRuntime.findMany.mock.calls,
      ]),
    ).not.toMatch(/rawPayload|parsedPayload|agentTokenHash|payload|result/);
  });

  it('does not resolve a device from an old ready snapshot after offline status commits', async () => {
    const { service, prisma, reporter } = setup();
    const actions: IncidentReporterAction[] = [];
    prisma.post.findMany.mockResolvedValue([{ id: 'post-1' }]);
    prisma.deviceRuntime.findMany
      .mockResolvedValueOnce([{ id: 'scale-1', postId: 'post-1' }])
      .mockResolvedValueOnce([
        {
          id: 'scale-1',
          kind: 'scale',
          status: 'offline',
          isEnabled: true,
          postId: 'post-1',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
      ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    reporter.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        actions.push(...(await observe(prisma)));
      },
    );

    await service.reconcileNow(NOW);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({ fingerprint: 'device:scale-1:connection' }),
        }),
      ]),
    );
  });

  it('does not reopen a device from an old offline snapshot after ready status commits', async () => {
    const { service, prisma, reporter } = setup();
    const actions: IncidentReporterAction[] = [];
    prisma.post.findMany.mockResolvedValue([{ id: 'post-1' }]);
    prisma.deviceRuntime.findMany
      .mockResolvedValueOnce([{ id: 'scale-1', postId: 'post-1' }])
      .mockResolvedValueOnce([
        {
          id: 'scale-1',
          kind: 'scale',
          status: 'ready',
          isEnabled: true,
          postId: 'post-1',
          lastSeenAt: NOW,
          post: { status: 'active' },
        },
      ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    reporter.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        actions.push(...(await observe(prisma)));
      },
    );

    await service.reconcileNow(NOW);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'resolve',
          fingerprint: 'device:scale-1:connection',
        }),
      ]),
    );
    expect(actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({ fingerprint: 'device:scale-1:connection' }),
        }),
      ]),
    );
  });

  it('does not mutate a device episode after the device moves to another post', async () => {
    const { service, prisma, reporter } = setup();
    const actions: IncidentReporterAction[] = [];
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'scale-moved',
        kind: 'scale',
        status: 'offline',
        isEnabled: true,
        postId: 'post-2',
        lastSeenAt: NOW,
        post: { status: 'active' },
      },
    ]);
    reporter.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        actions.push(...(await observe(prisma)));
      },
    );

    await service.reconcilePost('post-1', ['scale-moved'], NOW);

    expect(actions).toEqual(
      expect.arrayContaining([{ kind: 'noop', fingerprint: 'device:scale-moved:connection' }]),
    );
  });

  it('signals duplicate bindings and resolves only after the topology becomes unique', async () => {
    const { service, prisma, reporter } = setup();
    const actions: IncidentReporterAction[] = [];
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'scale-a',
        kind: 'scale',
        status: 'ready',
        isEnabled: true,
        postId: 'post-1',
        lastSeenAt: NOW,
        post: { status: 'active' },
      },
      {
        id: 'scale-b',
        kind: 'scale',
        status: 'ready',
        isEnabled: true,
        postId: 'post-1',
        lastSeenAt: NOW,
        post: { status: 'active' },
      },
    ]);
    reporter.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        actions.push(...(await observe(prisma)));
      },
    );

    await service.reconcilePost('post-1', ['scale-a', 'scale-b'], NOW);

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({ fingerprint: 'post:post-1:binding:scale' }),
        }),
      ]),
    );
  });

  it('signals incompatible agents and missing required capabilities independently', async () => {
    const { service, prisma, reporter } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
      commissioningState: 'commissioned',
      agentProtocolVersion: 2,
      agentCompatibility: 'upgrade_required',
      agentCapabilities: GATEWAY_CAPABILITIES.filter(
        (capability) => capability !== 'printer.big-bag-label.v1',
      ),
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([]);

    await service.reconcilePost('post-1', [], NOW);

    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-1:compatibility',
        targetId: 'post-1',
      }),
    );
    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({
        fingerprint: 'gateway:post:post-1:capabilities',
        targetId: 'post-1',
      }),
    );
    expect(JSON.stringify(reporter.signal.mock.calls)).not.toContain(
      'printer.big-bag-label.v1',
    );
  });

  it('subsumes device incidents under post liveness and restores the unhealthy owner on recovery', async () => {
    const { service, prisma, reporter } = setup();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-1',
        code: 'POST-1',
        status: 'active',
        agentStatus: 'online',
        lastSeenAt: new Date(NOW.getTime() - 120_000),
      },
    ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: new Date(NOW.getTime() - 120_000),
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'scale-1',
        code: 'SCALE-1',
        kind: 'scale',
        status: 'offline',
        isEnabled: true,
        postId: 'post-1',
        lastSeenAt: NOW,
        post: { status: 'active' },
      },
    ]);

    await service.reconcileNow(NOW);

    const deviceResolveOrder = reporter.resolve.mock.invocationCallOrder.find(
      (_, index) => reporter.resolve.mock.calls[index][0] === 'device:scale-1:connection',
    );
    const postSignalOrder = reporter.signal.mock.invocationCallOrder.find(
      (_, index) =>
        reporter.signal.mock.calls[index][0].fingerprint === 'gateway:post:post-1:liveness',
    );
    expect(deviceResolveOrder).toBeLessThan(postSignalOrder!);
    expect(reporter.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'device:scale-1:connection' }),
    );

    reporter.signal.mockClear();
    reporter.resolve.mockClear();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-1',
        code: 'POST-1',
        status: 'active',
        agentStatus: 'online',
        lastSeenAt: NOW,
      },
    ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: NOW,
    });

    await service.reconcileNow(NOW);

    expect(reporter.resolve).toHaveBeenCalledWith(
      'gateway:post:post-1:liveness',
      expect.any(String),
    );
    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'device:scale-1:connection' }),
    );
  });

  it('cleans up device and post episodes when topology is disabled', async () => {
    const { service, prisma, reporter } = setup();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-inactive',
        code: 'POST-INACTIVE',
        status: 'inactive',
        agentStatus: 'offline',
        lastSeenAt: NOW,
      },
    ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-inactive',
      status: 'inactive',
      agentStatus: 'offline',
      lastSeenAt: NOW,
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'scanner-disabled',
        code: 'SCANNER-DISABLED',
        kind: 'scanner',
        status: 'offline',
        isEnabled: false,
        postId: 'post-inactive',
        lastSeenAt: NOW,
        post: { status: 'inactive' },
      },
    ]);

    await service.reconcileNow(NOW);

    expect(reporter.resolve).toHaveBeenCalledWith(
      'gateway:post:post-inactive:liveness',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'device:scanner-disabled:connection',
      expect.any(String),
    );
    expect(reporter.resolve).toHaveBeenCalledWith(
      'post:post-inactive:binding:scanner',
      expect.any(String),
    );
    expect(reporter.signal).not.toHaveBeenCalled();
  });

  it('does not infer liveness for legacy null timestamps but signals missing bindings', async () => {
    const { service, prisma, reporter } = setup();
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-legacy',
        code: 'POST-LEGACY',
        status: 'active',
        agentStatus: 'unknown',
        lastSeenAt: null,
      },
    ]);
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-legacy',
      status: 'active',
      agentStatus: 'unknown',
      lastSeenAt: null,
    });
    prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'device-legacy',
        code: 'DEVICE-LEGACY',
        kind: 'scale',
        status: 'ready',
        isEnabled: true,
        postId: 'post-legacy',
        lastSeenAt: null,
        post: { status: 'active' },
      },
    ]);

    await service.reconcileNow(NOW);

    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'post:post-legacy:binding:scanner' }),
    );
    expect(reporter.signal).toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'post:post-legacy:binding:printer' }),
    );
    expect(reporter.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'gateway:post:post-legacy:liveness' }),
    );
    expect(reporter.signal).not.toHaveBeenCalledWith(
      expect.objectContaining({ fingerprint: 'device:device-legacy:connection' }),
    );
    expect(reporter.resolve).not.toHaveBeenCalledWith(
      'gateway:post:post-legacy:liveness',
      expect.any(String),
    );
    expect(reporter.resolve).not.toHaveBeenCalledWith(
      'device:device-legacy:connection',
      expect.any(String),
    );
  });

  it('keeps ticks single-flight and waits for the active run during destruction', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup();
    let release!: (value: []) => void;
    prisma.post.findMany.mockReturnValue(
      new Promise<[]>((resolve) => {
        release = resolve;
      }),
    );

    const first = service.reconcileNow(NOW);
    const second = service.reconcileNow(NOW);
    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);

    let destroyed = false;
    const destruction = service.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await Promise.resolve();
    expect(destroyed).toBe(false);

    release([]);
    await expect(Promise.all([first, second, destruction])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(prisma.post.findMany).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  it('does not run immediately on init and catches a scheduled database failure', async () => {
    jest.useFakeTimers();
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, prisma } = setup();
    prisma.post.findMany.mockRejectedValueOnce(new Error('database unavailable'));

    service.onModuleInit();
    expect(prisma.post.findMany).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(30_000);

    expect(logger).toHaveBeenCalledWith('Gateway incident reconciliation failed.');
    await service.onModuleDestroy();
    logger.mockRestore();
    jest.useRealTimers();
  });

  it('keeps the lifecycle worker off when the injected runtime policy disables it', async () => {
    jest.useFakeTimers();
    const { prisma, reporter } = setup();
    const disabled = new GatewayIncidentReconciler(prisma as never, reporter as never, false);

    disabled.onModuleInit();
    await jest.advanceTimersByTimeAsync(120_000);

    expect(prisma.post.findMany).not.toHaveBeenCalled();
    await disabled.onModuleDestroy();
    jest.useRealTimers();
  });
});
