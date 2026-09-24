import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RollTokenService } from './roll-token.service';

@Module({
  imports: [PrismaModule],
  providers: [RollTokenService],
  exports: [RollTokenService],
})
export class RollTokenModule {}
