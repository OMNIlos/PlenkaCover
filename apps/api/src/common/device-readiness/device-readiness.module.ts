import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PostDeviceReadinessService } from './post-device-readiness.service';

@Module({
  imports: [PrismaModule],
  providers: [PostDeviceReadinessService],
  exports: [PostDeviceReadinessService],
})
export class DeviceReadinessModule {}
