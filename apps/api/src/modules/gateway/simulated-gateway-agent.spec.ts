import { SimulatedGatewayAgent, simulatedHeartbeatIntervalMs } from './simulated-gateway-agent';
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  isGatewayHeartbeatV2,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';

const scaleDevice = {
  deviceId: 'dev-scale-1',
  kind: 'scale' as const,
  status: 'ready' as const,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const gateway = {
    registerResponder: jest.fn(),
    unregisterResponder: jest.fn(),
    heartbeat: jest.fn().mockResolvedValue({}),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = new SimulatedGatewayAgent(gateway as any);
  return { gateway, agent };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function responderOf(gateway: any) {
  return gateway.registerResponder.mock.calls[0][1];
}

const palletPrinterPayload = (templateVersion: string) => ({
  printerId: 'dev-printer-1',
  kind: 'pallet_label',
  documentId: 'doc-1',
  templateVersion,
  widthMm: 100,
  heightMm: 150,
  dpi: 203,
  widthDots: 800,
  heightDots: 1200,
  bitmapBase64: Buffer.alloc(120_000).toString('base64'),
  copies: 1,
});

describe('SimulatedGatewayAgent', () => {
  const rollScanToken = `prt_${'a'.repeat(64)}`;

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it.each([
    [1, 333],
    [90, 30_000],
    [86_400, 30_000],
  ])('derives a %i-second stale threshold into a safe %i ms interval', (staleSec, expectedMs) => {
    expect(simulatedHeartbeatIntervalMs(staleSec)).toBe(expectedMs);
  });

  it('serializes rapid device toggles so the last heartbeat state wins', async () => {
    jest.useFakeTimers();
    const { gateway, agent } = setup();
    const delayedOffline = deferred();
    let durableStatus = 'unknown';
    gateway.heartbeat.mockImplementation(async (_postId: string, heartbeat: GatewayHeartbeatV2) => {
      const status = heartbeat.devices[0]?.status ?? 'unknown';
      if (status === 'offline') await delayedOffline.promise;
      durableStatus = status;
      return {};
    });
    await agent.attach('post-1', [scaleDevice], 250);

    const offline = agent.setOffline('dev-scale-1');
    await Promise.resolve();
    const online = agent.setOffline('dev-scale-1', false);
    await Promise.resolve();
    delayedOffline.resolve();
    await Promise.all([offline, online]);

    expect(durableStatus).toBe('ready');
    await agent.onModuleDestroy();
  });

  it('does not start periodic heartbeats when detach wins during the initial heartbeat', async () => {
    jest.useFakeTimers();
    const { gateway, agent } = setup();
    const initialHeartbeat = deferred();
    gateway.heartbeat.mockImplementationOnce(async () => {
      await initialHeartbeat.promise;
      return {};
    });

    const attaching = agent.attach('post-1', [scaleDevice], 250);
    await Promise.resolve();
    agent.detach('post-1');
    initialHeartbeat.resolve();
    await attaching;

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(750);
    expect(gateway.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('clears every owned heartbeat timer on destroy even without attachment tracking', async () => {
    jest.useFakeTimers();
    const { gateway, agent } = setup();
    const orphanTimer = setInterval(() => {
      void agent.sendHeartbeat('orphan-post', []);
    }, 250);
    orphanTimer.unref();
    (
      agent as unknown as {
        heartbeatTimers: Map<string, NodeJS.Timeout>;
      }
    ).heartbeatTimers.set('orphan-post', orphanTimer);

    await agent.onModuleDestroy();

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(750);
    expect(gateway.heartbeat).not.toHaveBeenCalled();
  });

  it('keeps an attached post fresh periodically and stops its unref timer on destroy', async () => {
    jest.useFakeTimers();
    const intervalSpy = jest.spyOn(global, 'setInterval');
    const { gateway, agent } = setup();
    const devices = [scaleDevice];

    await agent.attach('post-1', devices, 250);

    expect(gateway.heartbeat).toHaveBeenCalledTimes(1);
    expect(gateway.heartbeat).toHaveBeenLastCalledWith(
      'post-1',
      expect.objectContaining({
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        devices: [expect.objectContaining(scaleDevice)],
      }),
    );
    const timer = intervalSpy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await agent.setOffline('dev-scale-1');
    expect(gateway.heartbeat).toHaveBeenCalledTimes(2);
    expect(gateway.heartbeat).toHaveBeenLastCalledWith(
      'post-1',
      expect.objectContaining({
        devices: [expect.objectContaining({ ...scaleDevice, status: 'offline' })],
      }),
    );
    await jest.advanceTimersByTimeAsync(250);
    expect(gateway.heartbeat).toHaveBeenLastCalledWith(
      'post-1',
      expect.objectContaining({
        devices: [expect.objectContaining({ ...scaleDevice, status: 'offline' })],
      }),
    );
    await agent.setOffline('dev-scale-1', false);
    expect(gateway.heartbeat).toHaveBeenLastCalledWith(
      'post-1',
      expect.objectContaining({ devices: [expect.objectContaining(scaleDevice)] }),
    );
    await jest.advanceTimersByTimeAsync(500);
    expect(gateway.heartbeat).toHaveBeenCalledTimes(6);
    expect(
      gateway.heartbeat.mock.calls
        .slice(4)
        .map(([, heartbeat]: [string, GatewayHeartbeatV2]) => heartbeat.devices[0]?.status),
    ).toEqual(['ready', 'ready']);

    await (agent as unknown as { onModuleDestroy(): Promise<void> }).onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(750);
    expect(gateway.heartbeat).toHaveBeenCalledTimes(6);
  });

  it('attach registers a responder answering read_scale with a stable weight', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);
    await expect(
      responder('read_scale', { deviceId: 'dev-scale-1', kind: 'spool' }),
    ).resolves.toMatchObject({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      stable: true,
      grossKg: 2,
    });
    await expect(
      responder('read_scale', { deviceId: 'dev-scale-1', kind: 'roll' }),
    ).resolves.toMatchObject({ grossKg: 43.4 });
  });

  it('reports offline for a device flagged offline (exercises the 503 path)', async () => {
    const { gateway, agent } = setup();
    await agent.setOffline('dev-scale-2');
    agent.attach('post-2');
    const responder = responderOf(gateway);
    await expect(
      responder('read_scale', { deviceId: 'dev-scale-2', kind: 'spool' }),
    ).resolves.toMatchObject({ deviceId: 'dev-scale-2', status: 'offline', stable: false });
  });

  it('answers print with a printed job', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);
    await expect(
      responder('print', {
        printerId: 'dev-printer-1',
        kind: 'roll_label',
        rollCode: 'A-1',
        qrCode: rollScanToken,
      }),
    ).resolves.toMatchObject({ ok: true, status: 'printed' });
  });

  it('keeps the byte-exact v1 one-copy 100x150 pallet label contract accepted', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);
    const payload = palletPrinterPayload('pallet-100x150-v1');
    const before = Buffer.from(JSON.stringify(payload));

    await expect(responder('print', payload)).resolves.toMatchObject({
      ok: true,
      status: 'printed',
    });
    expect(Buffer.from(JSON.stringify(payload))).toEqual(before);
    await expect(responder('print', { ...payload, copies: 2 })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'invalid printer payload',
    });
  });

  it('accepts compact v2 through the unchanged pallet printer payload shape', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);

    await expect(
      responder('print', palletPrinterPayload('pallet-100x150-compact-v2')),
    ).resolves.toMatchObject({
      ok: true,
      status: 'printed',
    });
  });

  it('rejects browser-only square v4 through the unchanged physical printer contract', async () => {
    const { gateway, agent } = setup();
    await agent.attach('post-1');
    const responder = responderOf(gateway);

    const payload = palletPrinterPayload('pallet-100x100-square-v4');
    await expect(responder('print', payload)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'invalid printer payload',
    });
    expect(payload).toMatchObject({ widthDots: 800, heightDots: 1200, copies: 1 });
  });

  it('rejects browser-only safe v5 through the unchanged physical printer contract', async () => {
    const { gateway, agent } = setup();
    await agent.attach('post-1');
    const responder = responderOf(gateway);

    const payload = palletPrinterPayload('pallet-100x100-safe-v5');
    await expect(responder('print', payload)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'invalid printer payload',
    });
  });

  it('rejects browser-only extended v6 through the unchanged physical printer contract', async () => {
    const { gateway, agent } = setup();
    await agent.attach('post-1');
    const responder = responderOf(gateway);

    const payload = palletPrinterPayload('pallet-100x100-extended-v6');
    await expect(responder('print', payload)).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'invalid printer payload',
    });
  });

  it('fails closed for an unknown pallet label profile', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);

    await expect(
      responder('print', palletPrinterPayload('pallet-100x150-future-v4')),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'invalid printer payload',
    });
  });

  it('reports an offline printer without accepting the print job', async () => {
    const { gateway, agent } = setup();
    await agent.setOffline('dev-printer-1');
    agent.attach('post-1');
    const responder = responderOf(gateway);

    await expect(
      responder('print', {
        printerId: 'dev-printer-1',
        kind: 'roll_label',
        rollCode: 'A-1',
        qrCode: rollScanToken,
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      error: 'printer offline',
    });
  });

  it('tests a configured simulated device and reports an offline device honestly', async () => {
    const { gateway, agent } = setup();
    agent.attach('post-1');
    const responder = responderOf(gateway);

    await expect(
      responder('device_test', { deviceId: 'dev-scale-1', kind: 'scale' }),
    ).resolves.toMatchObject({
      ok: true,
      deviceId: 'dev-scale-1',
      status: 'ready',
      evidenceKind: 'simulated',
      physicalPass: false,
    });

    await agent.setOffline('dev-scale-1');
    await expect(
      responder('device_test', { deviceId: 'dev-scale-1', kind: 'scale' }),
    ).resolves.toMatchObject({ ok: false, deviceId: 'dev-scale-1', status: 'offline' });
  });

  it('recovers simulated state but requires a subsequent verification test', async () => {
    const { gateway, agent } = setup();
    await agent.setOffline('dev-printer-1');
    agent.attach('post-1');
    const responder = responderOf(gateway);

    await expect(
      responder('device_recover', { deviceId: 'dev-printer-1', kind: 'printer' }),
    ).resolves.toMatchObject({
      ok: true,
      deviceId: 'dev-printer-1',
      status: 'recovering',
    });
    await expect(
      responder('device_test', { deviceId: 'dev-printer-1', kind: 'printer' }),
    ).resolves.toMatchObject({ ok: true, status: 'ready' });
  });

  it('sendHeartbeat always emits the complete V2 contract', async () => {
    const { gateway, agent } = setup();
    await agent.sendHeartbeat('post-1', [scaleDevice]);

    const heartbeat = gateway.heartbeat.mock.calls[0]?.[1] as unknown;
    expect(isGatewayHeartbeatV2(heartbeat)).toBe(true);
    expect(heartbeat).toMatchObject({
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      agent: {
        capabilities: GATEWAY_CAPABILITIES,
      },
      devices: [
        {
          ...scaleDevice,
          driver: 'simulated.scale',
          driverVersion: '2.0.0',
        },
      ],
    });
  });
});
