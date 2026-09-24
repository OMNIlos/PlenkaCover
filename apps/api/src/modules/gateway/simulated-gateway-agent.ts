import { createHash, randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  GATEWAY_CAPABILITIES,
  GATEWAY_PROTOCOL_VERSION,
  isPrinterPayload,
  type GatewayDeviceKind,
  type GatewayDeviceStatus,
  type GatewayHeartbeatV2,
} from '@plenka/contracts';
import { GatewayService, type GatewayCommandKind } from './gateway.service';

export type SimulatedHeartbeatDevice = {
  deviceId: string;
  kind: GatewayDeviceKind;
  status?: GatewayDeviceStatus;
};

/**
 * In-process agent that speaks the same gateway contract as a real on-post agent, so the full
 * operator cycle runs end-to-end WITHOUT hardware (V2 S4). It registers as a synchronous
 * responder: read_scale → a stable weight (or offline for a flagged device), print → ok. A real
 * `Gateway*Adapter` swaps in later via the same contract — no call-site changes (inv. №4).
 */
@Injectable()
export class SimulatedGatewayAgent implements OnModuleDestroy {
  private readonly logger = new Logger(SimulatedGatewayAgent.name);
  private readonly bootId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly offlineDevices = new Set<string>();
  private readonly attachedPosts = new Set<string>();
  private readonly heartbeatDevices = new Map<string, readonly SimulatedHeartbeatDevice[]>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly activeHeartbeats = new Map<string, Promise<void>>();
  private readonly attachmentGenerations = new Map<string, number>();
  private stopping = false;

  constructor(private readonly gateway: GatewayService) {}

  /** Flag a device as offline to exercise the "no manual weight, 503" path (inv. №6). */
  async setOffline(deviceId: string, offline = true): Promise<void> {
    if (offline) this.offlineDevices.add(deviceId);
    else this.offlineDevices.delete(deviceId);
    if (this.stopping) return;
    await Promise.all(
      [...this.heartbeatDevices.entries()]
        .filter(([, devices]) => devices.some((device) => device.deviceId === deviceId))
        .map(([postId, devices]) =>
          this.enqueueHeartbeat(postId, this.simulatedHeartbeatDevices(devices), false),
        ),
    );
  }

  async attach(
    postId: string,
    devices: readonly SimulatedHeartbeatDevice[] = [],
    heartbeatIntervalMs?: number,
  ): Promise<void> {
    if (this.stopping) return;
    const attachmentGeneration = this.nextAttachmentGeneration(postId);
    this.gateway.registerResponder(postId, (kind, payload) => this.handle(kind, payload));
    this.attachedPosts.add(postId);
    if (heartbeatIntervalMs === undefined) return;

    this.clearHeartbeatTimer(postId);
    this.heartbeatDevices.set(postId, devices);
    await this.enqueueHeartbeat(postId, this.simulatedHeartbeatDevices(devices), false);
    if (this.stopping || this.attachmentGenerations.get(postId) !== attachmentGeneration) {
      return;
    }
    const timer = setInterval(() => {
      this.scheduleHeartbeat(postId, devices, attachmentGeneration);
    }, heartbeatIntervalMs);
    timer.unref();
    this.heartbeatTimers.set(postId, timer);
  }

  detach(postId: string): void {
    this.nextAttachmentGeneration(postId);
    this.clearHeartbeatTimer(postId);
    this.heartbeatDevices.delete(postId);
    this.attachedPosts.delete(postId);
    this.gateway.unregisterResponder(postId);
  }

