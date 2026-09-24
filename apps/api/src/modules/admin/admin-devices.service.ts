import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Role } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { gatewayStaleAfterSec } from '../../common/gateway-liveness';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayService } from '../gateway/gateway.service';
import { calculateConnectionQuality } from './admin-quality';
import type {
  BindAdminDeviceDto,
  CreateAdminDeviceDto,
  UpdateAdminDeviceDto,
} from './dto/admin-device.dto';
import { OperationalChecksService } from './operational-checks.service';
import { OperationalIncidentsService } from '../../common/operational-incidents/operational-incidents.service';

export interface AdminDeviceActor {
  userId: string | null;
  role: Role;
}

const POST_SAFE_SELECT = { id: true, code: true, name: true, status: true } as const;
export const DEVICE_SAFE_SELECT = {
  id: true,
  code: true,
  label: true,
  kind: true,
  connectionKind: true,
  driverName: true,
  driverVersion: true,
  isEnabled: true,
  status: true,
  ownerRole: true,
  lastSeenAt: true,
  lastProbeAt: true,
  lastTestAt: true,
  parsedPayload: true,
  recovery: true,
  postId: true,
  post: { select: POST_SAFE_SELECT },
  createdAt: true,
  updatedAt: true,
} as const;

const PHYSICAL_PARAMETER_KEYS = [
  'maximum',
  'minimum',
  'verificationInterval',
  'maximumTare',
  'fixation',
  'calibrationCode',
  'softwareVersion',
  'softwareChecksum',
] as const;
const PHYSICAL_PARAMETER_BOUNDS = {
  maximum: { min: 2, max: 20 },
  minimum: { min: 2, max: 20 },
  verificationInterval: { min: 2, max: 10 },
  maximumTare: { min: 2, max: 10 },
  fixation: { min: 5, max: 7 },
  calibrationCode: { min: 11, max: 13 },
  softwareVersion: { min: 2, max: 9 },
  softwareChecksum: { min: 2, max: 8 },
} as const;
const UNSAFE_EVIDENCE_TEXT =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|(?:\/dev\/|[A-Za-z]:\\|\\\\|token|password|secret|credential)/iu;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeProtocolText(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== 'string' || UNSAFE_EVIDENCE_TEXT.test(value)) return false;
  const bytes = Buffer.byteLength(value, 'latin1');
  return bytes >= minBytes && bytes <= maxBytes;
}

function projectPhysicalEvidence(value: Record<string, unknown>) {
  const identity = record(value.identity);
  const identityKeys = new Set(['manufacturer', 'scaleId', 'name']);
  const identityValid = Boolean(
    identity &&
    Object.keys(identity).every((key) => identityKeys.has(key)) &&
    identity.manufacturer === 'MASSA-K' &&
    Number.isInteger(identity.scaleId) &&
    (identity.scaleId as number) >= -0x80000000 &&
    (identity.scaleId as number) <= 0x7fffffff &&
    safeProtocolText(identity.name, 0, 25),
  );
  const parameters = record(value.parameters);
  const parameterKeys = new Set<string>(PHYSICAL_PARAMETER_KEYS);
  const parametersSafe = Boolean(
    parameters &&
    Object.keys(parameters).every((key) => parameterKeys.has(key)) &&
    PHYSICAL_PARAMETER_KEYS.every(
      (key) =>
        !Object.prototype.hasOwnProperty.call(parameters, key) ||
        safeProtocolText(
          parameters[key],
          PHYSICAL_PARAMETER_BOUNDS[key].min,
          PHYSICAL_PARAMETER_BOUNDS[key].max,
        ),
    ),
  );
  const parametersComplete = Boolean(
    parametersSafe &&
    parameters &&
    PHYSICAL_PARAMETER_KEYS.every((key) => Object.prototype.hasOwnProperty.call(parameters, key)),
  );
  return {
    valid: identityValid && parametersComplete,
    identity: identityValid
      ? {
          manufacturer: identity!.manufacturer as string,
          scaleId: identity!.scaleId as number,
          name: identity!.name as string,
        }
      : undefined,
    parameters:
      parametersSafe && parameters
        ? Object.fromEntries(
            PHYSICAL_PARAMETER_KEYS.filter((key) => key in parameters).map((key) => [
              key,
              parameters[key] as string,
            ]),
          )
        : undefined,
  };
}

