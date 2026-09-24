import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayCapability,
  type GatewayHeartbeatDeviceV2,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';
import { GatewayApiError, type GatewayApiClient } from './api-client';
import { handleCommand, type AgentDevices } from './commands';
import type { AgentConfig } from './config';
import { log } from './logger';
import type { OfflineBuffer } from './offline-buffer';
import { configFingerprint, loadReleaseInfo, type GatewayAgentReleaseInfo } from './release-info';
import type { ResultOutbox } from './result-outbox';

/**
 * Post agent runtime: heartbeat + command polling + offline-buffer flush. Everything is
 * outbound to the platform; the loops tolerate a dead backend (state-transition logging,
 * buffered ingest) and a dead device (commands answer `ok:false`, never crash).
 */
export class GatewayAgent {
  private static readonly EXECUTION_SAFETY_MARGIN_MS = 50;
  private timers: NodeJS.Timeout[] = [];
  private polling = false;
  private heartbeating = false;
  private apiReachable: boolean | null = null;
  private pollAllowed: boolean;
  private readonly lastDeviceStatus = new Map<string, string>();

  constructor(
    private readonly cfg: AgentConfig,
    private readonly api: GatewayApiClient,
    private readonly devices: AgentDevices,
    private readonly buffer: OfflineBuffer,
    private readonly results: ResultOutbox,
    private readonly monotonicNow: () => number = () => performance.now(),
    private readonly releaseInfo: GatewayAgentReleaseInfo = loadReleaseInfo({
      deploymentMode: cfg.deploymentMode,
    }),
  ) {
    // A physical post must receive an explicit compatibility grant before touching hardware.
    this.pollAllowed = cfg.deploymentMode === 'development';
  }

