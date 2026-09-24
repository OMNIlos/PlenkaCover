import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OrderFulfillmentHandoffService } from './order-fulfillment-handoff.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [OrderFulfillmentHandoffService],
  exports: [OrderFulfillmentHandoffService],
})
export class OrderFulfillmentModule {}
