import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PlatformQrRecognitionService } from './platform-qr-recognition.service';

@Module({
  imports: [PrismaModule],
  providers: [PlatformQrRecognitionService],
  exports: [PlatformQrRecognitionService],
})
export class PlatformQrModule {}
