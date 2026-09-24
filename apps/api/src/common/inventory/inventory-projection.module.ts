import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryProjectionService } from './inventory-projection.service';

@Module({
  imports: [PrismaModule],
  providers: [InventoryProjectionService],
  exports: [InventoryProjectionService],
})
export class InventoryProjectionModule {}
