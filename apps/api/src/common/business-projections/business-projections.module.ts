import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BigBagRegisterController } from './bigbag-register.controller';
import { BigBagRegisterProjectionService } from './bigbag-register-projection.service';
import { WarehouseBusinessProjectionService } from './warehouse-business-projection.service';
import { PenaltySnapshotController } from './penalty-snapshot.controller';
import { PenaltySnapshotService } from './penalty-snapshot.service';

@Module({
  imports: [PrismaModule],
  controllers: [BigBagRegisterController, PenaltySnapshotController],
  providers: [
    WarehouseBusinessProjectionService,
    BigBagRegisterProjectionService,
    PenaltySnapshotService,
  ],
  exports: [
    WarehouseBusinessProjectionService,
    BigBagRegisterProjectionService,
    PenaltySnapshotService,
  ],
})
export class BusinessProjectionsModule {}
