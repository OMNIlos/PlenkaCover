import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async readiness(): Promise<{ status: 'ready'; service: string; time: string }> {
    const time = new Date().toISOString();
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return { status: 'ready', service: 'plenka-api', time };
    } catch {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        service: 'plenka-api',
        time,
      });
    }
  }
}
