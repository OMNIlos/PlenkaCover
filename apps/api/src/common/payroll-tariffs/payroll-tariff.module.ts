import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PayrollTariffOrderRepository } from './payroll-tariff-order.repository';
import { PayrollTariffOrderService } from './payroll-tariff-order.service';
import { PayrollTariffResolver } from './payroll-tariff-resolver';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [PayrollTariffOrderRepository, PayrollTariffOrderService, PayrollTariffResolver],
  exports: [PayrollTariffOrderRepository, PayrollTariffOrderService, PayrollTariffResolver],
})
export class PayrollTariffModule {}
