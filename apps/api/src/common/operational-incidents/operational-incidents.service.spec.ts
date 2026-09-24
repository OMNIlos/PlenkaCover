import { ConflictException, NotFoundException } from '@nestjs/common';
import { OperationalIncidentsService } from './operational-incidents.service';

describe('OperationalIncidentsService', () => {
  const incident = {
    id: 'incident-1',
    fingerprint: 'onec:connection',
    scope: 'onec',
    targetType: 'connection',
    targetId: null,
    severity: 'critical',
    status: 'open',
    title: '1С недоступна',
    message: 'Connection failed',
    recovery: 'Проверить соединение',
    detectedAt: new Date('2026-07-25T07:00:00.000Z'),
    lastSeenAt: new Date('2026-07-25T07:00:00.000Z'),
    acknowledgedAt: null,
    acknowledgedById: null,
    resolvedAt: null,
    resolvedById: null,
  };
  const tx = {
    $queryRaw: jest.fn(),
    operationalIncident: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    domainEvent: { create: jest.fn() },
  };
  const prisma = {
    operationalIncident: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  };
  const audit = { record: jest.fn() };
  const service = new OperationalIncidentsService(prisma as never, audit as never);
  const signal = {
    fingerprint: 'onec:connection',
    scope: 'onec',
    targetType: 'connection',
    severity: 'critical',
    title: '1С недоступна',
    message: 'Connection failed: credential=secret',
    recovery: 'Проверить raw serial payload',
  } as const;

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (work: (client: typeof tx) => unknown) =>
      work(tx),
    );
    tx.operationalIncident.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([]);
    tx.operationalIncident.create.mockResolvedValue(incident);
    tx.operationalIncident.updateMany.mockResolvedValue({ count: 1 });
    prisma.operationalIncident.findUnique.mockResolvedValue(null);
    audit.record.mockResolvedValue(undefined);
  });

  it('locks sorted unique fingerprints before observing and applies actions in that order', async () => {
    const observed: string[] = [];

    await service.reconcileFingerprints(['post:z', 'device:a', 'post:z'], async (client) => {
      expect(client).toBe(tx);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
      observed.push('called');
      return [
        { kind: 'noop', fingerprint: 'device:a' },
        { kind: 'noop', fingerprint: 'post:z' },
      ];
    });

    expect(observed).toEqual(['called']);
    expect(tx.$queryRaw.mock.calls.map(([query]) => query.values[0])).toEqual([
      'device:a',
      'post:z',
    ]);
    expect(tx.$queryRaw.mock.calls.map(([query]) => query.strings.join(''))).toEqual([
      expect.stringMatching(/pg_advisory_xact_lock.*hashtextextended/u),
      expect.stringMatching(/pg_advisory_xact_lock.*hashtextextended/u),
    ]);
  });

  it('rejects observer actions outside the exact locked fingerprint set before mutation', async () => {
    await expect(
      service.reconcileFingerprints(['device:a'], async () => [
        { kind: 'signal', signal: { ...signal, fingerprint: 'device:b' } },
      ]),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.operationalIncident.findUnique).not.toHaveBeenCalled();
    expect(tx.operationalIncident.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('applies a source-authoritative signal and safe lifecycle audit in the lock transaction', async () => {
    await service.reconcileFingerprints([signal.fingerprint], async () => [
      {
        kind: 'signal',
        signal: {
          ...signal,
          rawPayload: { token: 'must-not-persist' },
        } as typeof signal,
      },
    ]);

    expect(tx.operationalIncident.create).toHaveBeenCalledWith({
      data: {
        fingerprint: signal.fingerprint,
        scope: signal.scope,
        targetType: signal.targetType,
        targetId: null,
        severity: signal.severity,
        title: signal.title,
        message: signal.message,
        recovery: signal.recovery,
        status: 'open',
      },
    });
    expect(JSON.stringify(tx.operationalIncident.create.mock.calls)).not.toContain('rawPayload');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'admin.incident.opened' }),
      tx,
    );
  });

  it('atomically creates a new incident and one safe opened fact', async () => {
    await expect(service.signal(signal)).resolves.toEqual(incident);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.operationalIncident.create.mock.invocationCallOrder[0],
    );
    expect(tx.operationalIncident.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ fingerprint: signal.fingerprint, status: 'open' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'admin.incident.opened',
        actorRole: 'admin',
        objectId: incident.id,
        oldValue: { status: null },
        newValue: { status: 'open' },
      },
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /credential|secret|raw serial|Connection failed/,
    );
  });

  it('lets an audit failure abort the same create transaction', async () => {
    const error = new Error('audit storage unavailable');
    audit.record.mockRejectedValueOnce(error);

    await expect(service.signal(signal)).rejects.toBe(error);

    expect(tx.operationalIncident.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(expect.any(Object), tx);
  });

  it.each(['open', 'acknowledged'])(
    'refreshes an active %s incident without emitting a lifecycle fact',
    async (status) => {
      const active = { ...incident, status };
      tx.operationalIncident.findUnique
        .mockResolvedValueOnce(active)
        .mockResolvedValueOnce({ ...active, message: signal.message });

      await service.signal(signal);

      expect(tx.operationalIncident.updateMany).toHaveBeenCalledWith({
        where: { id: incident.id, status: { in: ['open', 'acknowledged'] } },
        data: expect.objectContaining({
          severity: signal.severity,
          title: signal.title,
          message: signal.message,
          recovery: signal.recovery,
          lastSeenAt: expect.any(Date),
        }),
      });
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('claims a resolved episode once and records one safe reopened fact in the transaction', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce({ ...incident, status: 'resolved' })
      .mockResolvedValueOnce({ ...incident, status: 'open' });

    await service.signal(signal);

    expect(tx.operationalIncident.updateMany).toHaveBeenCalledWith({
      where: { id: incident.id, status: 'resolved' },
      data: expect.objectContaining({
        status: 'open',
        detectedAt: expect.any(Date),
        acknowledgedAt: null,
        acknowledgedById: null,
        resolvedAt: null,
        resolvedById: null,
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      {
        type: 'admin.incident.reopened',
        actorRole: 'admin',
        objectId: incident.id,
        oldValue: { status: 'resolved' },
        newValue: { status: 'open' },
      },
      tx,
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toMatch(
      /credential|secret|raw serial|Connection failed/,
    );
  });

  it('does not duplicate reopened when another signal wins the status CAS', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce({ ...incident, status: 'resolved' })
      .mockResolvedValueOnce({ ...incident, status: 'open' })
      .mockResolvedValueOnce({ ...incident, status: 'open', message: signal.message });
    tx.operationalIncident.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await service.signal(signal);

    expect(audit.record).not.toHaveBeenCalled();
    expect(tx.operationalIncident.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: incident.id, status: { in: ['open', 'acknowledged'] } },
      }),
    );
  });

  it('recovers from fingerprint create contention by refreshing the exact winner', async () => {
    const conflict = {
      code: 'P2002',
      meta: { target: ['fingerprint'] },
    };
    prisma.$transaction
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(async (work: (client: typeof tx) => unknown) => work(tx));
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce({ ...incident, message: signal.message });

    await expect(service.signal(signal)).resolves.toEqual(
      expect.objectContaining({ id: incident.id }),
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rethrows an unrelated unique conflict or a fingerprint conflict without a winner', async () => {
    const unrelated = { code: 'P2002', meta: { target: ['id'] } };
    prisma.$transaction.mockRejectedValueOnce(unrelated);
    await expect(service.signal(signal)).rejects.toBe(unrelated);
    expect(prisma.operationalIncident.findUnique).not.toHaveBeenCalled();

    const fingerprintConflict = {
      code: 'P2002',
      meta: { target: ['fingerprint'] },
    };
    prisma.$transaction
      .mockRejectedValueOnce(fingerprintConflict)
      .mockRejectedValueOnce(fingerprintConflict);
    await expect(service.signal(signal)).rejects.toBe(fingerprintConflict);
  });

  it('acknowledges an open incident transactionally with a reason', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce({ ...incident, status: 'acknowledged' });

    await service.acknowledge(
      { userId: 'admin-1', role: 'admin' },
      incident.id,
      'Принято в работу',
    );

    expect(tx.operationalIncident.updateMany).toHaveBeenCalledWith({
      where: { id: incident.id, status: 'open' },
      data: expect.objectContaining({ status: 'acknowledged', acknowledgedById: 'admin-1' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'admin.incident.acknowledged',
        objectId: incident.id,
        reason: 'Принято в работу',
      }),
      tx,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.operationalIncident.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('emits no duplicate transition event when a concurrent transition wins', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce({ ...incident, status: 'resolved' });
    tx.operationalIncident.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.resolve({ userId: 'admin-1', role: 'admin' }, incident.id, 'Проверено'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('resolves an existing incident by fingerprint and ignores a missing one', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce({ ...incident, status: 'resolved' });

    await service.resolveByFingerprint(
      { userId: 'admin-1', role: 'admin' },
      signal.fingerprint,
      'Verification passed.',
    );
    expect(tx.operationalIncident.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: incident.id, status: 'open' },
        data: expect.objectContaining({ status: 'resolved' }),
      }),
    );

    tx.operationalIncident.findUnique.mockResolvedValueOnce(null);
    await expect(
      service.resolveByFingerprint(
        { userId: 'admin-1', role: 'admin' },
        'missing',
        'Verification passed.',
      ),
    ).resolves.toBeNull();
  });

  it('absorbs a concurrent resolveByFingerprint winner without duplicating its event', async () => {
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce({ ...incident, status: 'resolved' });

    await expect(
      service.resolveByFingerprint(
        { userId: 'admin-1', role: 'admin' },
        signal.fingerprint,
        'Recovery verified',
      ),
    ).resolves.toBeNull();

    expect(tx.operationalIncident.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('does not let stale recovery absorb a conflict after the incident reopens', async () => {
    const reopened = { ...incident, detectedAt: new Date('2026-07-25T08:00:00.000Z') };
    tx.operationalIncident.findUnique
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce(incident)
      .mockResolvedValueOnce(reopened)
      .mockResolvedValueOnce(reopened);
    tx.operationalIncident.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.resolveByFingerprint(
        { userId: 'admin-1', role: 'admin' },
        signal.fingerprint,
        'Stale recovery',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects an unknown or already resolved incident', async () => {
    await expect(
      service.resolve({ userId: 'admin-1', role: 'admin' }, 'missing', 'Проверено'),
    ).rejects.toBeInstanceOf(NotFoundException);

    tx.operationalIncident.findUnique.mockResolvedValueOnce({
      ...incident,
      status: 'resolved',
    });
    tx.operationalIncident.findUnique.mockResolvedValueOnce({
      ...incident,
      status: 'resolved',
    });
    await expect(
      service.resolve({ userId: 'admin-1', role: 'admin' }, incident.id, 'Проверено'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
