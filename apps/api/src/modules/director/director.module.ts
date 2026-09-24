import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PayrollTariffModule } from '../../common/payroll-tariffs/payroll-tariff.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { InventoryProjectionModule } from '../../common/inventory/inventory-projection.module';
import { DirectorAnalyticsService } from './director-analytics.service';
import { DirectorController } from './director.controller';
import { DirectorInventoryController } from './director-inventory.controller';
import { DirectorPayrollController } from './director-payroll.controller';
import { DirectorPayrollTariffOrdersController } from './director-payroll-tariff-orders.controller';
import { DirectorPayrollFactsService } from './director-payroll-facts.service';
import { DirectorPayrollService } from './director-payroll.service';
import { DirectorService } from './director.service';
import { DirectorTraceabilityService } from './director-traceability.service';
import { DirectorRollCostController } from './director-roll-cost.controller';
import { DirectorRollCostService } from './director-roll-cost.service';
import { BusinessProjectionsModule } from '../../common/business-projections/business-projections.module';
import { RollProductionCostAssemblerService } from './roll-production-cost-assembler.service';
import { RollProductionCostReconcilerScheduler } from './roll-production-cost-reconciler.scheduler';
import {
  ROLL_PRODUCTION_COST_ASSEMBLER,
  RollProductionCostSnapshotService,
} from './roll-production-cost-snapshot.service';
import { PlatformQrModule } from '../../common/platform-qr/platform-qr.module';
import { DirectorContainerTraceabilityService } from './director-container-traceability.service';
import { DirectorTraceabilityTimelineService } from './director-traceability-timeline.service';
import { ProductionModule } from '../production/production.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    RoleInboxModule,
    InventoryProjectionModule,
    BusinessProjectionsModule,
    PayrollTariffModule,
    PlatformQrModule,
    ProductionModule,
  ],
  controllers: [
    DirectorController,
    DirectorInventoryController,
    DirectorPayrollController,
    DirectorPayrollTariffOrdersController,
    DirectorRollCostController,
  ],
  providers: [
    DirectorService,
    DirectorAnalyticsService,
    DirectorTraceabilityTimelineService,
    DirectorContainerTraceabilityService,
    DirectorTraceabilityService,
    DirectorPayrollFactsService,
    DirectorPayrollService,
    DirectorRollCostService,
    RollProductionCostAssemblerService,
    {
      provide: ROLL_PRODUCTION_COST_ASSEMBLER,
      useExisting: RollProductionCostAssemblerService,
    },
    RollProductionCostSnapshotService,
    RollProductionCostReconcilerScheduler,
  ],
  exports: [DirectorAnalyticsService, DirectorPayrollService, RollProductionCostSnapshotService],
})
export class DirectorModule {}
