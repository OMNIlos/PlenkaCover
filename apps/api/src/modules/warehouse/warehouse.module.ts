import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { DeviceReadinessModule } from '../../common/device-readiness/device-readiness.module';
import { OrderFulfillmentModule } from '../../common/order-fulfillment/order-fulfillment.module';
import { OperationalIncidentsModule } from '../../common/operational-incidents/operational-incidents.module';
import { PalletTokenModule } from '../../common/pallet-token/pallet-token.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { RollTokenModule } from '../../common/roll-token/roll-token.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { WarehouseController } from './warehouse.controller';
import { WarehouseService } from './warehouse.service';
import { WarehouseIntakeService } from './warehouse-intake.service';
import { FinanceModule } from '../finance/finance.module';
import { ProductionModule } from '../production/production.module';
import { PalletExportService } from './pallet-export.service';
import { PalletLabelRenderer } from './pallet-label.renderer';
import { PalletPrintService } from './pallet-print.service';
import { WarehouseIntakeIntegrityService } from './warehouse-intake-integrity.service';
import { WarehouseOperationService } from './warehouse-operation.service';
import { WarehouseBrowserSessionService } from './warehouse-browser-session.service';
import { WarehouseOneCStockPushService } from './warehouse-onec-stock-push.service';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { WarehouseCoverageRecheckController } from './warehouse-coverage-recheck.controller';
import { WarehouseFinishedStockService } from './warehouse-finished-stock.service';
import { InventoryProjectionModule } from '../../common/inventory/inventory-projection.module';
import { WarehouseInventoryController } from './warehouse-inventory.controller';
import { WarehouseAccountingController } from './warehouse-accounting.controller';
import { WarehouseAccountingService } from './warehouse-accounting.service';
import { WarehousePalletService } from './warehouse-pallet.service';
import { WarehousePalletCutoverService } from './warehouse-pallet-cutover';
import { MaterialCatalogModule } from '../material-catalog/material-catalog.module';
import { WarehouseBigBagService } from './warehouse-bigbag.service';
import { WarehouseBigBagPrintService } from './warehouse-bigbag-print.service';
import { BigBagLabelRenderer } from './bigbag-label.renderer';
import { WarehouseBigBagSystemPrintService } from './warehouse-bigbag-system-print.service';
import { WarehouseQrInspectionService } from './warehouse-qr-inspection.service';
import { WarehouseReserveRollService } from './warehouse-reserve-roll.service';
import { WarehouseInventoryService } from './warehouse-inventory.service';
import { WarehousePalletSelectionService } from './warehouse-pallet-selection.service';
import { PalletSystemPrintIntentService } from './pallet-system-print-intent.service';
import { BusinessProjectionsModule } from '../../common/business-projections/business-projections.module';
import { WarehouseSpoolPriceController } from './warehouse-spool-price.controller';
import { WarehouseSpoolPriceService } from './warehouse-spool-price.service';
import { PalletLabelLayoutModule } from '../../common/pallet-label-layout/pallet-label-layout.module';
import { PlatformQrModule } from '../../common/platform-qr/platform-qr.module';
import { WarehousePalletHandoffService } from './warehouse-pallet-handoff.service';
import { WarehousePalletDeliveryService } from './warehouse-pallet-delivery.service';
import { WarehouseDefectBagService } from './warehouse-defect-bag.service';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    OrderFulfillmentModule,
    IntegrationsModule,
    OperationalIncidentsModule,
    FinanceModule,
    ProductionModule,
    RoleInboxModule,
    RollTokenModule,
    PalletTokenModule,
    WarehouseCoverageModule,
    InventoryProjectionModule,
    MaterialCatalogModule,
    BusinessProjectionsModule,
    DeviceReadinessModule,
    PalletLabelLayoutModule,
    PlatformQrModule,
  ],
  controllers: [
    WarehouseController,
    WarehouseCoverageRecheckController,
    WarehouseInventoryController,
    WarehouseAccountingController,
    WarehouseSpoolPriceController,
  ],
  providers: [
    WarehouseService,
    WarehouseIntakeService,
    PalletLabelRenderer,
    PalletExportService,
    PalletPrintService,
    WarehouseIntakeIntegrityService,
    WarehouseOperationService,
    WarehouseBrowserSessionService,
    WarehouseOneCStockPushService,
    WarehouseFinishedStockService,
    WarehouseAccountingService,
    WarehousePalletService,
    WarehousePalletCutoverService,
    WarehouseBigBagService,
    WarehouseBigBagPrintService,
    BigBagLabelRenderer,
    WarehouseBigBagSystemPrintService,
    WarehouseQrInspectionService,
    WarehouseReserveRollService,
    WarehouseInventoryService,
    WarehousePalletSelectionService,
    PalletSystemPrintIntentService,
    WarehouseSpoolPriceService,
    WarehousePalletHandoffService,
    WarehousePalletDeliveryService,
    WarehouseDefectBagService,
  ],
})
export class WarehouseModule {}
