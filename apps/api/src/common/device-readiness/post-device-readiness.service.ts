import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  isGatewayCapability,
  type GatewayCapability,
  type GatewayDeviceKind,
} from '@plenka/contracts';
import { gatewayConnectionState, gatewayHeartbeatIsFresh } from '../gateway-liveness';
import { PrismaService } from '../prisma/prisma.service';

export const PHYSICAL_WORKFLOWS = [
  'production.assignment',
  'operator.shift.open',
  'operator.weight.capture',
  'operator.roll-label.print',
  'operator.qr.verify',
  'warehouse.scan',
  'warehouse.weight.capture',
  'warehouse.big-bag.print',
  'warehouse.pallet.print',
] as const;

export type PhysicalWorkflow = (typeof PHYSICAL_WORKFLOWS)[number];

type WorkflowRequirement = {
  kind: GatewayDeviceKind;
  capability: GatewayCapability;
};

const WORKFLOW_REQUIREMENTS: Record<PhysicalWorkflow, readonly WorkflowRequirement[]> = {
  'production.assignment': [
    { kind: 'scale', capability: 'scale.read.v1' },
    { kind: 'printer', capability: 'printer.roll-label.v1' },
    { kind: 'scanner', capability: 'scanner.hid-keyboard.v1' },
  ],
  'operator.shift.open': [
    { kind: 'scale', capability: 'scale.read.v1' },
    { kind: 'printer', capability: 'printer.roll-label.v1' },
    { kind: 'scanner', capability: 'scanner.hid-keyboard.v1' },
  ],
  'operator.weight.capture': [{ kind: 'scale', capability: 'scale.read.v1' }],
  'operator.roll-label.print': [{ kind: 'printer', capability: 'printer.roll-label.v1' }],
  'operator.qr.verify': [{ kind: 'scanner', capability: 'scanner.hid-keyboard.v1' }],
  'warehouse.scan': [{ kind: 'scanner', capability: 'scanner.hid-keyboard.v1' }],
  'warehouse.weight.capture': [{ kind: 'scale', capability: 'scale.read.v1' }],
  'warehouse.big-bag.print': [{ kind: 'printer', capability: 'printer.big-bag-label.v1' }],
  'warehouse.pallet.print': [{ kind: 'printer', capability: 'printer.pallet-label.v1' }],
};

export type ReadinessCode =
  | 'READY'
  | 'POST_NOT_FOUND'
  | 'POST_NOT_ACTIVE'
  | 'POST_NOT_COMMISSIONED'
  | 'POST_AGENT_OFFLINE'
  | 'POST_AGENT_HEARTBEAT_STALE'
  | 'GATEWAY_AGENT_UPGRADE_REQUIRED'
  | 'GATEWAY_AGENT_UNSUPPORTED'
  | 'POST_CAPABILITY_MISSING'
  | 'POST_DEVICE_BINDING_UNAVAILABLE'
  | 'POST_DEVICE_NOT_READY'
  | 'POST_DEVICE_HEARTBEAT_STALE'
  | 'POST_DEVICE_PROBE_STALE';

export type ReadyDevice = {
  id: string;
  kind: GatewayDeviceKind;
  status: string;
};

export type PostReadinessResult = {
  ready: boolean;
  code: ReadinessCode;
  message: string;
  workflow: PhysicalWorkflow;
  post: { id: string; code: string } | null;
  devices: ReadyDevice[];
};

type ReadinessClient = Pick<Prisma.TransactionClient, 'post'>;

const POST_READINESS_SELECT = {
  id: true,
  code: true,
  status: true,
  commissioningState: true,
  commissionedAt: true,
  agentStatus: true,
  lastSeenAt: true,
  agentCompatibility: true,
  agentCapabilities: true,
  devices: {
    where: { isEnabled: true },
    orderBy: { id: 'asc' as const },
    select: {
      id: true,
      kind: true,
      connectionKind: true,
      status: true,
      isEnabled: true,
      lastSeenAt: true,
      lastProbeAt: true,
    },
  },
} as const;

