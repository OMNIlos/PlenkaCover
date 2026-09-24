import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type PalletTokenClient = Pick<Prisma.TransactionClient, 'palletScanToken'>;

@Injectable()
export class PalletTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async requireForDocument(documentId: string, client: PalletTokenClient = this.prisma) {
    const record = await client.palletScanToken.findUnique({
      where: { documentId },
      select: { documentId: true, token: true },
    });
    if (!record) {
      throw new ConflictException({
        code: 'PALLET_SCAN_TOKEN_UNAVAILABLE',
        message: 'Не удалось подготовить физическую метку палеты.',
      });
    }
    return record;
  }
}
