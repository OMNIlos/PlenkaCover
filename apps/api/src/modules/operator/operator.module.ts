import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { OperationalIncidentsModule } from '../../common/operational-incidents/operational-incidents.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PayrollTariffModule } from '../../common/payroll-tariffs/payroll-tariff.module';
import { RoleInboxModule } from '../../common/role-inbox/role-inbox.module';
import { RollTokenModule } from '../../common/roll-token/roll-token.module';
import { DeviceReadinessModule } from '../../common/device-readiness/device-readiness.module';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { WarehouseCoverageModule } from '../warehouse-coverage/warehouse-coverage.module';
import { ProductionModule } from '../production/production.module';
import { DirectorModule } from '../director/director.module';
import { OperatorController } from './operator.controller';
import { OperatorPayrollController } from './operator-payroll.controller';
import { OperatorPayrollService } from './operator-payroll.service';
import { OperatorService } from './operator.service';
import { OperatorSessionService } from './operator-session.service';
import { OperatorShiftService } from './operator-shift.service';
import { OperatorDeviceBindingService } from './operator-device-binding.service';
import { OperatorOperationService } from './operator-operation.service';
import { OperatorPhysicalService } from './operator-physical.service';
import { OperatorRollOwnershipService } from './operator-roll-ownership.service';
import { OperatorStepBackService } from './operator-step-back.service';
import { WarehouseSpoolStockModule } from '../warehouse/warehouse-spool-stock.module';
import { OperatorOrderMassController } from './operator-order-mass.controller';
import { OperatorOrderMassService } from './operator-order-mass.service';
import { OperatorDefectBagService } from './operator-defect-bag.service';

@Module({
  imports: [
    PrismaModule,
    PayrollTariffModule,
    AuditModule,
    IntegrationsModule,
    OperationalIncidentsModule,
    RoleInboxModule,
    RollTokenModule,
    DeviceReadinessModule,
    ProductionModule,
    DirectorModule,
    WarehouseCoverageModule,
    WarehouseSpoolStockModule,
  ],
  controllers: [OperatorController, OperatorPayrollController, OperatorOrderMassController],
  providers: [
    OperatorService,
    OperatorSessionService,
    OperatorShiftService,
    OperatorDeviceBindingService,
    OperatorOperationService,
    OperatorPhysicalService,
    OperatorRollOwnershipService,
    OperatorStepBackService,
    OperatorPayrollService,
    OperatorOrderMassService,
    OperatorDefectBagService,
  ],
})
export class OperatorModule {}
