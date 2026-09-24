import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { OrderFulfillmentModule } from '../../common/order-fulfillment/order-fulfillment.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { CommercialController } from './commercial.controller';
import { CommercialRawMaterialsController } from './commercial-raw-materials.controller';
import { CommercialService } from './commercial.service';
import { CounterpartyController } from './counterparty.controller';
import { CounterpartyService } from './counterparty.service';
import { CounterpartyTemplateController } from './counterparty-template.controller';
import { CounterpartyTemplateService } from './counterparty-template.service';
import { ProductionModule } from '../production/production.module';
import { MaterialShortageCorrectionService } from './material-shortage-correction.service';
import { CommercialNotificationController } from './commercial-notification.controller';
import { CommercialWorkspaceService } from './commercial-workspace.service';
import { CommercialCoverService } from './commercial-cover.service';
import { CommercialResolutionService } from './commercial-resolution.service';
import { CommercialRawMaterialRiskService } from './commercial-raw-material-risk.service';
import { MaterialCatalogModule } from '../material-catalog/material-catalog.module';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { StockProductionTemplateController } from './stock-production-template.controller';
import { StockProductionTemplateService } from './stock-production-template.service';
import { DirectorModule } from '../director/director.module';
import { CommercialPerformanceController } from './commercial-performance.controller';
import { CommercialPerformanceService } from './commercial-performance.service';
import { CommercialFinanceNoteService } from './commercial-finance-note.service';
import { CommercialProblemController } from './commercial-problem.controller';
import { CommercialProblemService } from './commercial-problem.service';
import { CommercialOrderAmendmentService } from './commercial-order-amendment.service';
import { CommercialOrderReconciliationService } from './commercial-order-reconciliation.service';
import { CommercialBigBagValueService } from './commercial-bigbag-value.service';
import { BusinessOperationalProblemService } from './business-operational-problem.service';
import { BusinessOperationalProblemOverrideController } from './business-operational-problem-override.controller';
import { BusinessProjectionsModule } from '../../common/business-projections/business-projections.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    OrderFulfillmentModule,
    ProductionModule,
    RoleInboxModule,
    MaterialCatalogModule,
    WarehouseCoverageModule,
    DirectorModule,
    BusinessProjectionsModule,
  ],
  controllers: [
    CommercialController,
    CommercialRawMaterialsController,
    CounterpartyController,
    CounterpartyTemplateController,
    StockProductionTemplateController,
    CommercialNotificationController,
    CommercialPerformanceController,
    BusinessOperationalProblemOverrideController,
    CommercialProblemController,
  ],
  providers: [
    CommercialService,
    MaterialShortageCorrectionService,
    CounterpartyService,
    CounterpartyTemplateService,
    StockProductionTemplateService,
    CommercialWorkspaceService,
    CommercialCoverService,
    CommercialResolutionService,
    CommercialRawMaterialRiskService,
    CommercialPerformanceService,
    CommercialFinanceNoteService,
    CommercialProblemService,
    CommercialOrderAmendmentService,
    CommercialOrderReconciliationService,
    CommercialBigBagValueService,
    BusinessOperationalProblemService,
  ],
})
export class CommercialModule {}
