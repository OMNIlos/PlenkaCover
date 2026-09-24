import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GATEWAY_CAPABILITIES } from '@plenka/contracts';
import {
  gatewayConnectionState,
  gatewayHeartbeatIsFresh,
  gatewayStaleAfterSec,
} from '../gateway-liveness';
import { PrismaService } from '../prisma/prisma.service';
import {
  bindingIncidentFingerprint,
  bindingIncident,
  deviceConnectionFingerprint,
  deviceConnectionIncident,
  postCapabilitiesFingerprint,
  postCapabilitiesIncident,
  postCompatibilityFingerprint,
  postCompatibilityIncident,
  type PhysicalDeviceKind,
  postLivenessFingerprint,
  postLivenessIncident,
} from './device-incident-signals';
import {
  type IncidentReporterAction,
  OperationalIncidentReporter,
} from './operational-incident-reporter.service';

const POST_SELECT = {
  id: true,
} as const;

const POST_SOURCE_SELECT = {
  id: true,
  status: true,
  commissioningState: true,
  agentStatus: true,
  lastSeenAt: true,
  agentProtocolVersion: true,
  agentCompatibility: true,
  agentCapabilities: true,
} as const;

const DEVICE_SELECT = {
  id: true,
  postId: true,
} as const;

const DEVICE_SOURCE_SELECT = {
  id: true,
  kind: true,
  status: true,
  isEnabled: true,
  postId: true,
  lastSeenAt: true,
  post: { select: { status: true } },
} as const;

const PHYSICAL_DEVICE_KINDS = ['scale', 'scanner', 'printer'] as const;

export const GATEWAY_INCIDENT_RECONCILER_ENABLED = Symbol('GATEWAY_INCIDENT_RECONCILER_ENABLED');

interface SourcePost {
  id: string;
  status: string;
  commissioningState: string;
  agentStatus: string;
  lastSeenAt: Date | null;
  agentProtocolVersion: number | null;
  agentCompatibility: string;
  agentCapabilities: unknown;
}

interface SourceDevice {
  id: string;
  kind: string;
  status: string;
  isEnabled: boolean;
  postId: string | null;
  lastSeenAt: Date | null;
}

