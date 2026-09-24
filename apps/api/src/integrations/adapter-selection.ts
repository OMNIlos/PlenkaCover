import type { PrismaService } from '../common/prisma/prisma.service';
import type { RuntimeConfig } from '../common/runtime-config';
import type { OneCRuntimeOptions } from '../common/onec-runtime-options';
import type { GatewayService } from '../modules/gateway/gateway.service';
import { GatewayPrinterAdapter } from './gateway/gateway-printer.adapter';
import { GatewayScaleAdapter } from './gateway/gateway-scale.adapter';
import { HttpOneCAdapter } from './onec/http-onec.adapter';
import { MockOneCAdapter } from './onec/mock-onec.adapter';
import type { OneCAdapter } from './onec/onec.adapter';
import { MockPrinterAdapter } from './printer/mock-printer.adapter';
import type { PrinterAdapter } from './printer/printer.adapter';
import { MockScaleAdapter } from './scale/mock-scale.adapter';
import type { ScaleAdapter } from './scale/scale.adapter';

export function createScaleAdapter(
  config: RuntimeConfig,
  prisma: PrismaService,
  gateway: GatewayService,
): ScaleAdapter {
  return config.deviceGatewayScaleEnabled
    ? new GatewayScaleAdapter(prisma, gateway)
    : new MockScaleAdapter();
}

export function createPrinterAdapter(
  config: RuntimeConfig,
  prisma: PrismaService,
  gateway: GatewayService,
): PrinterAdapter {
  return config.deviceGatewayPrinterEnabled
    ? new GatewayPrinterAdapter(prisma, gateway)
    : new MockPrinterAdapter();
}

export function createOneCAdapter(
  config: RuntimeConfig,
  options: Readonly<OneCRuntimeOptions>,
): OneCAdapter {
  if (!config.onecLiveEnabled) return new MockOneCAdapter();
  return new HttpOneCAdapter(options);
}
