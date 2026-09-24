import { Module } from '@nestjs/common';
import { GatewayModule } from '../modules/gateway/gateway.module';
import { SCALE_ADAPTER } from './scale/scale.adapter';
import { SCANNER_ADAPTER } from './scanner/scanner.adapter';
import { MockScannerAdapter } from './scanner/mock-scanner.adapter';
import { PRINTER_ADAPTER } from './printer/printer.adapter';
import { ONEC_ADAPTER } from './onec/onec.adapter';
import { OneCImportService } from './onec/onec-import.service';
import { OneCSyncService } from './onec/onec-sync.service';
import { OneCSyncScheduler } from './onec/onec-sync.scheduler';
import { ONEC_RUNTIME_OPTIONS, RUNTIME_CONFIG } from '../common/runtime-config.module';
import { PrismaService } from '../common/prisma/prisma.service';
import { GatewayService } from '../modules/gateway/gateway.service';
import { createOneCAdapter, createPrinterAdapter, createScaleAdapter } from './adapter-selection';

/**
 * Device/1С integration adapters (ТЗ §11.8). Mocks by default; a gateway-backed adapter swaps in
 * behind the SAME DI token + interface when its flag is on (V2 S4, inv. №4) — call sites depend on
 * the interface, never the implementation. `DEVICE_GATEWAY_SCALE=on` / `DEVICE_GATEWAY_PRINTER=on`
 * route through the post gateway (answered by the SimulatedGatewayAgent when `GATEWAY_SIMULATOR=on`,
 * by a real on-post agent later). `ONEC_LIVE=true` swaps the bounded `HttpOneCAdapter` in for
 * `MockOneCAdapter` behind the same token (V2 S6). The §8 raw-payload boundary is unchanged.
 * `OneCImportService` owns snapshot persistence + append-only import events.
 */
@Module({
  imports: [GatewayModule],
  providers: [
    {
      provide: SCALE_ADAPTER,
      inject: [RUNTIME_CONFIG, PrismaService, GatewayService],
      useFactory: createScaleAdapter,
    },
    { provide: SCANNER_ADAPTER, useClass: MockScannerAdapter },
    {
      provide: PRINTER_ADAPTER,
      inject: [RUNTIME_CONFIG, PrismaService, GatewayService],
      useFactory: createPrinterAdapter,
    },
    {
      provide: ONEC_ADAPTER,
      inject: [RUNTIME_CONFIG, ONEC_RUNTIME_OPTIONS],
      useFactory: createOneCAdapter,
    },
    OneCImportService,
    OneCSyncService,
    OneCSyncScheduler,
  ],
  exports: [
    SCALE_ADAPTER,
    SCANNER_ADAPTER,
    PRINTER_ADAPTER,
    ONEC_ADAPTER,
    OneCImportService,
    OneCSyncService,
  ],
})
export class IntegrationsModule {}
