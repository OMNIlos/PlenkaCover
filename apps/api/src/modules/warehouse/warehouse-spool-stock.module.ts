import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WarehouseSpoolStockService } from './warehouse-spool-stock.service';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [WarehouseSpoolStockService],
  exports: [WarehouseSpoolStockService],
})
export class WarehouseSpoolStockModule {}
