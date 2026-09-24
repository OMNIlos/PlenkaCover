import {
  ConflictException,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';
import { GatewayCommandTimeoutError, GatewayService } from './gateway.service';
import { loadRuntimeConfig, type RuntimeConfig } from '../../common/runtime-config';
import type { IncidentReporterAction } from '../../common/operational-incidents/operational-incident-reporter.service';

type Row = Record<string, any>;

const v2Heartbeat = (
  capabilities: GatewayHeartbeatV2['agent']['capabilities'] = GATEWAY_CAPABILITIES,
): GatewayHeartbeatV2 => ({
  protocolVersion: GATEWAY_PROTOCOL_VERSION,
  agent: {
    packageVersion: '1:0.0.1+git788.1785844317.1b5005b4660f',
    releaseCommit: '1b5005b4660f5997c956b718958e5ee3a3516d94',
    bootId: '7f620c8e-2bbf-4ef8-9e91-b094611229c7',
    startedAt: '2026-08-04T12:45:00.000Z',
    capabilities,
  },
  devices: [
    {
      deviceId: 'dev-scale-1',
      kind: 'scale',
      status: 'ready',
      driver: 'massa-k-protocol-100',
      driverVersion: '1',
      configFingerprint: 'a'.repeat(64),
      lastProbeAt: '2026-08-04T12:46:00.000Z',
    },
  ],
});

function setup(config: RuntimeConfig = loadRuntimeConfig({ APP_ENV: 'test' })) {
  const rows = new Map<string, Row>();
  const matches = (row: Row, where: Row): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      if (expected && typeof expected === 'object' && 'in' in expected) {
        if (!(expected.in as unknown[]).includes(row[key])) return false;
      } else if (row[key] !== expected) return false;
    }
    return true;
  };
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? Number(row[key] ?? 0) + Number(value.increment)
          : value;
    }
  };
  const gatewayCommand = {
    create: jest.fn().mockImplementation(({ data }: Row) => {
      const row = {
        status: 'queued',
        createdAt: new Date(),
        result: null,
        resultFingerprint: null,
        leaseToken: null,
        leaseExpiresAt: null,
        attempt: 0,
        resolvedAt: null,
        ...data,
      };
      rows.set(row.id, row);
      return Promise.resolve({ ...row });
    }),
    findUnique: jest
      .fn()
      .mockImplementation(({ where: { id } }: Row) =>
        Promise.resolve(rows.has(id) ? { ...rows.get(id)! } : null),
      ),
    findUniqueOrThrow: jest.fn().mockImplementation(({ where: { id } }: Row) => {
      const row = rows.get(id);
      if (!row) throw new Error('not found');
      return Promise.resolve({ ...row });
    }),
    findFirst: jest.fn().mockImplementation(({ where, orderBy }: Row) => {
      const candidates = [...rows.values()].filter((candidate) => matches(candidate, where));
      if (Array.isArray(orderBy)) {
        candidates.sort((left, right) => {
          for (const order of orderBy) {
            const [field, direction] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
            const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
            const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
            if (leftValue === rightValue) continue;
            const comparison = leftValue < rightValue ? -1 : 1;
            return direction === 'asc' ? comparison : -comparison;
          }
          return 0;
        });
      }
      const row = candidates[0];
      return Promise.resolve(row ? { ...row } : null);
    }),
    findMany: jest.fn().mockImplementation(({ where, select }: Row) =>
      Promise.resolve(
        [...rows.values()]
          .filter((candidate) => matches(candidate, where))
          .map((candidate) =>
            select
              ? Object.fromEntries(
                  Object.keys(select)
                    .filter((field) => select[field])
                    .map((field) => [field, candidate[field]]),
                )
              : { ...candidate },
          ),
      ),
    ),
    updateMany: jest.fn().mockImplementation(({ where, data }: Row) => {
      let count = 0;
      for (const row of rows.values()) {
        if (!matches(row, where)) continue;
        apply(row, data);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
  };
  const prisma: any = {
    gatewayCommand,
    gatewayEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: Row) => Promise.resolve({ id: 'ev-1', ...data })),
    },
    post: {
      findFirst: jest.fn().mockResolvedValue({ id: 'post-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        id: 'post-1',
        code: 'POST-1',
        status: 'active',
        agentStatus: 'unknown',
      }),
      update: jest.fn().mockResolvedValue({
        id: 'post-1',
        code: 'POST-1',
        agentStatus: 'online',
      }),
    },
    deviceRuntime: {
      findFirst: jest.fn().mockResolvedValue({ id: 'dev-scale-1', status: 'ready' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'dev-scale-1', kind: 'scale', status: 'ready' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  prisma.$transaction = jest
    .fn()
    .mockImplementation((callback: (tx: any) => unknown) => callback(prisma));
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const incidents = {
    signal: jest.fn().mockResolvedValue(undefined),
    resolve: jest.fn().mockResolvedValue(undefined),
    reconcileFingerprints: jest.fn().mockResolvedValue(undefined),
  };
  const gatewayIncidents = {
    reconcilePost: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    audit,
    config,
    incidents,
    gatewayIncidents,
    rows,
    service: new GatewayService(
      prisma,
      audit as any,
      config,
      incidents as any,
      gatewayIncidents as never,
    ),
  };
}

describe('GatewayService — durable command correlation', () => {
  it('lets PostgreSQL assign the command issuance timestamp', async () => {
    const { service, prisma } = setup();
    service.registerResponder('post-1', async () => ({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 2,
    }));

    await service.dispatchCommand('post-1', 'read_scale', {});

    expect(prisma.gatewayCommand.create).toHaveBeenCalledWith({
      data: expect.not.objectContaining({ createdAt: expect.anything() }),
    });
  });

  it('claims and resolves a simulator command through the same lease path', async () => {
    const { service, rows } = setup();
    service.registerResponder('post-1', async () => ({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 2,
    }));

    await expect(service.dispatchCommand('post-1', 'read_scale', {})).resolves.toMatchObject({
      ok: true,
      grossKg: 2,
      gatewayCommandId: expect.any(String),
    });

    expect([...rows.values()][0]).toMatchObject({
      status: 'done',
      attempt: 1,
      leaseToken: expect.any(String),
      resultFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('serializes two simulator commands for one physical post', async () => {
    const { service, prisma } = setup();
    let transactionTail = Promise.resolve();
    prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) => {
      const result = transactionTail.then(() => callback(prisma));
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const responder = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return {
        ok: true,
        deviceId: 'dev-scale-1',
        status: 'ready',
        stable: true,
        grossKg: 2,
      };
    });
    service.registerResponder('post-1', responder);

    const first = service.dispatchCommand('post-1', 'read_scale', {});
    const second = service.dispatchCommand('post-1', 'read_scale', {});
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(responder).toHaveBeenCalledTimes(1);
    expect(maxActive).toBe(1);
    releases.shift()?.();
    for (let attempt = 0; attempt < 10 && responder.mock.calls.length < 2; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(responder).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    releases.shift()?.();
    await Promise.all([first, second]);
  });

  it('times out a slow simulator without waiting for its responder to finish', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      service.registerResponder(
        'post-1',
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 1_000)),
      );

      const command = service.dispatchCommand('post-1', 'read_scale', {});
      const observed = command.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(100);

      await expect(observed).resolves.toBeInstanceOf(GatewayCommandTimeoutError);
      expect([...rows.values()][0]).toMatchObject({ status: 'expired' });
      await jest.advanceTimersByTimeAsync(1_000);
    } finally {
      jest.useRealTimers();
    }
  });

  it('activates the next simulator command after a hung responder reaches its deadline', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service } = setup(config);
      const responder = jest
        .fn()
        .mockImplementationOnce(() => new Promise<Record<string, unknown>>(() => undefined))
        .mockResolvedValueOnce({
          ok: true,
          deviceId: 'dev-scale-1',
          status: 'ready',
          stable: true,
          grossKg: 2,
        });
      service.registerResponder('post-1', responder);

      const first = service.dispatchCommand('post-1', 'read_scale', {}).catch((error) => error);
      await jest.advanceTimersByTimeAsync(50);
      expect(responder).toHaveBeenCalledTimes(1);

      const second = service.dispatchCommand('post-1', 'read_scale', {});
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(50);
      for (let attempt = 0; attempt < 10 && responder.mock.calls.length < 2; attempt += 1) {
        await Promise.resolve();
      }

      await expect(first).resolves.toBeInstanceOf(GatewayCommandTimeoutError);
      expect(responder).toHaveBeenCalledTimes(2);
      await expect(second).resolves.toMatchObject({ ok: true, grossKg: 2 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects on timeout and persists an expired terminal fact', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      const pending = expect(service.dispatchCommand('post-1', 'read_scale', {})).rejects.toThrow(
        GatewayCommandTimeoutError,
      );

      await jest.advanceTimersByTimeAsync(100);
      await pending;
      expect([...rows.values()][0]).toMatchObject({
        status: 'expired',
        result: expect.objectContaining({ reasonCode: 'gateway_command_deadline_exceeded' }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a result committed just before the local timeout handler runs', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      const pending = service.dispatchCommand('post-1', 'read_scale', {});
      await jest.advanceTimersByTimeAsync(0);
      const command = [...rows.values()][0];
      command.status = 'done';
      command.result = {
        ok: true,
        status: 'ready',
        deviceId: 'dev-scale-1',
        stable: true,
        grossKg: 2,
      };

      await jest.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ ok: true, grossKg: 2 });
      expect(command).toMatchObject({ status: 'done', result: { ok: true, grossKg: 2 } });
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves a reconciled unclaimed-print expiry and rejects with its safe outcome', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      const observed = service.dispatchCommand('post-1', 'print', {}).catch((error) => error);
      await jest.advanceTimersByTimeAsync(0);
      const command = [...rows.values()][0];
      command.status = 'expired';
      command.result = {
        ok: false,
        status: 'expired',
        reasonCode: 'gateway_command_not_dispatched_before_deadline',
      };

      await jest.advanceTimersByTimeAsync(100);

      await expect(observed).resolves.toMatchObject({ outcome: 'expired' });
      expect(command).toMatchObject({ status: 'expired' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('expires a print command that the agent never claimed', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      const pending = service.dispatchCommand('post-1', 'print', {}).catch((error) => error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ outcome: 'expired' });
      expect([...rows.values()][0]).toMatchObject({
        status: 'expired',
        result: expect.objectContaining({
          reasonCode: 'gateway_command_not_dispatched_before_deadline',
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a claimed print timeout delivery_unknown because a side effect may have started', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, rows } = setup(config);
      const pending = service.dispatchCommand('post-1', 'print', {}).catch((error) => error);
      await jest.advanceTimersByTimeAsync(0);
      const command = [...rows.values()][0];
      command.status = 'in_flight';
      command.leaseToken = 'lease-print';
      command.leaseExpiresAt = new Date(Date.now() + 100);

      await jest.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({ outcome: 'delivery_unknown' });
      expect(command).toMatchObject({ status: 'delivery_unknown' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('expires an unclaimed mutating recovery without claiming a device side effect', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, prisma, rows, incidents } = setup(config);
      const pending = service
        .dispatchCommand('post-1', 'device_recover', {})
        .catch((error) => error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ outcome: 'expired' });
      expect([...rows.values()][0]).toMatchObject({ status: 'expired' });
      const actions = await incidents.reconcileFingerprints.mock.calls[0][1](prisma);
      expect(actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'signal',
            signal: expect.objectContaining({
              fingerprint: 'gateway:post:post-1:command:device_recover_expired',
              targetId: 'post-1',
            }),
          }),
        ]),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('accepts a late durable result for the exact timed-out unsafe lease', async () => {
    jest.useFakeTimers();
    try {
      const config = loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '100' });
      const { service, prisma, rows, audit } = setup(config);
      const pending = service.dispatchCommand('post-1', 'print', {}).catch((error) => error);
      await jest.advanceTimersByTimeAsync(0);
      const command = [...rows.values()][0];
      command.status = 'in_flight';
      command.leaseToken = 'lease-print';
      command.leaseExpiresAt = new Date(Date.now() + 100);

      await jest.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ outcome: 'delivery_unknown' });

      await expect(
        service.resolveCommand(
          command.id,
          { ok: true, status: 'submitted', jobId: 'TLP4-1049' },
          'post-1',
          'lease-print',
        ),
      ).resolves.toEqual({ ok: true, deduped: false, recovered: true, status: 'done' });
      expect(command).toMatchObject({
        status: 'done',
        result: { ok: true, status: 'submitted', jobId: 'TLP4-1049' },
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'gateway:command_recovered',
          objectId: command.id,
          oldValue: { status: 'delivery_unknown' },
          newValue: { status: 'done' },
          detail: { postId: 'post-1', kind: 'print' },
        }),
        prisma,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite delivery_unknown reported by the physical printer', async () => {
    const { service, prisma } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'cmd-printer-unknown',
        postId: 'post-1',
        kind: 'print',
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-print',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });
    await service.resolveCommand(
      'cmd-printer-unknown',
      { ok: false, status: 'delivery_unknown' },
      'post-1',
      'lease-print',
    );

    await expect(
      service.resolveCommand(
        'cmd-printer-unknown',
        { ok: true, status: 'submitted', jobId: 'TLP4-1050' },
        'post-1',
        'lease-print',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('persists a result without relying on an in-memory waiter and dedupes exact JSON', async () => {
    const { service, prisma, rows } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'cmd-1',
        postId: 'post-1',
        kind: 'read_scale',
        createdAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-1',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });

    await expect(
      service.resolveCommand(
        'cmd-1',
        { ok: true, deviceId: 'dev-scale-1', status: 'ready', stable: true, grossKg: 2 },
        'post-1',
        'lease-1',
      ),
    ).resolves.toEqual({ ok: true, deduped: false, status: 'done' });
    await expect(
      service.resolveCommand(
        'cmd-1',
        { grossKg: 2, stable: true, status: 'ready', deviceId: 'dev-scale-1', ok: true },
        'post-1',
        'lease-1',
      ),
    ).resolves.toEqual({ ok: true, deduped: true, status: 'done' });
    expect(rows.get('cmd-1')).toMatchObject({ status: 'done' });
  });

  it('rejects a divergent terminal replay and audits only safe metadata', async () => {
    const { service, prisma, audit } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'cmd-1',
        postId: 'post-1',
        kind: 'read_scale',
        createdAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-1',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });
    await service.resolveCommand(
      'cmd-1',
      { ok: true, deviceId: 'dev-scale-1', status: 'ready', stable: true, grossKg: 2 },
      'post-1',
      'lease-1',
    );

    await expect(
      service.resolveCommand(
        'cmd-1',
        { ok: true, deviceId: 'dev-scale-1', status: 'ready', stable: true, grossKg: 3 },
        'post-1',
        'lease-1',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway:command_result_conflict',
        objectId: 'cmd-1',
        detail: { postId: 'post-1', terminalStatus: 'done' },
      }),
    );
  });

  it('projects only newly committed device recovery terminals across old replays', async () => {
    const { service, prisma, incidents } = setup();
    const createRecovery = (id: string, leaseToken: string) =>
      prisma.gatewayCommand.create({
        data: {
          id,
          postId: 'post-1',
          kind: 'device_recover',
          createdAt: new Date(),
          deadlineAt: new Date(Date.now() + 5_000),
          status: 'in_flight',
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 2_000),
        },
      });

    await createRecovery('recover-failed-old', 'lease-failed-old');
    await service.resolveCommand(
      'recover-failed-old',
      { ok: false, status: 'failed' },
      'post-1',
      'lease-failed-old',
    );
    await createRecovery('recover-success-new', 'lease-success-new');
    await service.resolveCommand(
      'recover-success-new',
      { ok: true, status: 'recovering' },
      'post-1',
      'lease-success-new',
    );
    incidents.signal.mockClear();
    incidents.resolve.mockClear();

    await service.resolveCommand(
      'recover-failed-old',
      { ok: false, status: 'failed' },
      'post-1',
      'lease-failed-old',
    );

    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();

    await createRecovery('recover-failed-new', 'lease-failed-new');
    await service.resolveCommand(
      'recover-failed-new',
      { ok: false, status: 'failed' },
      'post-1',
      'lease-failed-new',
    );
    incidents.signal.mockClear();
    incidents.resolve.mockClear();

    await service.resolveCommand(
      'recover-success-new',
      { ok: true, status: 'recovering' },
      'post-1',
      'lease-success-new',
    );

    expect(incidents.signal).not.toHaveBeenCalled();
    expect(incidents.resolve).not.toHaveBeenCalled();
  });

  it('recovers a device command from an exact late durable result', async () => {
    const { service, prisma, incidents } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-deadline',
        postId: 'post-1',
        kind: 'device_recover',
        createdAt: new Date(Date.now() - 10_000),
        deadlineAt: new Date(Date.now() - 1_000),
        status: 'in_flight',
        leaseToken: 'lease-deadline',
        leaseExpiresAt: new Date(Date.now() - 500),
      },
    });

    await expect(
      service.resolveCommand(
        'recover-deadline',
        { ok: true, status: 'recovering' },
        'post-1',
        'lease-deadline',
      ),
    ).resolves.toEqual({ ok: true, deduped: false, recovered: true, status: 'done' });

    const actions = await incidents.reconcileFingerprints.mock.calls[0][1](prisma);
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
    ]);
  });

  it('uses an indistinguishable 404 for a cross-post result', async () => {
    const { service, prisma } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'cmd-1',
        postId: 'post-1',
        kind: 'read_scale',
        deadlineAt: new Date(Date.now() + 5_000),
      },
    });
    await expect(
      service.resolveCommand('cmd-1', { ok: true }, 'post-2', 'lease-forged'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns only rows from the atomic claim CTE', async () => {
    const { service, prisma } = setup();
    const claimed = [
      {
        id: 'cmd-1',
        createdAt: new Date(2),
        leaseToken: 'lease-1',
        serverTime: new Date(10),
        executionBudgetMs: 5_000,
      },
      {
        id: 'cmd-2',
        createdAt: new Date(1),
        leaseToken: 'lease-2',
        serverTime: new Date(10),
        executionBudgetMs: 5_000,
      },
    ];
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(claimed);

    await expect(service.pollCommands('post-1')).resolves.toEqual([claimed[1], claimed[0]]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(5);
  });

  it('compares UTC-naive gateway deadlines with one explicit UTC database clock', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await service.pollCommands('post-1');

    const sql = prisma.$queryRaw.mock.calls
      .map(([query]: [Prisma.Sql]) => query.strings.join('?'))
      .join('\n');
    expect(sql).toContain(`clock_timestamp() AT TIME ZONE 'UTC'`);
    expect(sql).not.toMatch(/(?<!AT TIME ZONE 'UTC')\bCURRENT_TIMESTAMP\b/u);
    expect(sql.match(/clock_timestamp\(\)(?!\s+AT TIME ZONE 'UTC')/gu)).toBeNull();
  });

  it('projects a compatible physical post command as a V2 envelope', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      agentCompatibility: 'compatible',
    });
    const claimed = {
      id: 'cmd-print-v2',
      postId: 'post-1',
      kind: 'print',
      payload: {
        printerId: 'printer-1',
        kind: 'roll_label',
        rollCode: 'ROLL-1',
        qrCode: `prt_${'a'.repeat(64)}`,
      },
      createdAt: new Date(1),
      deadlineAt: new Date(Date.now() + 5_000),
      leaseToken: 'lease-v2',
      serverTime: new Date(10),
      executionBudgetMs: 5_000,
    };
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([claimed]);

    await expect(service.pollCommands('post-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'cmd-print-v2',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'label.print.v1',
        payload: {
          printerId: 'printer-1',
          label: {
            schemaVersion: 1,
            kind: 'roll_label',
            rollCode: 'ROLL-1',
            qrCode: `prt_${'a'.repeat(64)}`,
          },
        },
      }),
    ]);
  });

  it('projects operator-directed defect labels with schema v2', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      agentCompatibility: 'compatible',
    });
    const claimed = {
      id: 'cmd-defect-print-v2',
      postId: 'post-1',
      kind: 'print',
      payload: {
        printerId: 'printer-1',
        kind: 'big_bag_label',
        destination: 'operator',
        bigBagCode: 'DEFECT-BAG-1',
        material: 'Бракованная плёнка',
        qrCode: `bbt_${'b'.repeat(64)}`,
      },
      createdAt: new Date(1),
      deadlineAt: new Date(Date.now() + 5_000),
      leaseToken: 'lease-defect-v2',
      serverTime: new Date(10),
      executionBudgetMs: 5_000,
    };
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([claimed]);

    await expect(service.pollCommands('post-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'cmd-defect-print-v2',
        kind: 'label.print.v1',
        payload: {
          printerId: 'printer-1',
          label: {
            schemaVersion: 2,
            kind: 'big_bag_label',
            destination: 'operator',
            bigBagCode: 'DEFECT-BAG-1',
            material: 'Бракованная плёнка',
            qrCode: `bbt_${'b'.repeat(64)}`,
          },
        },
      }),
    ]);
  });

  it('projects warehouse Big-Bag labels with schema v2 and an explicit destination', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      agentCompatibility: 'compatible',
    });
    const claimed = {
      id: 'cmd-warehouse-bag-v2',
      postId: 'post-1',
      kind: 'print',
      payload: {
        printerId: 'printer-1',
        kind: 'big_bag_label',
        destination: 'warehouse',
        bigBagCode: 'BIG-BAG-1',
        material: 'ПВД',
        qrCode: `bbt_${'c'.repeat(64)}`,
      },
      createdAt: new Date(1),
      deadlineAt: new Date(Date.now() + 5_000),
      leaseToken: 'lease-warehouse-v2',
      serverTime: new Date(10),
      executionBudgetMs: 5_000,
    };
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([claimed]);

    await expect(service.pollCommands('post-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'cmd-warehouse-bag-v2',
        kind: 'label.print.v1',
        payload: {
          printerId: 'printer-1',
          label: {
            schemaVersion: 2,
            kind: 'big_bag_label',
            destination: 'warehouse',
            bigBagCode: 'BIG-BAG-1',
            material: 'ПВД',
            qrCode: `bbt_${'c'.repeat(64)}`,
          },
        },
      }),
    ]);
  });

  it('does not promote a legacy Big-Bag payload without a destination', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      agentCompatibility: 'compatible',
    });
    const claimed = {
      id: 'legacy-defect-print-v1',
      postId: 'post-1',
      kind: 'print',
      payload: {
        printerId: 'printer-1',
        kind: 'big_bag_label',
        bigBagCode: 'DEFECT-BAG-1',
        material: 'Бракованная плёнка',
        qrCode: `bbt_${'d'.repeat(64)}`,
      },
      createdAt: new Date(1),
      deadlineAt: new Date(Date.now() + 5_000),
      leaseToken: 'lease-legacy-defect',
      serverTime: new Date(10),
      executionBudgetMs: 5_000,
    };
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: 'post-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([claimed]);

    await expect(service.pollCommands('post-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-defect-print-v1',
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        kind: 'print',
        payload: claimed.payload,
      }),
    ]);
  });

  it('does not lease commands to an agent with an unsupported protocol', async () => {
    const { service, prisma } = setup();
    prisma.post.findUnique.mockResolvedValueOnce({
      id: 'post-1',
      agentProtocolVersion: 99,
      agentCompatibility: 'unsupported',
    });

    await expect(service.pollCommands('post-1')).resolves.toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['missing discriminator', { status: 'printed', jobId: 'job-1' }],
    ['missing job id', { ok: true, status: 'submitted' }],
    ['contradictory print failure', { ok: false, status: 'submitted', jobId: 'job-1' }],
  ])('rejects malformed print result envelope: %s', async (_case, result) => {
    const { service, prisma, rows } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'cmd-malformed',
        postId: 'post-1',
        kind: 'print',
        createdAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-1',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });

    await expect(
      service.resolveCommand('cmd-malformed', result, 'post-1', 'lease-1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(rows.get('cmd-malformed')).toMatchObject({ status: 'in_flight', result: null });
  });

  it.each([
    ['read_scale', { ok: true, status: 'ready', stable: true, grossKg: 2 }],
    ['device_test', { ok: true, status: 'unstable', deviceId: 'scale-1' }],
    ['device_recover', { ok: true, status: 'ready', deviceId: 'scale-1' }],
  ])('rejects a contradictory %s result envelope', async (kind, result) => {
    const { service, prisma } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: `cmd-malformed-${kind}`,
        postId: 'post-1',
        kind,
        createdAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-1',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });

    await expect(
      service.resolveCommand(`cmd-malformed-${kind}`, result, 'post-1', 'lease-1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});

describe('GatewayService — reconciliation lifecycle', () => {
  it('keeps the periodic reconciliation single-flight while the database call is pending', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.$transaction.mockReturnValue(pending);

    try {
      service.onModuleInit();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.resolve(service.onModuleDestroy());
      jest.useRealTimers();
    }
  });

  it('does not finish module destruction before an active reconciliation settles', async () => {
    jest.useFakeTimers();
    const { service, prisma } = setup();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    prisma.$transaction.mockReturnValue(pending);
    service.onModuleInit();

    let destroyed = false;
    const destruction = Promise.resolve(service.onModuleDestroy()).then(() => {
      destroyed = true;
    });

    try {
      await Promise.resolve();
      expect(destroyed).toBe(false);
    } finally {
      release();
      await destruction;
      jest.useRealTimers();
    }
  });
});

describe('GatewayService — ingest & heartbeat', () => {
  it('persists V2 compatibility and safe device metadata in the heartbeat transaction', async () => {
    const { service, prisma } = setup();

    const result = await service.heartbeat('post-1', v2Heartbeat());

    expect(result).toMatchObject({
      accepted: true,
      compatibility: 'compatible',
      pollAllowed: true,
      serverProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      missingCapabilities: [],
    });
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
          agentPackageVersion: '1:0.0.1+git788.1785844317.1b5005b4660f',
          agentReleaseCommit: '1b5005b4660f5997c956b718958e5ee3a3516d94',
          agentBootId: '7f620c8e-2bbf-4ef8-9e91-b094611229c7',
          agentCapabilities: [...GATEWAY_CAPABILITIES],
          agentCompatibility: 'compatible',
        }),
      }),
    );
    expect(prisma.post.update.mock.calls[0][0].data).not.toHaveProperty('commissioningState');
    expect(prisma.deviceRuntime.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'dev-scale-1',
          postId: 'post-1',
          kind: 'scale',
        }),
        data: expect.objectContaining({
          driverName: 'massa-k-protocol-100',
          driverVersion: '1',
          configFingerprint: 'a'.repeat(64),
          lastProbeAt: new Date('2026-08-04T12:46:00.000Z'),
        }),
      }),
    );
  });

  it('keeps legacy heartbeat live but classifies it as upgrade-required', async () => {
    const { service, prisma } = setup();

    await expect(
      service.heartbeat('post-1', [{ deviceId: 'dev-scale-1', status: 'ready' }]),
    ).resolves.toMatchObject({
      accepted: true,
      compatibility: 'upgrade_required',
      pollAllowed: true,
      missingCapabilities: [...GATEWAY_CAPABILITIES],
    });
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentProtocolVersion: null,
          agentCompatibility: 'upgrade_required',
        }),
      }),
    );
  });

  it('rejects unknown V2 capabilities before persisting heartbeat state', async () => {
    const { service, prisma } = setup();
    const input = {
      ...v2Heartbeat(),
      agent: {
        ...v2Heartbeat().agent,
        capabilities: ['printer.future-label.v9'],
      },
    };

    await expect(service.heartbeat('post-1', input)).rejects.toMatchObject({
      response: { code: 'GATEWAY_HEARTBEAT_INVALID' },
    });
    expect(prisma.post.update).not.toHaveBeenCalled();
  });

  it('records unsupported protocol liveness but denies polling', async () => {
    const { service, prisma } = setup();

    await expect(
      service.heartbeat('post-1', { protocolVersion: 9, devices: [] }),
    ).resolves.toMatchObject({
      accepted: false,
      compatibility: 'unsupported',
      pollAllowed: false,
    });
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentProtocolVersion: 9,
          agentCompatibility: 'unsupported',
        }),
      }),
    );
  });

  it('reconciles status and heartbeat incidents from durable source ids after commit', async () => {
    const status = setup();
    await status.service.ingest('post-1', {
      eventId: 'source-status',
      kind: 'status',
      payload: { deviceId: 'dev-scale-1', status: 'offline' },
    });

    expect(status.gatewayIncidents.reconcilePost).toHaveBeenCalledWith('post-1', ['dev-scale-1']);
    expect(status.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      status.gatewayIncidents.reconcilePost.mock.invocationCallOrder[0],
    );

    const heartbeat = setup();
    await heartbeat.service.heartbeat('post-1', [{ deviceId: 'dev-scale-1', status: 'ready' }]);
    expect(heartbeat.gatewayIncidents.reconcilePost).toHaveBeenCalledWith(
      'post-1',
      ['dev-scale-1'],
      expect.any(Date),
    );
    expect(heartbeat.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      heartbeat.gatewayIncidents.reconcilePost.mock.invocationCallOrder[0],
    );
  });

  it('keeps committed status and heartbeat acknowledgements when source reconciliation fails', async () => {
    const status = setup();
    status.gatewayIncidents.reconcilePost.mockRejectedValueOnce(
      new Error('incident storage unavailable'),
    );
    await expect(
      status.service.ingest('post-1', {
        eventId: 'source-status-best-effort',
        kind: 'status',
        payload: { deviceId: 'dev-scale-1', status: 'offline' },
      }),
    ).resolves.toMatchObject({ deduped: false });

    const heartbeat = setup();
    heartbeat.gatewayIncidents.reconcilePost.mockRejectedValueOnce(
      new Error('incident storage unavailable'),
    );
    await expect(
      heartbeat.service.heartbeat('post-1', [{ deviceId: 'dev-scale-1', status: 'ready' }]),
    ).resolves.toMatchObject({ ok: true, postId: 'post-1' });
  });

  it('dedupes only a semantically equivalent ingest replay from the initial lookup', async () => {
    const { service, prisma } = setup();
    prisma.gatewayEvent.findUnique.mockResolvedValue({
      id: 'ev-1',
      postId: 'post-1',
      eventId: 'e1',
      kind: 'scan',
      payload: { code: 'x', metadata: { first: 1, second: 2 }, sequence: ['a', 'b'] },
      rawPayload: null,
    });

    await expect(
      service.ingest('post-1', {
        eventId: 'e1',
        kind: 'scan',
        payload: { sequence: ['a', 'b'], metadata: { second: 2, first: 1 }, code: 'x' },
      }),
    ).resolves.toMatchObject({ deduped: true });
    await expect(
      service.ingest('post-1', {
        eventId: 'e1',
        kind: 'scan',
        payload: { code: 'x', metadata: { first: 1, second: 2 }, sequence: ['b', 'a'] },
      }),
    ).rejects.toMatchObject({ response: { code: 'GATEWAY_EVENT_ID_CONFLICT' } });

    prisma.gatewayEvent.findUnique.mockResolvedValue({
      id: 'ev-2',
      postId: 'post-1',
      eventId: 'e2',
      kind: 'heartbeat',
      payload: null,
      rawPayload: null,
    });
    await expect(
      service.ingest('post-1', { eventId: 'e2', kind: 'heartbeat' }),
    ).resolves.toMatchObject({ deduped: true });
  });

  it('rejects a divergent ingest replay found after a P2002 create race', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    prisma.gatewayEvent.findUnique.mockResolvedValue({
      id: 'ev-1',
      postId: 'post-1',
      eventId: 'e1',
      kind: 'scan',
      payload: { code: 'x' },
      rawPayload: null,
    });

    await expect(
      service.ingest('post-1', { eventId: 'e1', kind: 'scan', payload: { code: 'y' } }),
    ).rejects.toMatchObject({ response: { code: 'GATEWAY_EVENT_ID_CONFLICT' } });
  });

  it('scopes and audits a device status transition without raw payload in the audit', async () => {
    const { service, prisma, audit, gatewayIncidents } = setup();
    prisma.deviceRuntime.findFirst
      .mockResolvedValueOnce({ id: 'dev-scale-1', status: 'ready' })
      .mockResolvedValueOnce({ id: 'dev-scale-1', kind: 'scale', status: 'unstable' });
    await service.ingest('post-1', {
      eventId: 'e2',
      kind: 'status',
      payload: { deviceId: 'dev-scale-1', status: 'unstable' },
      rawPayload: { frame: '0x00' },
    });
    expect(prisma.deviceRuntime.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'dev-scale-1', postId: 'post-1' }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway:device_status_changed',
        objectId: 'dev-scale-1',
        oldValue: { status: 'ready' },
        newValue: { status: 'unstable' },
      }),
      prisma,
    );
    expect(prisma.deviceRuntime.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastSeenAt: expect.any(Date) }),
      }),
    );
    expect(gatewayIncidents.reconcilePost).toHaveBeenCalledWith('post-1', ['dev-scale-1']);
    expect(JSON.stringify(gatewayIncidents.reconcilePost.mock.calls)).not.toMatch(
      /0x00|rawPayload|bitmap|credential|stack/i,
    );
  });

  it('resolves a ready device after the status fact commits and ignores a foreign device', async () => {
    const ready = setup();
    ready.prisma.deviceRuntime.findFirst
      .mockResolvedValueOnce({ id: 'dev-scale-1', status: 'offline' })
      .mockResolvedValueOnce({ id: 'dev-scale-1', kind: 'scale', status: 'ready' });

    await ready.service.ingest('post-1', {
      eventId: 'status-ready',
      kind: 'status',
      payload: { deviceId: 'dev-scale-1', status: 'ready' },
    });

    expect(ready.gatewayIncidents.reconcilePost).toHaveBeenCalledWith('post-1', ['dev-scale-1']);
    expect(ready.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      ready.gatewayIncidents.reconcilePost.mock.invocationCallOrder[0],
    );

    const foreign = setup();
    foreign.prisma.deviceRuntime.findFirst.mockResolvedValue(null);
    foreign.prisma.deviceRuntime.updateMany.mockResolvedValue({ count: 0 });
    await foreign.service.ingest('post-1', {
      eventId: 'status-foreign',
      kind: 'status',
      payload: { deviceId: 'foreign-device', status: 'offline' },
    });
    expect(foreign.gatewayIncidents.reconcilePost).toHaveBeenCalledWith('post-1', [
      'foreign-device',
    ]);
  });

  it('does not reopen incidents from disabled devices or inactive posts', async () => {
    const disabled = setup();
    disabled.prisma.deviceRuntime.findFirst.mockResolvedValue(null);
    disabled.prisma.deviceRuntime.updateMany.mockResolvedValue({ count: 0 });

    await disabled.service.ingest('post-1', {
      eventId: 'status-disabled',
      kind: 'status',
      payload: { deviceId: 'disabled-device', status: 'offline' },
    });

    expect(disabled.incidents.signal).not.toHaveBeenCalled();
    expect(disabled.incidents.resolve).not.toHaveBeenCalled();

    const inactive = setup();
    inactive.prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      code: 'POST-1',
      status: 'inactive',
      agentStatus: 'offline',
      lastSeenAt: new Date(),
    });
    inactive.prisma.deviceRuntime.findMany.mockResolvedValue([
      {
        id: 'dev-scale-1',
        kind: 'scale',
        status: 'offline',
        isEnabled: true,
      },
    ]);

    await inactive.service.heartbeat('post-1', [{ deviceId: 'dev-scale-1', status: 'offline' }]);

    expect(inactive.incidents.signal).not.toHaveBeenCalled();
    expect(inactive.incidents.resolve).not.toHaveBeenCalled();
  });

  it('keeps a committed status ingest successful when incident reconciliation storage fails', async () => {
    const logger = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const { service, gatewayIncidents } = setup();
    gatewayIncidents.reconcilePost.mockRejectedValueOnce(new Error('incident lookup unavailable'));

    await expect(
      service.ingest('post-1', {
        eventId: 'status-best-effort',
        kind: 'status',
        payload: { deviceId: 'dev-scale-1', status: 'offline' },
      }),
    ).resolves.toMatchObject({ deduped: false });
    expect(logger).toHaveBeenCalledWith('Gateway source incident reconciliation failed.');
  });

  it('creates a status event and applies its device side effect in the same transaction', async () => {
    const { service, prisma } = setup();
    const tx = {
      ...prisma,
      gatewayEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'event-in-tx', eventId: 'e-atomic' }),
      },
      deviceRuntime: {
        ...prisma.deviceRuntime,
        findFirst: jest.fn().mockResolvedValue({ id: 'dev-scale-1', status: 'ready' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((callback: (client: any) => unknown) => callback(tx));

    await service.ingest('post-1', {
      eventId: 'e-atomic',
      kind: 'status',
      payload: { deviceId: 'dev-scale-1', status: 'offline' },
    });

    expect(tx.gatewayEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.deviceRuntime.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayEvent.create).not.toHaveBeenCalled();
  });

  it('marks a post online and audits only the offline→online transition', async () => {
    const { service, prisma, audit, gatewayIncidents } = setup();
    await service.heartbeat('post-1', [
      { deviceId: 'dev-scale-1', status: 'ready' },
      { deviceId: 'foreign-device', status: 'offline' },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gateway:post_online' }),
      prisma,
    );
    expect(gatewayIncidents.reconcilePost).toHaveBeenCalledWith(
      'post-1',
      ['dev-scale-1'],
      expect.any(Date),
    );

    audit.record.mockClear();
    gatewayIncidents.reconcilePost.mockClear();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      code: 'POST-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: new Date(),
    });
    await service.heartbeat('post-1', []);
    expect(audit.record).not.toHaveBeenCalled();
    expect(gatewayIncidents.reconcilePost).toHaveBeenCalledWith('post-1', [], expect.any(Date));
  });

  it('does not clear a binding incident unless the enabled topology is exactly one device', async () => {
    const { service, prisma, gatewayIncidents } = setup();
    prisma.deviceRuntime.findMany
      .mockResolvedValueOnce([{ id: 'dev-scale-1', kind: 'scale', status: 'ready' }])
      .mockResolvedValueOnce([{ id: 'dev-scale-1' }, { id: 'dev-scale-2' }]);

    await service.heartbeat('post-1', [{ deviceId: 'dev-scale-1', status: 'ready' }]);

    expect(gatewayIncidents.reconcilePost).toHaveBeenCalledWith(
      'post-1',
      ['dev-scale-1'],
      expect.any(Date),
    );
  });

  it('returns a minimal heartbeat acknowledgement without the agent token verifier', async () => {
    const { service, prisma } = setup();
    prisma.post.update.mockResolvedValue({
      id: 'post-1',
      code: 'POST-1',
      agentStatus: 'online',
      lastSeenAt: new Date('2026-07-17T12:00:00.000Z'),
      agentTokenHash: 'must-not-cross-api-boundary',
      name: 'internal post row',
    });

    const result = await service.heartbeat('post-1', []);

    expect(result).toMatchObject({
      ok: true,
      postId: 'post-1',
      code: 'POST-1',
      agentStatus: 'online',
      lastSeenAt: new Date('2026-07-17T12:00:00.000Z'),
      compatibility: 'upgrade_required',
      pollAllowed: true,
      serverTime: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain('agentTokenHash');
    expect(prisma.post.update).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ agentTokenHash: true }),
      }),
    );
  });

  it('audits recovery when the stored online flag has a stale heartbeat', async () => {
    const { service, prisma, audit } = setup();
    prisma.post.findUnique.mockResolvedValue({
      id: 'post-1',
      code: 'POST-1',
      status: 'active',
      agentStatus: 'online',
      lastSeenAt: new Date(Date.now() - 120_000),
    });

    await service.heartbeat('post-1', []);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'gateway:post_online',
        detail: expect.objectContaining({ previousConnectionState: 'stale' }),
      }),
      prisma,
    );
  });
});

