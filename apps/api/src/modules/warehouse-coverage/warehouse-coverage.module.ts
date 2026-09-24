import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { OrderFulfillmentModule } from '../../common/order-fulfillment/order-fulfillment.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WarehouseCoverageCommandService } from './warehouse-coverage-command.service';
import {
  COVERAGE_TERMINAL_CONFLICT_HOOK,
  WarehouseCoverageTransaction,
} from './warehouse-coverage-transaction';
import { WarehouseCoverageConflictCounter } from './warehouse-coverage-conflict-counter';
import { WarehouseCoverageMetricsService } from './warehouse-coverage-metrics.service';
import { WarehouseCoverageProjectionService } from './warehouse-coverage-projection.service';
import { WarehouseRollCoverageFactService } from './warehouse-roll-coverage-fact.service';
import { WarehouseCoverageCalculationService } from './warehouse-coverage-calculation.service';
import { WarehouseCoverageProductionHandoffService } from './warehouse-coverage-production-handoff.service';
import { WarehouseCoverageDecisionService } from './warehouse-coverage-decision.service';
import { WarehouseCoverageRecheckService } from './warehouse-coverage-recheck.service';
import { WarehouseCoverageReservationRecoveryService } from './warehouse-coverage-reservation-recovery.service';
import { WarehouseCoverageOrderChangeService } from './warehouse-coverage-order-change.service';

@Module({
  imports: [PrismaModule, AuditModule, OrderFulfillmentModule],
  providers: [
    WarehouseRollCoverageFactService,
    WarehouseCoverageCommandService,
    WarehouseCoverageTransaction,
    WarehouseCoverageProjectionService,
    WarehouseCoverageCalculationService,
    WarehouseCoverageProductionHandoffService,
    WarehouseCoverageDecisionService,
    WarehouseCoverageRecheckService,
    WarehouseCoverageReservationRecoveryService,
    WarehouseCoverageOrderChangeService,
    WarehouseCoverageConflictCounter,
    {
      provide: COVERAGE_TERMINAL_CONFLICT_HOOK,
      useExisting: WarehouseCoverageConflictCounter,
    },
    WarehouseCoverageMetricsService,
  ],
  exports: [
    WarehouseRollCoverageFactService,
    WarehouseCoverageCommandService,
    WarehouseCoverageTransaction,
    WarehouseCoverageProjectionService,
    WarehouseCoverageCalculationService,
    WarehouseCoverageProductionHandoffService,
    WarehouseCoverageDecisionService,
    WarehouseCoverageRecheckService,
    WarehouseCoverageReservationRecoveryService,
    WarehouseCoverageOrderChangeService,
    WarehouseCoverageMetricsService,
  ],
})
export class WarehouseCoverageModule {}
