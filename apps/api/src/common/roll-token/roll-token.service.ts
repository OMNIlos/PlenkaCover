import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type RollTokenClient = Pick<Prisma.TransactionClient, 'rollScanToken'>;

@Injectable()
export class RollTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(rollCode: string, client: RollTokenClient = this.prisma) {
    await client.rollScanToken.createMany({ data: { rollCode }, skipDuplicates: true });
    const record = await client.rollScanToken.findUnique({
      where: { rollCode },
      select: { rollCode: true, token: true },
    });
    if (!record) {
      throw new ConflictException({
        code: 'ROLL_SCAN_TOKEN_UNAVAILABLE',
        message: 'Не удалось подготовить физическую метку рулона.',
      });
    }
    return record;
  }

  findExact(token: string, client: RollTokenClient = this.prisma) {
    return client.rollScanToken.findUnique({
      where: { token },
      select: { rollCode: true },
    });
  }
}
