import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RoleInboxProjectionService } from './role-inbox.service';

@Module({
  imports: [PrismaModule],
  providers: [RoleInboxProjectionService],
  exports: [RoleInboxProjectionService],
})
export class RoleInboxModule {}
