import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import {
  GATEWAY_DEVICE_KINDS,
  type GatewayDeviceKind,
  type GatewayDeviceStatus,
} from '@plenka/contracts';
import { AuditModule } from '../../common/audit/audit.module';
import { OperationalIncidentsModule } from '../../common/operational-incidents/operational-incidents.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { RuntimeConfig } from '../../common/runtime-config';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';
import { GatewayAuthGuard } from './gateway-auth.guard';
import { SimulatedGatewayAgent, simulatedHeartbeatIntervalMs } from './simulated-gateway-agent';

/**
 * Gateway module (V2 S4). Exports GatewayService so the Gateway*Adapter (in integrations) can
 * dispatch device commands. When `GATEWAY_SIMULATOR=on`, the in-process SimulatedGatewayAgent is
 * attached to every post at boot so the operator cycle runs end-to-end without hardware.
 */
@Module({
  imports: [PrismaModule, AuditModule, OperationalIncidentsModule],
  controllers: [GatewayController],
  providers: [GatewayService, SimulatedGatewayAgent, GatewayAuthGuard],
  exports: [GatewayService, SimulatedGatewayAgent],
})
export class GatewayModule implements OnModuleInit {
  private readonly logger = new Logger(GatewayModule.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sim: SimulatedGatewayAgent,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  async onModuleInit() {
    if (!this.config.gatewaySimulatorEnabled) return;
    const posts = await this.prisma.post.findMany({ include: { devices: true } });
    const heartbeatIntervalMs = simulatedHeartbeatIntervalMs(this.config.gatewayStaleAfterSec);
    for (const p of posts) {
      const devices = p.devices.flatMap((device) =>
        isGatewayDeviceKind(device.kind)
          ? [
              {
                deviceId: device.id,
                kind: device.kind,
                status: 'ready' as GatewayDeviceStatus,
              },
            ]
          : [],
      );
      if (devices.length !== p.devices.length) {
        this.logger.warn(`Post ${p.code} has unsupported device kinds; they remain fail-closed.`);
      }
      await this.sim.attach(p.id, devices, heartbeatIntervalMs);
    }
  }
}

const gatewayDeviceKinds = new Set<string>(GATEWAY_DEVICE_KINDS);

function isGatewayDeviceKind(value: string): value is GatewayDeviceKind {
  return gatewayDeviceKinds.has(value);
}
