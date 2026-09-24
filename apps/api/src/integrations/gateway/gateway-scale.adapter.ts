import { Injectable } from '@nestjs/common';
import type { DeviceStatus } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayService } from '../../modules/gateway/gateway.service';
import type {
  BoundScaleDevice,
  ScaleAdapter,
  ScaleReading,
  ScaleReadingKind,
} from '../scale/scale.adapter';

/**
 * Real-topology scale adapter (V2 S4): reads via the post's gateway agent instead of a local
 * mock. Implements the SAME ScaleAdapter interface, so it swaps in behind SCALE_ADAPTER with no
 * call-site changes (inv. №4). A timeout / unbound device yields an `offline` reading — the
 * operator service turns that into 503 + `device.scale.offline` (inv. №6). Raw frames never pass
 * through here; they live in DeviceRuntime/GatewayEvent (admin only, inv. №5).
 */
@Injectable()
export class GatewayScaleAdapter implements ScaleAdapter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
  ) {}

  async read(binding: BoundScaleDevice, kind: ScaleReadingKind): Promise<ScaleReading> {
    const deviceId = binding.deviceId;
    if (!(await this.capabilityIsCurrent(binding.expectedPostId))) return this.offline(deviceId);
    if (!(await this.bindingIsCurrent(binding))) return this.offline(deviceId);
    try {
      const r = await this.gateway.dispatchCommand(binding.expectedPostId, 'read_scale', {
        deviceId,
        kind,
      });
      // An agent-side failure (`ok: false`) is an offline device, whatever else the
      // result claims — a failed read must never default into a 'ready' status.
      if (r.ok === false || r.deviceId !== deviceId) {
        return this.offline(deviceId);
      }
      if (!(await this.bindingIsCurrent(binding))) return this.offline(deviceId);
      const status = (r.status as DeviceStatus | undefined) ?? 'ready';
      return {
        deviceId,
        status,
        stable: Boolean(r.stable),
        grossKg: Number(r.grossKg ?? 0),
      };
    } catch {
      return this.offline(deviceId);
    }
  }

  private async bindingIsCurrent(binding: BoundScaleDevice): Promise<boolean> {
    const current = await this.prisma.deviceRuntime.findFirst({
      where: {
        id: binding.deviceId,
        postId: binding.expectedPostId,
        kind: binding.expectedKind,
        isEnabled: true,
        status: 'ready',
      },
      select: { id: true },
    });
    return current !== null;
  }

  private offline(deviceId: string): ScaleReading {
    return { deviceId, status: 'offline', stable: false, grossKg: 0 };
  }

  private async capabilityIsCurrent(postId: string): Promise<boolean> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { agentCompatibility: true, agentCapabilities: true },
    });
    return Boolean(
      post &&
      post.agentCompatibility === 'compatible' &&
      Array.isArray(post.agentCapabilities) &&
      post.agentCapabilities.includes('scale.read.v1'),
    );
  }
}
