import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { InventoryProjectionModule } from '../../common/inventory/inventory-projection.module';
import { DeviceReadinessModule } from '../../common/device-readiness/device-readiness.module';
import { ProductionInventoryController } from './production-inventory.controller';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';
import { ProductionShiftCommandService } from './production-shift-command.service';
import { ProductionBigBagSummaryService } from './production-bigbag-summary.service';
import { ProductionAssignmentCancellationService } from './production-assignment-cancellation.service';
import { WarehouseSpoolStockModule } from '../warehouse/warehouse-spool-stock.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    IntegrationsModule,
    RoleInboxModule,
    WarehouseCoverageModule,
    InventoryProjectionModule,
    DeviceReadinessModule,
    WarehouseSpoolStockModule,
  ],
  controllers: [ProductionController, ProductionInventoryController],
  providers: [
    ProductionService,
    ProductionShiftCommandService,
    ProductionBigBagSummaryService,
    ProductionAssignmentCancellationService,
  ],
  exports: [ProductionService, ProductionShiftCommandService],
})
export class ProductionModule {}