  sendHeartbeat(postId: string, devices: readonly SimulatedHeartbeatDevice[]) {
    const probedAt = new Date().toISOString();
    const heartbeat: GatewayHeartbeatV2 = {
      protocolVersion: GATEWAY_PROTOCOL_VERSION,
      agent: {
        packageVersion: '2.0.0-simulated',
        releaseCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        bootId: this.bootId,
        startedAt: this.startedAt,
        capabilities: GATEWAY_CAPABILITIES,
      },
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        kind: device.kind,
        status: device.status ?? 'ready',
        driver: `simulated.${device.kind}`,
        driverVersion: '2.0.0',
        configFingerprint: simulatedConfigFingerprint(device),
        lastProbeAt: probedAt,
      })),
    };
    return this.gateway.heartbeat(postId, heartbeat);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const postId of [...this.attachedPosts]) this.detach(postId);
    for (const postId of [...this.heartbeatTimers.keys()]) this.clearHeartbeatTimer(postId);
    await Promise.all(this.activeHeartbeats.values());
  }

  private scheduleHeartbeat(
    postId: string,
    devices: readonly SimulatedHeartbeatDevice[],
    attachmentGeneration: number,
  ): void {
    if (
      this.stopping ||
      this.attachmentGenerations.get(postId) !== attachmentGeneration ||
      this.activeHeartbeats.has(postId)
    ) {
      return;
    }
    void this.enqueueHeartbeat(postId, this.simulatedHeartbeatDevices(devices), true);
  }

  private simulatedHeartbeatDevices(
    devices: readonly SimulatedHeartbeatDevice[],
  ): SimulatedHeartbeatDevice[] {
    return devices.map((device) =>
      this.offlineDevices.has(device.deviceId) ? { ...device, status: 'offline' } : device,
    );
  }

  private enqueueHeartbeat(
    postId: string,
    devices: readonly SimulatedHeartbeatDevice[],
    logFailure: boolean,
  ): Promise<void> {
    const previous = this.activeHeartbeats.get(postId) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(() => this.sendHeartbeat(postId, devices))
      .then(() => undefined);
    const handled = logFailure
      ? pending.catch(() => {
          this.logger.warn(`Simulated gateway heartbeat failed for post ${postId}.`);
        })
      : pending;
    const active = handled.finally(() => {
      if (this.activeHeartbeats.get(postId) === active) {
        this.activeHeartbeats.delete(postId);
      }
    });
    this.activeHeartbeats.set(postId, active);
    return active;
  }

  private clearHeartbeatTimer(postId: string): void {
    const timer = this.heartbeatTimers.get(postId);
    if (!timer) return;
    clearInterval(timer);
    this.heartbeatTimers.delete(postId);
  }

  private nextAttachmentGeneration(postId: string): number {
    const generation = (this.attachmentGenerations.get(postId) ?? 0) + 1;
    this.attachmentGenerations.set(postId, generation);
    return generation;
  }

  private async handle(
    kind: GatewayCommandKind,
    payload: unknown,
  ): Promise<Record<string, unknown>> {
    const p = isRecord(payload) ? payload : {};
    const deviceId = typeof p.deviceId === 'string' ? p.deviceId : undefined;
    if (kind === 'read_scale') {
      if (!deviceId) {
        return { ok: false, status: 'misconfigured', error: 'deviceId required' };
      }
      if (deviceId && this.offlineDevices.has(deviceId)) {
        return { ok: true, deviceId, status: 'offline', stable: false, grossKg: 0 };
      }
      return {
        ok: true,
        deviceId,
        status: 'ready',
        stable: true,
        grossKg: p.kind === 'spool' ? 2.0 : 43.4,
      };
    }
    if (kind === 'print') {
      const printerId = typeof p.printerId === 'string' ? p.printerId : undefined;
      if (!printerId) {
        return { ok: false, status: 'failed', error: 'printerId required' };
      }
      if (this.offlineDevices.has(printerId)) {
        return { ok: false, status: 'failed', error: 'printer offline' };
      }
      const printerPayload = { ...p };
      delete printerPayload.printerId;
      if (!isPrinterPayload(printerPayload)) {
        return { ok: false, status: 'failed', error: 'invalid printer payload' };
      }
      return { ok: true, jobId: `sim-${randomJobId()}`, status: 'printed' };
    }
    if (kind === 'device_test') {
      if (!deviceId) return { ok: false, status: 'misconfigured', error: 'deviceId required' };
      const offline = this.offlineDevices.has(deviceId);
      return {
        ok: !offline,
        deviceId,
        status: offline ? 'offline' : 'ready',
        evidenceKind: 'simulated',
        physicalPass: false,
        message: offline ? 'Simulated device is offline.' : 'Simulated device responded.',
        measuredAt: new Date().toISOString(),
      };
    }
    if (kind === 'device_recover') {
      if (!deviceId) return { ok: false, status: 'misconfigured', error: 'deviceId required' };
      this.offlineDevices.delete(deviceId);
      return {
        ok: true,
        deviceId,
        status: 'recovering',
        message: 'Simulated recovery applied; verification required.',
        measuredAt: new Date().toISOString(),
      };
    }
    return { ok: false, error: `unknown command ${String(kind)}` };
  }
}

export function simulatedHeartbeatIntervalMs(staleAfterSec: number): number {
  return Math.max(100, Math.min(30_000, Math.floor((staleAfterSec * 1_000) / 3)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function randomJobId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function simulatedConfigFingerprint(device: SimulatedHeartbeatDevice): string {
  return createHash('sha256').update(`simulated:${device.kind}:${device.deviceId}`).digest('hex');
}
