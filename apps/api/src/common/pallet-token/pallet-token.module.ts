import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PalletTokenService } from './pallet-token.service';

@Module({
  imports: [PrismaModule],
  providers: [PalletTokenService],
  exports: [PalletTokenService],
})
export class PalletTokenModule {}
