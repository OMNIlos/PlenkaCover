import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_VERSION } from '@plenka/contracts';
import { GatewayAgent } from './agent';
import { GatewayApiError, type GatewayApiClient } from './api-client';
import type { AgentDevices } from './commands';
import { loadConfig } from './config';
import { OfflineBuffer } from './offline-buffer';
import { ResultOutbox } from './result-outbox';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-agent-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function devices(
  read = jest.fn().mockResolvedValue({ status: 'ready', stable: true, grossKg: 2 }),
  print = jest.fn().mockResolvedValue({ ok: true, status: 'printed', jobId: 'job-1' }),
) {
  return {
    read,
    value: {
      scale: {
        read,
        probe: jest.fn().mockResolvedValue({ ok: true, status: 'ready' }),
        status: (): 'ready' | 'offline' => 'ready',
        close: jest.fn().mockResolvedValue(undefined),
      },
      scaleDeviceId: 'scale-1',
      printer: {
        print,
        status: (): 'ready' | 'offline' => 'ready',
      },
      printerDeviceId: 'printer-1',
      printerMode: 'simulated',
      scanner: {
        status: (): 'ready' | 'offline' => 'ready',
      },
      scannerDeviceId: null as string | null,
    } satisfies AgentDevices,
    print,
  };
}

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig(
    {
      GATEWAY_AGENT_TOKEN: 'test-token',
      GATEWAY_SCALE_DEVICE_ID: 'scale-1',
      GATEWAY_PRINTER_DEVICE_ID: 'printer-1',
      GATEWAY_BUFFER_DIR: dir,
      ...overrides,
    },
    '/__missing__',
  );
}