  async start(): Promise<void> {
    await this.heartbeatOnce();
    this.timers = [
      setInterval(() => void this.heartbeatOnce(), this.cfg.heartbeatIntervalMs),
      setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs),
    ];
    log.info('gateway agent started', {
      post: this.cfg.postCode,
      apiUrl: this.cfg.apiUrl,
      scaleMode: this.cfg.scaleMode,
      printerMode: this.cfg.printerMode,
      pollIntervalMs: this.cfg.pollIntervalMs,
      heartbeatIntervalMs: this.cfg.heartbeatIntervalMs,
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      packageVersion: this.releaseInfo.packageVersion,
      releaseCommit: this.releaseInfo.releaseCommit,
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.devices.scale.close();
    log.info('gateway agent stopped', { post: this.cfg.postCode });
  }

  async heartbeatOnce(): Promise<void> {
    if (this.heartbeating) return;
    this.heartbeating = true;
    try {
      await this.activatePhysicalScale();
      await this.refreshPhysicalPrinter();
      const devices = this.heartbeatDevices();
      this.enqueueStatusChanges(devices);
      try {
        const acknowledgement = await this.api.heartbeat(this.heartbeatBody(devices));
        this.pollAllowed = acknowledgement.pollAllowed === true;
        this.markReachable(true);
      } catch (err) {
        this.markReachable(false, err);
      }
      await this.buffer.flush((e) =>
        this.api
          .ingest({
            eventId: e.eventId,
            kind: e.kind,
            payload: e.payload,
            rawPayload: e.rawPayload,
          })
          .then(() => undefined),
      );
    } finally {
      this.heartbeating = false;
    }
  }

  private async activatePhysicalScale(): Promise<void> {
    if (this.cfg.scaleMode !== 'massa-k-protocol-100' || this.devices.scale.status() === 'ready') {
      return;
    }
    try {
      await this.devices.scale.probe();
    } catch {
      // Heartbeat publishes the driver's unchanged non-ready status; the next heartbeat retries.
    }
  }

  private async refreshPhysicalPrinter(): Promise<void> {
    if (this.cfg.printerMode !== 'cups-zpl' || !this.devices.printer.probe) return;
    try {
      await this.devices.printer.probe();
    } catch {
      // Heartbeat publishes the driver's unchanged non-ready status; the next heartbeat retries.
    }
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return; // a slow device read must not stack overlapping polls
    this.polling = true;
    try {
      const delivery = await this.flushResults();
      if (delivery.remaining > 0) return;
      if (!this.pollAllowed) return;

      let commands;
      const pollStartedAt = this.monotonicNow();
      try {
        commands = await this.api.pollCommands();
        this.markReachable(true);
      } catch (err) {
        this.markReachable(false, err);
        return;
      }
      const seenInBatch = new Set<string>();
      for (const cmd of commands) {
        // A saved result always wins over a repeated delivery. In normal operation it was
        // flushed above; this guard also protects against malformed duplicate poll batches.
        if (seenInBatch.has(cmd.id) || this.results.has(cmd.id)) continue;
        seenInBatch.add(cmd.id);
        const { result, events } = !this.hasExecutionGrant(cmd, pollStartedAt)
          ? {
              result: {
                ok: false,
                status: 'failed',
                reasonCode: 'gateway_command_deadline_elapsed_before_invocation',
              },
              events: [],
            }
          : await handleCommand(cmd, this.devices);
        for (const e of events) this.buffer.enqueue(e);
        this.results.enqueue(cmd.id, cmd.leaseToken, result);
        const afterExecution = await this.flushResults();
        log.info('command handled', { commandId: cmd.id, kind: cmd.kind, ok: result.ok !== false });
        if (afterExecution.remaining > 0) return;
      }
    } finally {
      this.polling = false;
    }
  }

  private hasExecutionGrant(
    command: {
      deadlineAt: string;
      serverTime: string;
      executionBudgetMs: number;
    },
    pollStartedAt: number,
  ): boolean {
    if (
      !Number.isFinite(Date.parse(command.deadlineAt)) ||
      !Number.isFinite(Date.parse(command.serverTime)) ||
      !Number.isFinite(command.executionBudgetMs) ||
      command.executionBudgetMs < 0
    ) {
      return false;
    }
    const elapsed = Math.max(0, this.monotonicNow() - pollStartedAt);
    return command.executionBudgetMs - elapsed > GatewayAgent.EXECUTION_SAFETY_MARGIN_MS;
  }

  private flushResults(): Promise<{ sent: number; quarantined: number; remaining: number }> {
    return this.results.flush(async (pending) => {
      try {
        await this.api.postResult(pending.commandId, pending.leaseToken, pending.result);
        this.markReachable(true);
        return 'ack';
      } catch (error) {
        if (error instanceof GatewayApiError && error.terminalResultRejection) {
          log.warn('command result rejected permanently; quarantined for diagnostics', {
            commandId: pending.commandId,
            httpStatus: error.status,
          });
          return 'quarantine';
        }
        this.markReachable(false, error);
        throw error;
      }
    });
  }

  /** Device status transitions become buffered `status` ingest events (survive outages). */
  private heartbeatBody(devices: GatewayHeartbeatDeviceV2[]): GatewayHeartbeatV2 {
    return {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      agent: {
        ...this.releaseInfo,
        capabilities: this.capabilities(),
      },
      devices,
    };
  }

  private heartbeatDevices(): GatewayHeartbeatDeviceV2[] {
    const lastProbeAt = new Date().toISOString();
    const driverVersion = this.releaseInfo.releaseCommit;
    const devices: GatewayHeartbeatDeviceV2[] = [
      {
        deviceId: this.cfg.scaleDeviceId,
        kind: 'scale',
        status: this.devices.scale.status(),
        driver: this.cfg.scaleMode,
        driverVersion,
        configFingerprint: configFingerprint({
          mode: this.cfg.scaleMode,
          serialPort: this.cfg.scaleSerialPort,
          baud: this.cfg.scaleSerialBaud,
          parity: this.cfg.scaleSerialParity,
        }),
        lastProbeAt,
      },
      {
        deviceId: this.cfg.printerDeviceId,
        kind: 'printer',
        status: this.devices.printer.status(),
        driver: this.cfg.printerMode,
        driverVersion,
        configFingerprint: configFingerprint({
          mode: this.cfg.printerMode,
          host: this.cfg.printerTcpHost,
          port: this.cfg.printerTcpPort,
          queue: this.cfg.printerCupsQueue,
          warehouseQueue: this.cfg.printerWarehouseCupsQueue,
          dpi: this.cfg.printerDpi,
          maxWidthDots: this.cfg.printerMaxWidthDots,
        }),
        lastProbeAt,
      },
    ];
    if (this.devices.scannerDeviceId) {
      devices.push({
        deviceId: this.devices.scannerDeviceId,
        kind: 'scanner',
        status: this.devices.scanner.status(),
        driver: 'hid-keyboard',
        driverVersion,
        configFingerprint: configFingerprint({ hidPath: this.cfg.scannerHidPath }),
        lastProbeAt,
      });
    }
    return devices;
  }

  private capabilities(): GatewayCapability[] {
    const supported = new Set<GatewayCapability>([
      'scale.read.v1',
      'printer.roll-label.v1',
      'printer.big-bag-label.v1',
      'printer.pallet-label.v1',
      'device.test.v1',
      'device.recover.v1',
    ]);
    if (this.cfg.scaleMode === 'massa-k-protocol-100') {
      supported.add('scale.massa-k.protocol-100.v1');
    }
    if (this.devices.scannerDeviceId) {
      supported.add('scanner.hid-keyboard.v1');
    }
    return GATEWAY_CAPABILITIES.filter((capability) => supported.has(capability));
  }

  private enqueueStatusChanges(devices: GatewayHeartbeatDeviceV2[]): void {
    for (const d of devices) {
      const previous = this.lastDeviceStatus.get(d.deviceId);
      if (previous !== undefined && previous !== d.status) {
        this.buffer.enqueue({
          kind: 'status',
          payload: { deviceId: d.deviceId, status: d.status, previous },
        });
        log.info('device status changed', { from: previous, to: d.status });
      }
      this.lastDeviceStatus.set(d.deviceId, d.status);
    }
  }

  /** Log backend reachability on TRANSITIONS only — a 1s poll loop must not spam logs. */
  private markReachable(reachable: boolean, err?: unknown): void {
    if (this.apiReachable === reachable) return;
    this.apiReachable = reachable;
    if (reachable) log.info('platform reachable', { apiUrl: this.cfg.apiUrl });
    else {
      log.warn('platform unreachable — buffering ingest events', {
        category: err instanceof GatewayApiError ? 'gateway_http_error' : 'gateway_network_error',
        ...(err instanceof GatewayApiError ? { httpStatus: err.status } : {}),
      });
    }
  }
}
