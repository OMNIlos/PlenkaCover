import { OperationalIncidentReporter } from './operational-incident-reporter.service';

describe('OperationalIncidentReporter', () => {
  const incidents = {
    signal: jest.fn(),
    resolveByFingerprint: jest.fn(),
    reconcileFingerprints: jest.fn(),
  };
  const reporter = new OperationalIncidentReporter(incidents as never);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('keeps a committed operation successful when incident persistence fails', async () => {
    incidents.resolveByFingerprint.mockRejectedValueOnce(new Error('incident database failed'));

    await expect(
      reporter.resolve('device:scale-1:connection', 'Device operation succeeded.'),
    ).resolves.toBeUndefined();
  });

  it('keeps the original operation error authoritative when incident signaling fails', async () => {
    incidents.signal.mockRejectedValueOnce(new Error('incident database failed'));

    await expect(
      reporter.signal({
        fingerprint: 'device:scale-1:connection',
        scope: 'device',
        targetType: 'scale',
        targetId: 'scale-1',
        severity: 'warning',
        title: 'Весы недоступны',
        message: 'Устройство не подтвердило готовность.',
        recovery: 'Проверить подключение устройства.',
      }),
    ).resolves.toBeUndefined();
  });

  it('uses a system admin actor and forwards only the supplied safe recovery fact', async () => {
    incidents.resolveByFingerprint.mockResolvedValueOnce(null);

    await reporter.resolve('gateway:post:post-1:liveness', 'Heartbeat restored.');

    expect(incidents.resolveByFingerprint).toHaveBeenCalledWith(
      { userId: null, role: 'admin' },
      'gateway:post:post-1:liveness',
      'Heartbeat restored.',
    );
  });

  it('reconciles locked source actions with the system actor after the lock is acquired', async () => {
    const tx = { gatewayCommand: { findFirst: jest.fn() } };
    incidents.reconcileFingerprints.mockImplementationOnce(
      async (_fingerprints: string[], observe: (client: typeof tx) => unknown) => observe(tx),
    );
    const observe = jest.fn().mockResolvedValue([
      {
        kind: 'resolve',
        fingerprint: 'gateway:post:post-1:liveness',
        reason: 'Current durable source is healthy.',
      },
      {
        kind: 'noop',
        fingerprint: 'device:scale-1:connection',
      },
    ]);

    await reporter.reconcileFingerprints(
      ['gateway:post:post-1:liveness', 'device:scale-1:connection'],
      observe,
    );

    expect(observe).toHaveBeenCalledWith(tx);
    const forwardedObserver = incidents.reconcileFingerprints.mock.calls[0][1];
    await expect(forwardedObserver(tx)).resolves.toEqual([
      {
        kind: 'resolve',
        fingerprint: 'gateway:post:post-1:liveness',
        actor: { userId: null, role: 'admin' },
        reason: 'Current durable source is healthy.',
      },
      {
        kind: 'noop',
        fingerprint: 'device:scale-1:connection',
      },
    ]);
  });

  it('keeps the primary durable outcome authoritative when locked reconciliation fails', async () => {
    incidents.reconcileFingerprints.mockRejectedValueOnce(new Error('projection unavailable'));

    await expect(
      reporter.reconcileFingerprints(['device:scale-1:connection'], async () => [
        {
          kind: 'signal',
          signal: {
            fingerprint: 'device:scale-1:connection',
            scope: 'device',
            targetType: 'scale',
            targetId: 'scale-1',
            severity: 'warning',
            title: 'Весы недоступны',
            message: 'Устройство не подтвердило готовность.',
            recovery: 'Проверить подключение устройства.',
          },
        },
      ]),
    ).resolves.toBeUndefined();
  });
});
