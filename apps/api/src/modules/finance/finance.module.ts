import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { DeferredPaymentService } from './deferred-payment.service';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { FinanceWarehouseCoverageController } from './finance-warehouse-coverage.controller';
import { OneCInvoiceSyncService } from './onec-invoice-sync.service';
import { OneCPaymentSyncService } from './onec-payment-sync.service';
import { PaymentAllocationService } from './payment-allocation.service';
import { OneCFinanceSyncScheduler } from './onec-finance-sync.scheduler';
import { FinancePaymentStateService } from './finance-payment-state.service';
import { PaymentCorrectionService } from './payment-correction.service';
import { ProductionCostInputController } from './production-cost-input.controller';
import { ProductionCostInputService } from './production-cost-input.service';
import { DirectorModule } from '../director/director.module';
import { ProductionCostCorrectionController } from './production-cost-correction.controller';
import { FinanceRawMaterialController } from './finance-raw-material.controller';
import { FinanceRawMaterialService } from './finance-raw-material.service';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    IntegrationsModule,
    RoleInboxModule,
    WarehouseCoverageModule,
    DirectorModule,
  ],
  controllers: [
    FinanceController,
    FinanceWarehouseCoverageController,
    ProductionCostInputController,
    ProductionCostCorrectionController,
    FinanceRawMaterialController,
  ],
  providers: [
    FinanceService,
    DeferredPaymentService,
    OneCInvoiceSyncService,
    OneCPaymentSyncService,
    PaymentAllocationService,
    OneCFinanceSyncScheduler,
    FinancePaymentStateService,
    PaymentCorrectionService,
    ProductionCostInputService,
    FinanceRawMaterialService,
  ],
  exports: [DeferredPaymentService],
})
export class FinanceModule {}