@Injectable()
export class GatewayIncidentReconciler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayIncidentReconciler.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reporter: OperationalIncidentReporter,
    @Inject(GATEWAY_INCIDENT_RECONCILER_ENABLED) private readonly workerEnabled: boolean,
  ) {}

  onModuleInit(): void {
    if (!this.workerEnabled) return;
    this.timer = setInterval(() => {
      void this.reconcileNow();
    }, this.intervalMs());
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.active;
  }

  /** Deterministic hook for tests and explicit maintenance reconciliation. */
  reconcileNow(now = new Date()): Promise<void> {
    if (this.stopping) return this.active ?? Promise.resolve();
    if (this.active) return this.active;

    const active = this.reconcile(now)
      .catch(() => {
        this.logger.error('Gateway incident reconciliation failed.');
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
      });
    this.active = active;
    return active;
  }

  private intervalMs(): number {
    return Math.max(1_000, Math.min(30_000, Math.floor((gatewayStaleAfterSec() * 1_000) / 2)));
  }

  private async reconcile(now: Date): Promise<void> {
    const [posts, devices] = await Promise.all([
      this.prisma.post.findMany({
        select: POST_SELECT,
      }),
      this.prisma.deviceRuntime.findMany({
        where: { postId: { not: null } },
        select: DEVICE_SELECT,
      }),
    ]);
    const devicesByPost = new Map<string, string[]>();
    for (const device of devices) {
      if (!device.postId) continue;
      const existing = devicesByPost.get(device.postId) ?? [];
      existing.push(device.id);
      devicesByPost.set(device.postId, existing);
    }
    await Promise.all(
      posts.map((post) => this.reconcilePost(post.id, devicesByPost.get(post.id) ?? [], now)),
    );
  }

  /**
   * Reconcile one post from durable source state. The supplied ids are discovery hints only:
   * every decision is made after the incident fingerprint locks have been acquired.
   */
  async reconcilePost(postId: string, discoveredDeviceIds: readonly string[], now = new Date()) {
    const deviceIds = [...new Set(discoveredDeviceIds)].sort();
    const fingerprints = [
      postLivenessFingerprint(postId),
      postCompatibilityFingerprint(postId),
      postCapabilitiesFingerprint(postId),
      ...PHYSICAL_DEVICE_KINDS.map((kind) => bindingIncidentFingerprint(postId, kind)),
      ...deviceIds.map(deviceConnectionFingerprint),
    ].sort();

    await this.reporter.reconcileFingerprints(fingerprints, async (tx) => {
      const [post, devices] = await Promise.all([
        tx.post.findUnique({
          where: { id: postId },
          select: POST_SOURCE_SELECT,
        }),
        tx.deviceRuntime.findMany({
          where: {
            OR: [{ postId }, ...(deviceIds.length > 0 ? [{ id: { in: deviceIds } }] : [])],
          },
          select: DEVICE_SOURCE_SELECT,
        }),
      ]);
      const devicesById = new Map(devices.map((device) => [device.id, device]));
      const currentDevices = devices.filter((device) => device.postId === postId);
      const postConnectionState =
        post?.lastSeenAt && post.status === 'active'
          ? gatewayConnectionState(post.agentStatus, post.lastSeenAt, now)
          : null;
      const actions = new Map<string, IncidentReporterAction>();

      actions.set(
        postLivenessFingerprint(postId),
        this.postAction(postId, post, postConnectionState),
      );
      actions.set(
        postCompatibilityFingerprint(postId),
        this.compatibilityAction(postId, post),
      );
      actions.set(postCapabilitiesFingerprint(postId), this.capabilitiesAction(postId, post));
      for (const kind of PHYSICAL_DEVICE_KINDS) {
        const fingerprint = bindingIncidentFingerprint(postId, kind);
        actions.set(fingerprint, this.bindingAction(postId, kind, post, currentDevices));
      }
      for (const deviceId of deviceIds) {
        const fingerprint = deviceConnectionFingerprint(deviceId);
        actions.set(
          fingerprint,
          this.deviceAction(deviceId, devicesById.get(deviceId), post, postConnectionState, now),
        );
      }
      return fingerprints.map((fingerprint) => actions.get(fingerprint)!);
    });
  }

  private postAction(
    postId: string,
    post: SourcePost | null,
    connectionState: ReturnType<typeof gatewayConnectionState> | null,
  ) {
    const fingerprint = postLivenessFingerprint(postId);
    if (!post || post.status !== 'active') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Inactive post no longer owns an outage.',
      };
    }
    if (!connectionState) return { kind: 'noop' as const, fingerprint };
    if (connectionState === 'online') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Gateway heartbeat restored.',
      };
    }
    return { kind: 'signal' as const, signal: postLivenessIncident(postId) };
  }

  private bindingAction(
    postId: string,
    kind: PhysicalDeviceKind,
    post: SourcePost | null,
    devices: readonly SourceDevice[],
  ) {
    const fingerprint = bindingIncidentFingerprint(postId, kind);
    if (!post || post.status !== 'active') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Inactive post no longer owns a device binding incident.',
      };
    }
    const enabled = devices.filter((device) => device.kind === kind && device.isEnabled);
    if (enabled.length !== 1) {
      return { kind: 'signal' as const, signal: bindingIncident(postId, kind) };
    }
    return {
      kind: 'resolve' as const,
      fingerprint,
      reason: 'Post has one enabled device binding.',
    };
  }

  private compatibilityAction(postId: string, post: SourcePost | null) {
    const fingerprint = postCompatibilityFingerprint(postId);
    if (!post || post.status !== 'active') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Inactive post no longer owns an agent compatibility incident.',
      };
    }
    if (!this.hasAgentEvidence(post)) return { kind: 'noop' as const, fingerprint };
    if (post.agentCompatibility === 'compatible') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Compatible gateway-agent heartbeat received.',
      };
    }
    return { kind: 'signal' as const, signal: postCompatibilityIncident(postId) };
  }

  private capabilitiesAction(postId: string, post: SourcePost | null) {
    const fingerprint = postCapabilitiesFingerprint(postId);
    if (!post || post.status !== 'active') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Inactive post no longer owns an agent capability incident.',
      };
    }
    if (!this.hasAgentEvidence(post)) return { kind: 'noop' as const, fingerprint };
    const capabilities = new Set(
      Array.isArray(post.agentCapabilities)
        ? post.agentCapabilities.filter((value): value is string => typeof value === 'string')
        : [],
    );
    if (GATEWAY_CAPABILITIES.every((capability) => capabilities.has(capability))) {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Gateway-agent capability set restored.',
      };
    }
    return { kind: 'signal' as const, signal: postCapabilitiesIncident(postId) };
  }

  private hasAgentEvidence(post: SourcePost): boolean {
    return (
      post.commissioningState === 'commissioned' ||
      typeof post.agentProtocolVersion === 'number' ||
      post.lastSeenAt instanceof Date
    );
  }

  private deviceAction(
    deviceId: string,
    device: SourceDevice | undefined,
    post: SourcePost | null,
    postConnectionState: ReturnType<typeof gatewayConnectionState> | null,
    now: Date,
  ) {
    const fingerprint = deviceConnectionFingerprint(deviceId);
    if (device && device.postId !== post?.id) {
      return { kind: 'noop' as const, fingerprint };
    }
    if (!device || !post || post.status !== 'active') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Inactive device topology no longer owns an outage.',
      };
    }
    if (postConnectionState && postConnectionState !== 'online') {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Device outage is subsumed by gateway post liveness.',
      };
    }
    if (!device.isEnabled) {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Disabled device no longer owns an outage.',
      };
    }
    if (device.status !== 'ready') {
      return { kind: 'signal' as const, signal: deviceConnectionIncident(device.id, device.kind) };
    }
    if (!device.lastSeenAt) return { kind: 'noop' as const, fingerprint };
    if (gatewayHeartbeatIsFresh(device.lastSeenAt, now)) {
      return {
        kind: 'resolve' as const,
        fingerprint,
        reason: 'Device heartbeat restored.',
      };
    }
    return { kind: 'signal' as const, signal: deviceConnectionIncident(device.id, device.kind) };
  }
}