function api(overrides: Partial<GatewayApiClient> = {}): GatewayApiClient {
  return {
    heartbeat: jest.fn().mockResolvedValue({ ok: true }),
    pollCommands: jest.fn().mockResolvedValue([]),
    postResult: jest.fn().mockResolvedValue({ ok: true }),
    ingest: jest.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as unknown as GatewayApiClient;
}

function stores() {
  const events = new OfflineBuffer(path.join(dir, 'events.jsonl'));
  const results = new ResultOutbox(path.join(dir, 'results.jsonl'));
  events.load();
  results.load();
  return { events, results };
}

describe('GatewayAgent — durable command result delivery', () => {
  it('reports release identity, capabilities and safe device metadata in V2 heartbeat', async () => {
    const physical = devices();
    physical.value.scannerDeviceId = 'scanner-1';
    const client = api();
    const local = stores();
    const agent = new GatewayAgent(
      config({
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        PRINTER_MODE: 'cups-zpl',
        PRINTER_CUPS_QUEUE: 'TLP4',
        GATEWAY_SCANNER_DEVICE_ID: 'scanner-1',
        SCANNER_HID_PATH: '/dev/input/by-id/scanner-event-kbd',
      }),
      client,
      physical.value,
      local.events,
      local.results,
    );

    await agent.heartbeatOnce();

    expect(client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        agent: expect.objectContaining({
          packageVersion: expect.any(String),
          releaseCommit: expect.stringMatching(/^[0-9a-f]{7,64}$/u),
          bootId: expect.any(String),
          startedAt: expect.any(String),
          capabilities: [...GATEWAY_CAPABILITIES],
        }),
        devices: expect.arrayContaining([
          expect.objectContaining({
            deviceId: 'scale-1',
            kind: 'scale',
            driver: 'massa-k-protocol-100',
            configFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
          }),
          expect.objectContaining({
            deviceId: 'printer-1',
            kind: 'printer',
            driver: 'cups-zpl',
          }),
          expect.objectContaining({
            deviceId: 'scanner-1',
            kind: 'scanner',
            driver: 'hid-keyboard',
          }),
        ]),
      }),
    );
    expect(JSON.stringify((client.heartbeat as jest.Mock).mock.calls)).not.toContain('test-token');
  });

  it('keeps heartbeat running but stops new command polling when the server denies it', async () => {
    const client = api({
      heartbeat: jest.fn().mockResolvedValue({
        accepted: false,
        compatibility: 'unsupported',
        serverProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        minimumProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        pollAllowed: false,
        missingCapabilities: [],
        serverTime: new Date().toISOString(),
      }),
    });
    const local = stores();
    const agent = new GatewayAgent(config(), client, devices().value, local.events, local.results);

    await agent.heartbeatOnce();
    await agent.pollOnce();
    await agent.heartbeatOnce();

    expect(client.heartbeat).toHaveBeenCalledTimes(2);
    expect(client.pollCommands).not.toHaveBeenCalled();
  });

  it('probes a fresh Protocol 100 scale before publishing its first heartbeat', async () => {
    let scaleStatus: 'ready' | 'offline' = 'offline';
    const physical = devices();
    const probe = jest.fn().mockImplementation(async () => {
      scaleStatus = 'ready';
      return {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
      };
    });
    physical.value.scale.probe = probe;
    physical.value.scale.status = () => scaleStatus;
    const client = api();
    const local = stores();
    const agent = new GatewayAgent(
      config({
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        SCALE_SERIAL_BAUD: '57600',
      }),
      client,
      physical.value,
      local.events,
      local.results,
    );

    await agent.start();
    try {
      expect(probe).toHaveBeenCalledTimes(1);
      expect(client.heartbeat).toHaveBeenCalledWith(
        expect.objectContaining({
          devices: [
            expect.objectContaining({ deviceId: 'scale-1', status: 'ready' }),
            expect.objectContaining({ deviceId: 'printer-1', status: 'ready' }),
          ],
        }),
      );
    } finally {
      await agent.stop();
    }
  });

  it('publishes the configured HID scanner in every heartbeat', async () => {
    const physical = devices();
    physical.value.scannerDeviceId = 'scanner-1';
    const client = api();
    const local = stores();
    const agent = new GatewayAgent(
      config({
        GATEWAY_SCANNER_DEVICE_ID: 'scanner-1',
        SCANNER_HID_PATH: '/dev/null',
      }),
      client,
      physical.value,
      local.events,
      local.results,
    );

    await agent.heartbeatOnce();

    expect(client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        devices: [
          expect.objectContaining({ deviceId: 'scale-1', status: 'ready' }),
          expect.objectContaining({ deviceId: 'printer-1', status: 'ready' }),
          expect.objectContaining({ deviceId: 'scanner-1', status: 'ready' }),
        ],
      }),
    );
  });

  it('probes the local CUPS queue before publishing printer readiness', async () => {
    let printerStatus: 'ready' | 'offline' = 'offline';
    const physical = devices();
    const probe = jest.fn().mockImplementation(async () => {
      printerStatus = 'ready';
      return printerStatus;
    });
    Object.assign(physical.value.printer, {
      probe,
      status: () => printerStatus,
    });
    const client = api();
    const local = stores();
    const agent = new GatewayAgent(
      config({ PRINTER_MODE: 'cups-zpl', PRINTER_CUPS_QUEUE: 'TLP4' }),
      client,
      physical.value,
      local.events,
      local.results,
    );

    await agent.heartbeatOnce();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(client.heartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        devices: [
          expect.objectContaining({ deviceId: 'scale-1', status: 'ready' }),
          expect.objectContaining({ deviceId: 'printer-1', status: 'ready' }),
        ],
      }),
    );
  });

  it('reports a failed physical startup probe honestly and retries activation on heartbeat', async () => {
    let scaleStatus: 'ready' | 'offline' = 'offline';
    const physical = devices();
    const probe = jest
      .fn()
      .mockRejectedValueOnce(new Error('physical scale unavailable'))
      .mockImplementationOnce(async () => {
        scaleStatus = 'ready';
        return {
          ok: true,
          status: 'ready',
          protocol: 'massa-k-protocol-100',
          simulated: false,
        };
      });
    physical.value.scale.probe = probe;
    physical.value.scale.status = () => scaleStatus;
    const client = api();
    const local = stores();
    const agent = new GatewayAgent(
      config({
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        SCALE_SERIAL_BAUD: '57600',
      }),
      client,
      physical.value,
      local.events,
      local.results,
    );

    await agent.heartbeatOnce();
    expect(client.heartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        devices: [
          expect.objectContaining({ deviceId: 'scale-1', status: 'offline' }),
          expect.objectContaining({ deviceId: 'printer-1', status: 'ready' }),
        ],
      }),
    );

    await agent.heartbeatOnce();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(client.heartbeat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        devices: [
          expect.objectContaining({ deviceId: 'scale-1', status: 'ready' }),
          expect.objectContaining({ deviceId: 'printer-1', status: 'ready' }),
        ],
      }),
    );
  });

  it('executes hardware once and survives a lost acknowledgement plus process restart', async () => {
    const firstDevices = devices();
    const firstApi = api({
      pollCommands: jest.fn().mockResolvedValue([
        {
          id: 'cmd-1',
          leaseToken: 'lease-1',
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          serverTime: new Date().toISOString(),
          executionBudgetMs: 60_000,
          kind: 'read_scale',
          payload: { deviceId: 'scale-1' },
        },
      ]),
      postResult: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
    });
    const firstStores = stores();
    const first = new GatewayAgent(
      config(),
      firstApi,
      firstDevices.value,
      firstStores.events,
      firstStores.results,
    );

    await first.pollOnce();

    expect(firstDevices.read).toHaveBeenCalledTimes(1);
    expect(firstStores.results.has('cmd-1')).toBe(true);

    const restartedDevices = devices();
    const restartedApi = api();
    const restartedStores = stores();
    const restarted = new GatewayAgent(
      config(),
      restartedApi,
      restartedDevices.value,
      restartedStores.events,
      restartedStores.results,
    );

    await restarted.pollOnce();

    expect(restartedApi.postResult).toHaveBeenCalledWith(
      'cmd-1',
      'lease-1',
      expect.objectContaining({ ok: true, grossKg: 2 }),
    );
    expect(restartedDevices.read).not.toHaveBeenCalled();
    expect(restartedStores.results.pending).toHaveLength(0);
  });

  it('executes a duplicated print command id only once within one poll batch', async () => {
    const local = stores();
    const physical = devices();
    const command = {
      id: 'cmd-duplicate-print',
      leaseToken: 'lease-duplicate',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      serverTime: new Date().toISOString(),
      executionBudgetMs: 60_000,
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
    };
    const client = api({
      pollCommands: jest.fn().mockResolvedValue([command, command]),
    });
    const agent = new GatewayAgent(config(), client, physical.value, local.events, local.results);

    await agent.pollOnce();

    expect(physical.print).toHaveBeenCalledTimes(1);
    expect(client.postResult).toHaveBeenCalledTimes(1);
  });

  it('never invokes physical print after the server execution grant is exhausted', async () => {
    const local = stores();
    const physical = devices();
    const client = api({
      pollCommands: jest.fn().mockResolvedValue([
        {
          id: 'cmd-expired-print',
          leaseToken: 'lease-expired',
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
          serverTime: new Date().toISOString(),
          executionBudgetMs: 0,
          kind: 'print',
          payload: {
            printerId: 'printer-1',
            kind: 'roll_label',
            rollCode: 'ROLL-1',
            qrCode: `prt_${'a'.repeat(64)}`,
          },
        },
      ]),
    });
    const agent = new GatewayAgent(config(), client, physical.value, local.events, local.results);

    await agent.pollOnce();

    expect(physical.print).not.toHaveBeenCalled();
    expect(client.postResult).toHaveBeenCalledWith(
      'cmd-expired-print',
      'lease-expired',
      expect.objectContaining({
        ok: false,
        status: 'failed',
        reasonCode: 'gateway_command_deadline_elapsed_before_invocation',
      }),
    );
  });

  it('fails closed when the local wall clock lags the VPS clock', async () => {
    const local = stores();
    const physical = devices();
    const client = api({
      pollCommands: jest.fn().mockResolvedValue([
        {
          id: 'cmd-server-expired',
          leaseToken: 'lease-server-expired',
          // This looks far in the future to a lagging wall clock; the VPS budget is authoritative.
          deadlineAt: '2099-01-01T00:00:00.000Z',
          serverTime: '2099-01-01T00:00:00.000Z',
          executionBudgetMs: 0,
          kind: 'print',
          payload: {
            printerId: 'printer-1',
            kind: 'roll_label',
            rollCode: 'ROLL-1',
            qrCode: `prt_${'b'.repeat(64)}`,
          },
        },
      ]),
    });
    const agent = new GatewayAgent(config(), client, physical.value, local.events, local.results);

    await agent.pollOnce();

    expect(physical.print).not.toHaveBeenCalled();
  });

  it('charges poll latency and event-loop suspension against the monotonic server budget', async () => {
    const local = stores();
    const physical = devices();
    const monotonic = jest.fn().mockReturnValueOnce(100).mockReturnValue(600);
    const client = api({
      pollCommands: jest.fn().mockResolvedValue([
        {
          id: 'cmd-suspended',
          leaseToken: 'lease-suspended',
          deadlineAt: '2099-01-01T00:00:00.000Z',
          serverTime: new Date().toISOString(),
          executionBudgetMs: 400,
          kind: 'print',
          payload: {
            printerId: 'printer-1',
            kind: 'roll_label',
            rollCode: 'ROLL-2',
            qrCode: `prt_${'c'.repeat(64)}`,
          },
        },
      ]),
    });
    const agent = new GatewayAgent(
      config(),
      client,
      physical.value,
      local.events,
      local.results,
      monotonic,
    );

    await agent.pollOnce();

    expect(physical.print).not.toHaveBeenCalled();
  });

  it('does not enter a physical driver inside the deadline safety margin', async () => {
    const local = stores();
    const physical = devices();
    const client = api({
      pollCommands: jest.fn().mockResolvedValue([
        {
          id: 'cmd-near-deadline',
          leaseToken: 'lease-near-deadline',
          deadlineAt: '2099-01-01T00:00:00.000Z',
          serverTime: new Date().toISOString(),
          executionBudgetMs: 40,
          kind: 'print',
          payload: {
            printerId: 'printer-1',
            kind: 'roll_label',
            rollCode: 'ROLL-3',
            qrCode: `prt_${'d'.repeat(64)}`,
          },
        },
      ]),
    });
    const agent = new GatewayAgent(config(), client, physical.value, local.events, local.results);

    await agent.pollOnce();

    expect(physical.print).not.toHaveBeenCalled();
  });

  it('does not poll for new commands while a saved result cannot be delivered', async () => {
    const local = stores();
    local.results.enqueue('cmd-1', 'lease-1', { ok: true });
    const client = api({ postResult: jest.fn().mockRejectedValue(new Error('offline')) });
    const agent = new GatewayAgent(config(), client, devices().value, local.events, local.results);

    await agent.pollOnce();

    expect(client.pollCommands).not.toHaveBeenCalled();
    expect(local.results.has('cmd-1')).toBe(true);
  });

  it('quarantines a stale lease response and resumes polling', async () => {
    const local = stores();
    local.results.enqueue('cmd-1', 'stale-lease', { ok: true });
    const client = api({
      postResult: jest.fn().mockRejectedValue(new GatewayApiError(409, 'POST', '/result')),
    });
    const agent = new GatewayAgent(config(), client, devices().value, local.events, local.results);

    await agent.pollOnce();

    expect(local.results.pending).toHaveLength(0);
    expect(client.pollCommands).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dir, 'results.jsonl.quarantine'), 'utf8')).toContain('cmd-1');
  });

  it('retains a result across token rotation and resends after credentials recover', async () => {
    const local = stores();
    local.results.enqueue('cmd-token-rotation', 'lease-1', { ok: true });
    const postResult = jest
      .fn()
      .mockRejectedValueOnce(new GatewayApiError(401, 'POST', '/result'))
      .mockResolvedValue({ ok: true });
    const client = api({ postResult });
    const agent = new GatewayAgent(config(), client, devices().value, local.events, local.results);

    await agent.pollOnce();
    expect(local.results.has('cmd-token-rotation')).toBe(true);
    expect(client.pollCommands).not.toHaveBeenCalled();

    await agent.pollOnce();
    expect(local.results.pending).toHaveLength(0);
    expect(postResult).toHaveBeenCalledTimes(2);
    expect(client.pollCommands).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, 'results.jsonl.quarantine'))).toBe(false);
  });

  it('does not echo transport errors or device identifiers into operational logs', async () => {
    let scaleStatus = 'ready';
    const localDevices = devices();
    localDevices.value.scale.status = () => scaleStatus as 'ready' | 'offline';
    const client = api({
      heartbeat: jest
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(
          new Error('token=platform-private /dev/serial/by-id/private-device'),
        ),
    });
    const local = stores();
    const agent = new GatewayAgent(
      config(),
      client,
      localDevices.value,
      local.events,
      local.results,
    );
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await agent.heartbeatOnce();
      scaleStatus = 'offline';
      await agent.heartbeatOnce();
      const output = write.mock.calls.map(([line]) => String(line)).join('');
      expect(output).not.toContain('platform-private');
      expect(output).not.toContain('/dev/serial');
      expect(output).not.toContain('scale-1');
    } finally {
      write.mockRestore();
    }
  });
});