describe('GatewayService — incident ownership', () => {
  const reconcileRecoveryRepairs = (service: GatewayService) =>
    (
      service as unknown as {
        reconcileExpiredCommands(): Promise<void>;
      }
    ).reconcileExpiredCommands();

  async function persistCommand(
    kind: 'read_scale' | 'print' | 'device_test' | 'device_recover',
    result: Record<string, unknown>,
  ) {
    const context = setup();
    await context.prisma.gatewayCommand.create({
      data: {
        id: `cmd-${kind}`,
        postId: 'post-1',
        kind,
        createdAt: new Date(),
        deadlineAt: new Date(Date.now() + 5_000),
        status: 'in_flight',
        leaseToken: 'lease-1',
        leaseExpiresAt: new Date(Date.now() + 2_000),
      },
    });
    await context.service.resolveCommand(`cmd-${kind}`, result, 'post-1', 'lease-1');
    return context;
  }

  it('makes a delayed older failure project the newer durable recovery success', async () => {
    const { service, prisma, incidents } = setup();
    const observers: Array<(tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>> = [];
    incidents.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        observers.push(observe);
      },
    );
    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-a',
        postId: 'post-1',
        kind: 'device_recover',
        status: 'failed',
        createdAt: new Date('2026-07-25T08:00:00.000Z'),
        deadlineAt: new Date('2026-07-25T08:01:00.000Z'),
      },
    });

    await (
      service as unknown as {
        reportCommandOutcome(
          command: { postId: string; kind: string },
          status: string,
        ): Promise<void>;
      }
    ).reportCommandOutcome({ postId: 'post-1', kind: 'device_recover' }, 'failed');

    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-b',
        postId: 'post-1',
        kind: 'device_recover',
        status: 'done',
        createdAt: new Date('2026-07-25T08:00:01.000Z'),
        deadlineAt: new Date('2026-07-25T08:01:01.000Z'),
      },
    });

    await expect(observers[0](prisma)).resolves.toEqual([
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
    ]);
    expect(prisma.gatewayCommand.findFirst).toHaveBeenCalledWith({
      where: {
        postId: 'post-1',
        kind: 'device_recover',
        status: { in: ['done', 'failed', 'expired', 'delivery_unknown'] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true },
    });
  });

  it('makes a delayed older success project the newer durable recovery failure', async () => {
    const { service, prisma, incidents } = setup();
    const observers: Array<(tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>> = [];
    incidents.reconcileFingerprints.mockImplementation(
      async (
        _fingerprints: string[],
        observe: (tx: typeof prisma) => Promise<readonly IncidentReporterAction[]>,
      ) => {
        observers.push(observe);
      },
    );
    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-a',
        postId: 'post-1',
        kind: 'device_recover',
        status: 'done',
        createdAt: new Date('2026-07-25T08:00:00.000Z'),
        deadlineAt: new Date('2026-07-25T08:01:00.000Z'),
      },
    });

    await (
      service as unknown as {
        reportCommandOutcome(
          command: { postId: string; kind: string },
          status: string,
        ): Promise<void>;
      }
    ).reportCommandOutcome({ postId: 'post-1', kind: 'device_recover' }, 'done');

    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-b',
        postId: 'post-1',
        kind: 'device_recover',
        status: 'failed',
        createdAt: new Date('2026-07-25T08:00:01.000Z'),
        deadlineAt: new Date('2026-07-25T08:01:01.000Z'),
      },
    });

    const actions = await observers[0](prisma);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({
            fingerprint: 'gateway:post:post-1:command:device_recover_failed',
          }),
        }),
        expect.objectContaining({
          kind: 'resolve',
          fingerprint: 'gateway:post:post-1:command:device_recover_expired',
        }),
        expect.objectContaining({
          kind: 'resolve',
          fingerprint: 'gateway:post:post-1:command:device_recover_delivery_unknown',
        }),
      ]),
    );
    expect(JSON.stringify(actions)).not.toMatch(/credential|rawPayload|bitmap|stack|token/i);
  });

  it('repairs a missed recovery projection during poll', async () => {
    const { service, prisma, incidents } = setup();
    await prisma.gatewayCommand.create({
      data: {
        id: 'recover-terminal',
        postId: 'post-1',
        kind: 'device_recover',
        status: 'failed',
        createdAt: new Date('2026-07-25T08:00:00.000Z'),
        deadlineAt: new Date('2026-07-25T08:01:00.000Z'),
      },
    });

    await service.pollCommands('post-1');
    expect(incidents.reconcileFingerprints).toHaveBeenCalledTimes(1);
  });

  it('hard-bounds each periodic recovery repair pass', async () => {
    const { service, prisma, incidents } = setup();
    const postIds = Array.from(
      { length: 40 },
      (_, index) => `post-${String(index).padStart(2, '0')}`,
    );
    prisma.gatewayCommand.findMany.mockResolvedValue(postIds.map((postId) => ({ postId })));
    prisma.post.findFirst = jest.fn().mockResolvedValue({ id: postIds.at(-1) });
    prisma.post.findMany = jest
      .fn()
      .mockImplementation(({ take }: { take: number }) =>
        Promise.resolve(postIds.slice(0, take).map((id) => ({ id }))),
      );

    await reconcileRecoveryRepairs(service);

    expect(incidents.reconcileFingerprints).toHaveBeenCalledTimes(32);
    expect(prisma.post.findMany).toHaveBeenCalledWith({
      where: {
        id: { lte: postIds.at(-1) },
        commands: {
          some: {
            kind: 'device_recover',
            status: { in: ['done', 'failed', 'expired', 'delivery_unknown'] },
          },
        },
      },
      orderBy: { id: 'asc' },
      select: { id: true },
      take: 32,
    });
    expect(prisma.gatewayCommand.findMany).not.toHaveBeenCalled();
  });

  it('rotates a fixed post page without starving the tail when history keeps appending', async () => {
    const { service, prisma, incidents, audit, config, gatewayIncidents } = setup();
    const initial = Array.from(
      { length: 40 },
      (_, index) => `post-${String(index).padStart(3, '0')}`,
    );
    const appended = Array.from(
      { length: 40 },
      (_, index) => `post-${String(index + 40).padStart(3, '0')}`,
    );
    let eligible = [...initial];
    prisma.gatewayCommand.findMany.mockResolvedValue([]);
    prisma.post.findFirst = jest
      .fn()
      .mockImplementation(() => Promise.resolve({ id: eligible.at(-1) }));
    prisma.post.findMany = jest
      .fn()
      .mockImplementation(
        ({ where, take }: { where: { id: { gt?: string; lte: string } }; take: number }) =>
          Promise.resolve(
            eligible
              .filter((id) => (!where.id.gt || id > where.id.gt) && id <= where.id.lte)
              .slice(0, take)
              .map((id) => ({ id })),
          ),
      );
    const repairedPostIds = () =>
      incidents.reconcileFingerprints.mock.calls.map(
        ([fingerprints]: [string[]]) => fingerprints[0].match(/^gateway:post:(.+):command:/u)![1],
      );

    await reconcileRecoveryRepairs(service);
    expect(repairedPostIds()).toEqual(initial.slice(0, 32));

    eligible = [...initial, ...appended];
    incidents.reconcileFingerprints.mockClear();
    await reconcileRecoveryRepairs(service);
    expect(repairedPostIds()).toEqual(initial.slice(32));

    incidents.reconcileFingerprints.mockClear();
    await reconcileRecoveryRepairs(service);
    expect(repairedPostIds()).toEqual(initial.slice(0, 32));

    const secondInstance = new GatewayService(
      prisma,
      audit as never,
      config,
      incidents as never,
      gatewayIncidents as never,
    );
    incidents.reconcileFingerprints.mockClear();
    await reconcileRecoveryRepairs(secondInstance);
    expect(repairedPostIds()).toEqual(initial.slice(0, 32));
  });

  it('never opens an incident for a successful command completion', async () => {
    const { incidents, prisma } = await persistCommand('device_recover', {
      ok: true,
      status: 'recovering',
      deviceId: 'scale-1',
    });

    const actions = await incidents.reconcileFingerprints.mock.calls[0][1](prisma);
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
      expect.objectContaining({ kind: 'resolve' }),
    ]);
  });

  it('opens only uncovered device-recover terminal classes with stable fingerprints', async () => {
    const { incidents, audit, prisma } = await persistCommand('device_recover', {
      ok: false,
      status: 'failed',
      reasonCode: 'credential=secret rawPayload=frame',
    });

    const actions = await incidents.reconcileFingerprints.mock.calls[0][1](prisma);
    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'signal',
          signal: expect.objectContaining({
            fingerprint: 'gateway:post:post-1:command:device_recover_failed',
            targetId: 'post-1',
          }),
        }),
      ]),
    );
    expect(JSON.stringify(actions)).not.toMatch(/credential|secret|rawPayload|frame|stack|bitmap/i);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'gateway:command_completed' }),
      expect.anything(),
    );
  });

  it.each([
    ['read_scale', { ok: false, status: 'failed', reasonCode: 'scale_adapter_failed' }],
    ['print', { ok: false, status: 'failed', reasonCode: 'printer_adapter_failed' }],
    ['device_test', { ok: false, status: 'offline', reasonCode: 'device_test_failed' }],
  ] as const)(
    'suppresses gateway incidents for caller-owned %s terminal failures',
    async (kind, result) => {
      const { incidents } = await persistCommand(kind, result);
      expect(incidents.signal).not.toHaveBeenCalled();
    },
  );
});
