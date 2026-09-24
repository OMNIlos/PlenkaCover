import { Injectable, NotFoundException } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { gatewayConnectionState } from '../../common/gateway-liveness';
import type { CreatePostDto } from './dto/admin.dto';

export interface AdminActor {
  userId: string | null;
  role: Role;
}

/** Device fields safe for the admin device LIST — rawPayload is exposed only via
 *  the diagnostics endpoint (ТЗ §8), even to admins, to keep the boundary explicit. */
const DEVICE_LIST_SELECT = {
  id: true,
  kind: true,
  status: true,
  ownerRole: true,
  lastSeenAt: true,
  lastTestAt: true,
  parsedPayload: true,
  recovery: true,
  createdAt: true,
} as const;

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listDevices() {
    return this.prisma.deviceRuntime.findMany({
      select: DEVICE_LIST_SELECT,
      orderBy: { kind: 'asc' },
    });
  }

  async testDevice(actor: AdminActor, deviceId: string) {
    const device = await this.prisma.deviceRuntime.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException(`Device ${deviceId} not found`);
    const updated = await this.prisma.deviceRuntime.update({
      where: { id: deviceId },
      data: { lastTestAt: new Date() },
      select: DEVICE_LIST_SELECT,
    });
    await this.audit.record({
      type: 'admin.device.test_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: deviceId,
      detail: { kind: device.kind },
    });
    return updated;
  }

  async recoverDevice(actor: AdminActor, deviceId: string) {
    const device = await this.prisma.deviceRuntime.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException(`Device ${deviceId} not found`);
    return this.prisma.deviceRuntime.update({
      where: { id: deviceId },
      data: { status: 'ready', recovery: `recovered by ${actor.role}` },
      select: DEVICE_LIST_SELECT,
    });
  }

  // --- Posts: shop topology (V2 S2, Variant B) -----------------------------

  /** List machine-posts with online state + bound devices (safe select — no rawPayload). */
  async listPosts() {
    const posts = await this.prisma.post.findMany({
      orderBy: { code: 'asc' },
      include: {
        _count: { select: { devices: true } },
        devices: { select: { id: true, kind: true, status: true, lastSeenAt: true } },
      },
    });
    return posts.map(({ _count, ...post }) => {
      const connectionState = gatewayConnectionState(post.agentStatus, post.lastSeenAt);
      return {
        ...post,
        connectionState,
        online: connectionState === 'online',
        deviceCount: _count.devices,
      };
    });
  }

  /** Create a machine-post. A new станок is just data — no code change (ТЗ Variant B). */
  createPost(_actor: AdminActor, dto: CreatePostDto) {
    return this.prisma.post.create({
      data: { code: dto.code, name: dto.name, ...(dto.status ? { status: dto.status } : {}) },
    });
  }

  /**
   * Post state projection: operational/agent status + bound devices. Devices are
   * selected WITHOUT rawPayload — that stays admin-diagnostics only (ТЗ §8, inv. №5).
   */
  async getPost(id: string) {
    const post = await this.prisma.post.findUnique({
      where: { id },
      include: { devices: { select: DEVICE_LIST_SELECT } },
    });
    if (!post) throw new NotFoundException(`Post ${id} not found`);
    const { devices, ...rest } = post;
    const connectionState = gatewayConnectionState(post.agentStatus, post.lastSeenAt);
    return { ...rest, connectionState, online: connectionState === 'online', devices };
  }

  listSourceHealth() {
    return this.prisma.syncJournal.findMany({ orderBy: { updatedAt: 'desc' } });
  }

  async retrySourceHealth(actor: AdminActor, sourceId: string) {
    const journal = await this.prisma.syncJournal.findUnique({ where: { id: sourceId } });
    if (!journal) throw new NotFoundException(`Sync journal ${sourceId} not found`);
    const updated = await this.prisma.syncJournal.update({
      where: { id: sourceId },
      data: { status: 'retry_requested', retries: { increment: 1 } },
    });
    await this.audit.record({
      type: 'audit:sync_retry_requested',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: sourceId,
      detail: { entity: journal.entity },
    });
    return updated;
  }

  /**
   * Admin diagnostics — the ONE place raw source/device payloads are exposed
   * (ТЗ §8). Same source snapshot that finance sees parsed-only is returned here
   * WITH its rawPayload. Never reachable by business roles (capability-gated).
   */
  async getDiagnostic(diagnosticId: string) {
    const snap = await this.prisma.sourceSnapshot.findUnique({ where: { id: diagnosticId } });
    if (snap) return { diagnosticType: 'source_snapshot' as const, ...snap };
    const device = await this.prisma.deviceRuntime.findUnique({ where: { id: diagnosticId } });
    if (device) return { diagnosticType: 'device' as const, ...device };
    throw new NotFoundException(`Diagnostic ${diagnosticId} not found`);
  }
}