@Injectable()
export class AdminDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly gateway: GatewayService,
    private readonly checks: OperationalChecksService,
    private readonly incidents: OperationalIncidentsService,
  ) {}

  list() {
    return this.prisma.deviceRuntime.findMany({
      select: DEVICE_SAFE_SELECT,
      orderBy: [{ postId: 'asc' }, { kind: 'asc' }, { code: 'asc' }],
    });
  }

  async get(deviceId: string) {
    const device = await this.prisma.deviceRuntime.findUnique({
      where: { id: deviceId },
      select: DEVICE_SAFE_SELECT,
    });
    if (!device) throw new NotFoundException(`Device ${deviceId} not found`);
    return device;
  }

  async create(actor: AdminDeviceActor, dto: CreateAdminDeviceDto) {
    if (dto.postId) await this.requirePost(dto.postId);
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.deviceRuntime.create({
        data: {
          code: dto.code.trim(),
          label: dto.label.trim(),
          kind: dto.kind,
          connectionKind: dto.connectionKind?.trim(),
          isEnabled: dto.isEnabled ?? true,
          status: 'offline',
          ownerRole: 'admin',
          postId: dto.postId,
        },
        select: DEVICE_SAFE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.device.created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: created.id,
          newValue: { code: created.code, kind: created.kind, postId: created.postId },
          reason: 'device provisioning',
        },
        tx,
      );
      return created;
    });
  }

  async update(actor: AdminDeviceActor, deviceId: string, dto: UpdateAdminDeviceDto) {
    const current = await this.get(deviceId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.deviceRuntime.update({
        where: { id: deviceId },
        data: {
          ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
          ...(dto.connectionKind !== undefined
            ? { connectionKind: dto.connectionKind.trim() }
            : {}),
          ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
        },
        select: DEVICE_SAFE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.device.updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: deviceId,
          oldValue: this.configurationSnapshot(current),
          newValue: this.configurationSnapshot(updated),
          reason: dto.reason,
        },
        tx,
      );
      return updated;
    });
  }

  async bind(actor: AdminDeviceActor, deviceId: string, dto: BindAdminDeviceDto) {
    const [device, post] = await Promise.all([this.get(deviceId), this.requirePost(dto.postId)]);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.deviceRuntime.update({
        where: { id: deviceId },
        data: { postId: dto.postId },
        select: DEVICE_SAFE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.device.bound',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: deviceId,
          oldValue: { postId: device.postId },
          newValue: { postId: post.id },
          reason: dto.reason,
        },
        tx,
      );
      return updated;
    });
  }

  async test(actor: AdminDeviceActor, deviceId: string) {
    const device = await this.requireCommandableDevice(deviceId);
    const result = await this.runTest(actor, device);
    await this.audit.record({
      type: 'admin.device.test_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: deviceId,
      detail: { kind: device.kind, postId: device.postId, status: result.status },
    });
    return result;
  }

  async recover(actor: AdminDeviceActor, deviceId: string, reason: string) {
    const device = await this.requireCommandableDevice(deviceId);
    await this.audit.record({
      type: 'admin.device.recovery_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: deviceId,
      reason,
      detail: { kind: device.kind, postId: device.postId },
    });
    await this.gateway.dispatchCommand(device.postId!, 'device_recover', {
      deviceId,
      kind: device.kind,
    });
    return this.runTest(actor, device, reason);
  }

  async quality(deviceId: string) {
    const device = await this.get(deviceId);
    const [checks, incidents] = await Promise.all([
      this.prisma.operationalCheck.findMany({
        where: { scope: 'device', targetId: deviceId },
        select: { status: true, latencyMs: true, completedAt: true },
        orderBy: { completedAt: 'desc' },
        take: 100,
      }),
      this.prisma.operationalIncident.findMany({
        where: { scope: 'device', targetId: deviceId, status: { not: 'resolved' } },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);
    return {
      device,
      quality: calculateConnectionQuality({
        lastSeenAt: device.lastSeenAt,
        thresholdSec: gatewayStaleAfterSec(),
        checks,
        openIncidentCount: incidents.length,
      }),
      checks,
      incidents,
    };
  }

  private async runTest(
    actor: AdminDeviceActor,
    device: Awaited<ReturnType<AdminDevicesService['get']>>,
    recovery?: string,
  ) {
    const startedAt = new Date();
    let gatewayResult: Record<string, unknown>;
    try {
      gatewayResult = await this.gateway.dispatchCommand(device.postId!, 'device_test', {
        deviceId: device.id,
        kind: device.kind,
      });
    } catch {
      gatewayResult = {
        ok: false,
        deviceId: device.id,
        status: 'offline',
        message: 'Gateway command timed out.',
      };
    }
    const connectivityReady = gatewayResult.ok === true && gatewayResult.status === 'ready';
    const evidenceKind = [
      'physical',
      'physical_pending',
      'simulated',
      'legacy',
      'unverified',
    ].includes(String(gatewayResult.evidenceKind))
      ? String(gatewayResult.evidenceKind)
      : 'unverified';
    const physicalEvidence = projectPhysicalEvidence(gatewayResult);
    const physicalPass =
      device.kind === 'scale' &&
      gatewayResult.physicalPass === true &&
      gatewayResult.protocol === 'massa-k-protocol-100' &&
      gatewayResult.simulated === false &&
      gatewayResult.stable === true &&
      evidenceKind === 'physical' &&
      physicalEvidence.valid;
    const confirmationRequired = gatewayResult.confirmationRequired === true;
    const physicalVerificationPending =
      connectivityReady &&
      !physicalPass &&
      (evidenceKind === 'physical' || evidenceKind === 'physical_pending' || confirmationRequired);
    const passed = connectivityReady && !physicalVerificationPending;
    const reportedStatus = passed ? 'ready' : String(gatewayResult.status ?? 'test_failed');
    const normalizedReportedStatus = [
      'ready',
      'offline',
      'unstable',
      'misconfigured',
      'test_failed',
    ].includes(reportedStatus)
      ? reportedStatus
      : 'test_failed';
    const normalizedStatus = physicalVerificationPending ? 'unstable' : normalizedReportedStatus;
    const completedAt = new Date();
    const safeResult = {
      ok: passed,
      connectivityReady,
      deviceId: device.id,
      status: normalizedStatus,
      evidenceKind,
      physicalPass,
      confirmationRequired,
      protocol: ['massa-k-protocol-100', 'simulated', 'legacy-ascii'].includes(
        String(gatewayResult.protocol),
      )
        ? String(gatewayResult.protocol)
        : undefined,
      simulated: typeof gatewayResult.simulated === 'boolean' ? gatewayResult.simulated : undefined,
      identity: physicalEvidence.identity,
      parameters: physicalEvidence.parameters,
      message: physicalVerificationPending
        ? confirmationRequired
          ? 'Device is reachable; physical confirmation is pending.'
          : 'Device is reachable; physical verification evidence is incomplete.'
        : passed
          ? physicalPass
            ? 'Physical Protocol 100 evidence validated.'
            : 'Device responded.'
          : `Device test failed (${normalizedStatus}).`,
      measuredAt:
        typeof gatewayResult.measuredAt === 'string' &&
        Number.isFinite(Date.parse(gatewayResult.measuredAt))
          ? new Date(gatewayResult.measuredAt).toISOString()
          : completedAt.toISOString(),
    };
    await this.checks.record({
      scope: 'device',
      targetType: device.kind,
      targetId: device.id,
      status: physicalVerificationPending ? 'degraded' : passed ? 'passed' : 'failed',
      summary: safeResult,
      actorId: actor.userId,
      startedAt,
      completedAt,
    });
    const updated = await this.prisma.deviceRuntime.update({
      where: { id: device.id },
      data: {
        status: normalizedStatus,
        lastTestAt: completedAt,
        parsedPayload: safeResult as Prisma.InputJsonValue,
        ...(recovery ? { recovery } : {}),
      },
      select: DEVICE_SAFE_SELECT,
    });
    if (passed) {
      await this.incidents.resolveByFingerprint(
        actor,
        `device:${device.id}:connection`,
        'Device verification passed.',
      );
    } else if (!connectivityReady) {
      await this.incidents.signal({
        fingerprint: `device:${device.id}:connection`,
        scope: 'device',
        targetType: device.kind,
        targetId: device.id,
        severity: 'warning',
        title: `${device.label ?? device.code ?? device.id}: нет связи`,
        message: safeResult.message,
        recovery: 'Проверить питание, кабель и локальный gateway, затем запустить recovery.',
      });
    }
    return updated;
  }

  private async requireCommandableDevice(deviceId: string) {
    const device = await this.prisma.deviceRuntime.findUnique({
      where: { id: deviceId },
      select: DEVICE_SAFE_SELECT,
    });
    if (!device) throw new NotFoundException(`Device ${deviceId} not found`);
    if (!device.isEnabled) {
      throw new ConflictException({
        code: 'ADMIN_DEVICE_DISABLED',
        message: 'Device is disabled.',
      });
    }
    if (!device.postId || !device.post) {
      throw new ConflictException({
        code: 'ADMIN_DEVICE_UNBOUND',
        message: 'Device is not bound to a post.',
      });
    }
    if (device.post.status !== 'active') {
      throw new ConflictException({ code: 'ADMIN_POST_DISABLED', message: 'Post is not active.' });
    }
    return device;
  }

  private async requirePost(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: POST_SAFE_SELECT,
    });
    if (!post) throw new NotFoundException(`Post ${postId} not found`);
    return post;
  }

  private configurationSnapshot(device: {
    code: string | null;
    label: string | null;
    connectionKind: string | null;
    isEnabled: boolean;
    postId: string | null;
  }) {
    return {
      code: device.code,
      label: device.label,
      connectionKind: device.connectionKind,
      isEnabled: device.isEnabled,
      postId: device.postId,
    };
  }
}
