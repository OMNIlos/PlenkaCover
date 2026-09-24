import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GATEWAY_CAPABILITIES,
  createCanonicalPilotAgentToken,
  isGatewayCapability,
} from '@plenka/contracts';
import { Prisma, type Role } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import {
  gatewayConnectionState,
  gatewayHeartbeatIsFresh,
  gatewayStaleAfterSec,
} from '../../common/gateway-liveness';
import { PrismaService } from '../../common/prisma/prisma.service';
import { calculateConnectionQuality } from './admin-quality';
import { DEVICE_SAFE_SELECT } from './admin-devices.service';
import type { CreateAdminPostDto, UpdateAdminPostDto } from './dto/admin-post.dto';

export interface AdminPostActor {
  userId: string | null;
  role: Role;
}

export const POST_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  status: true,
  commissioningState: true,
  commissionedAt: true,
  agentStatus: true,
  lastSeenAt: true,
  agentProtocolVersion: true,
  agentPackageVersion: true,
  agentReleaseCommit: true,
  agentCapabilities: true,
  agentCompatibility: true,
  createdAt: true,
  updatedAt: true,
  devices: { select: DEVICE_SAFE_SELECT },
} as const;

@Injectable()
export class AdminPostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const posts = await this.prisma.post.findMany({
      select: POST_SAFE_SELECT,
      orderBy: { code: 'asc' },
    });
    return posts.map((post) => this.project(post));
  }

  async get(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: POST_SAFE_SELECT,
    });
    if (!post) throw new NotFoundException(`Post ${postId} not found`);
    return this.project(post);
  }

  create(actor: AdminPostActor, dto: CreateAdminPostDto) {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.post.create({
        data: {
          code: dto.code.trim(),
          name: dto.name.trim(),
          status: dto.status ?? 'active',
          commissioningState: 'uncommissioned',
          commissionedAt: null,
          agentStatus: 'unknown',
          agentCompatibility: 'unknown',
          lastSeenAt: null,
        },
        select: POST_SAFE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.post.created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: created.id,
          newValue: { code: created.code, name: created.name, status: created.status },
          reason: 'post provisioning',
        },
        tx,
      );
      return this.project(created);
    });
  }

  async update(actor: AdminPostActor, postId: string, dto: UpdateAdminPostDto) {
    const current = await this.get(postId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.post.update({
        where: { id: postId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
        },
        select: POST_SAFE_SELECT,
      });
      await this.audit.record(
        {
          type: 'admin.post.updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: postId,
          oldValue: { name: current.name, status: current.status },
          newValue: { name: updated.name, status: updated.status },
          reason: dto.reason,
        },
        tx,
      );
      return this.project(updated);
    });
  }

  async rotateToken(actor: AdminPostActor, postId: string, reason: string) {
    await this.get(postId);
    const token = createCanonicalPilotAgentToken(randomBytes(32));
    const agentTokenHash = createHash('sha256').update(token).digest('hex');
    await this.prisma.$transaction(async (tx) => {
      await tx.post.update({ where: { id: postId }, data: { agentTokenHash } });
      await this.audit.record(
        {
          type: 'admin.post.token_rotated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: postId,
          oldValue: { credential: 'revoked' },
          newValue: { credential: 'rotated' },
          reason,
        },
        tx,
      );
    });
    return { postId, token };
  }

  async commission(actor: AdminPostActor, postId: string, reason: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const post = await tx.post.findUnique({
          where: { id: postId },
          select: POST_SAFE_SELECT,
        });
        if (!post) throw new NotFoundException(`Post ${postId} not found`);
        const capabilities = Array.isArray(post.agentCapabilities)
          ? new Set(post.agentCapabilities)
          : new Set<unknown>();
        const capabilityReady = GATEWAY_CAPABILITIES.every((capability) =>
          capabilities.has(capability),
        );
        const topologyReady = ['scale', 'printer', 'scanner'].every((kind) => {
          const devices = post.devices.filter((device) => device.kind === kind && device.isEnabled);
          return (
            devices.length === 1 &&
            devices[0].status === 'ready' &&
            gatewayHeartbeatIsFresh(devices[0].lastSeenAt, now) &&
            gatewayHeartbeatIsFresh(devices[0].lastProbeAt, now)
          );
        });
        if (
          post.status !== 'active' ||
          post.agentCompatibility !== 'compatible' ||
          gatewayConnectionState(post.agentStatus, post.lastSeenAt, now) !== 'online' ||
          !capabilityReady ||
          !topologyReady
        ) {
          throw new ConflictException({
            code: 'POST_COMMISSIONING_EVIDENCE_INCOMPLETE',
            message: 'Пост нельзя ввести в эксплуатацию без свежей совместимой topology.',
          });
        }
        if (post.commissioningState === 'commissioned' && post.commissionedAt) {
          return this.project(post);
        }
        const updated = await tx.post.update({
          where: { id: postId },
          data: { commissioningState: 'commissioned', commissionedAt: now },
          select: POST_SAFE_SELECT,
        });
        await this.audit.record(
          {
            type: 'admin.post.commissioned',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: postId,
            oldValue: { commissioningState: post.commissioningState },
            newValue: {
              commissioningState: 'commissioned',
              agentReleaseCommit: updated.agentReleaseCommit,
            },
            reason,
          },
          tx,
        );
        return this.project(updated);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async quality(postId: string) {
    const post = await this.get(postId);
    const targetIds = [postId, ...post.devices.map((device) => device.id)];
    const [checks, incidents] = await Promise.all([
      this.prisma.operationalCheck.findMany({
        where: { targetId: { in: targetIds } },
        select: { status: true, latencyMs: true, completedAt: true, targetId: true },
        orderBy: { completedAt: 'desc' },
        take: 200,
      }),
      this.prisma.operationalIncident.findMany({
        where: { targetId: { in: targetIds }, status: { not: 'resolved' } },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);
    return {
      post,
      quality: calculateConnectionQuality({
        lastSeenAt: post.lastSeenAt,
        thresholdSec: gatewayStaleAfterSec(),
        checks,
        openIncidentCount: incidents.length,
      }),
      checks,
      incidents,
    };
  }

  private project<
    T extends {
      agentCapabilities: unknown;
      agentStatus: string;
      lastSeenAt: Date | null;
      devices: unknown[];
    },
  >(post: T) {
    const connectionState = gatewayConnectionState(post.agentStatus, post.lastSeenAt);
    const agentCapabilities = Array.isArray(post.agentCapabilities)
      ? post.agentCapabilities.filter(isGatewayCapability)
      : [];
    const missingCapabilities = GATEWAY_CAPABILITIES.filter(
      (capability) => !agentCapabilities.includes(capability),
    );
    return {
      ...post,
      agentCapabilities,
      connectionState,
      online: connectionState === 'online',
      deviceCount: post.devices.length,
      capabilityReady: missingCapabilities.length === 0,
      missingCapabilities,
      requiredCapabilityCount: GATEWAY_CAPABILITIES.length,
    };
  }
}