@Injectable()
export class PostDeviceReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async require(
    postId: string,
    workflow: PhysicalWorkflow,
    client: ReadinessClient = this.prisma,
    now = new Date(),
  ): Promise<PostReadinessResult & { ready: true }> {
    const result = await this.check(postId, workflow, client, now);
    if (!result.ready) {
      throw new ServiceUnavailableException({
        code: result.code,
        message: result.message,
        workflow: result.workflow,
      });
    }
    return result as PostReadinessResult & { ready: true };
  }

  async check(
    postId: string,
    workflow: PhysicalWorkflow,
    client: ReadinessClient = this.prisma,
    now = new Date(),
  ): Promise<PostReadinessResult> {
    const post = await client.post.findUnique({
      where: { id: postId },
      select: POST_READINESS_SELECT,
    });
    if (!post) {
      return this.failure(workflow, 'POST_NOT_FOUND', 'Физический пост не найден.');
    }
    const safePost = { id: post.id, code: post.code };
    const fail = (code: ReadinessCode, message: string): PostReadinessResult =>
      this.failure(workflow, code, message, safePost);

    if (post.status !== 'active') {
      return fail('POST_NOT_ACTIVE', 'Пост недоступен для производственной работы.');
    }
    if (post.commissioningState !== 'commissioned' || !post.commissionedAt) {
      return fail('POST_NOT_COMMISSIONED', 'Пост ещё не прошёл ввод оборудования в эксплуатацию.');
    }

    // The authenticated warehouse browser owns USB-HID keyboard input, not the gateway agent.
    if (workflow === 'warehouse.scan') {
      const enabledScanners = post.devices.filter(
        (device) => device.kind === 'scanner' && device.isEnabled,
      );
      const scanner = enabledScanners.length === 1 ? enabledScanners[0] : null;
      if (scanner?.connectionKind === 'usb-hid') {
        return {
          ready: true,
          code: 'READY',
          message: 'Физический пост готов.',
          workflow,
          post: safePost,
          devices: [{ id: scanner.id, kind: 'scanner', status: scanner.status }],
        };
      }
    }

    const connection = gatewayConnectionState(post.agentStatus, post.lastSeenAt, now);
    if (connection === 'offline') {
      return fail('POST_AGENT_OFFLINE', 'Агент физического поста не в сети.');
    }
    if (connection !== 'online') {
      return fail(
        'POST_AGENT_HEARTBEAT_STALE',
        'Нет свежего подтверждения связи с физическим постом.',
      );
    }
    if (post.agentCompatibility === 'upgrade_required') {
      return fail(
        'GATEWAY_AGENT_UPGRADE_REQUIRED',
        'Агент поста нужно обновить до совместимой версии.',
      );
    }
    if (post.agentCompatibility !== 'compatible') {
      return fail('GATEWAY_AGENT_UNSUPPORTED', 'Версия агента поста несовместима с платформой.');
    }

    const capabilities = new Set(
      Array.isArray(post.agentCapabilities)
        ? post.agentCapabilities.filter(isGatewayCapability)
        : [],
    );
    const requirements = WORKFLOW_REQUIREMENTS[workflow];
    if (requirements.some(({ capability }) => !capabilities.has(capability))) {
      return fail(
        'POST_CAPABILITY_MISSING',
        'Агент поста не поддерживает требуемую физическую операцию.',
      );
    }

    const readyDevices: ReadyDevice[] = [];
    for (const requirement of requirements) {
      const bound = post.devices.filter((device) => device.kind === requirement.kind);
      if (bound.length !== 1) {
        return fail(
          'POST_DEVICE_BINDING_UNAVAILABLE',
          'Оборудование поста отсутствует или настроено неоднозначно.',
        );
      }
      const device = bound[0];
      if (device.status !== 'ready') {
        return fail('POST_DEVICE_NOT_READY', 'Требуемое оборудование поста сейчас недоступно.');
      }
      if (!gatewayHeartbeatIsFresh(device.lastSeenAt, now)) {
        return fail('POST_DEVICE_HEARTBEAT_STALE', 'Нет свежего статуса требуемого оборудования.');
      }
      if (!gatewayHeartbeatIsFresh(device.lastProbeAt, now)) {
        return fail('POST_DEVICE_PROBE_STALE', 'Нет свежей проверки требуемого оборудования.');
      }
      readyDevices.push({ id: device.id, kind: requirement.kind, status: device.status });
    }

    return {
      ready: true,
      code: 'READY',
      message: 'Физический пост готов.',
      workflow,
      post: safePost,
      devices: readyDevices,
    };
  }

  private failure(
    workflow: PhysicalWorkflow,
    code: ReadinessCode,
    message: string,
    post: { id: string; code: string } | null = null,
  ): PostReadinessResult {
    return { ready: false, code, message, workflow, post, devices: [] };
  }
}
