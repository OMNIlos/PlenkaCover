import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OperationalCheckInput } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

const FORBIDDEN_SUMMARY_KEYS = new Set([
  'rawpayload',
  'password',
  'token',
  'authorization',
  'connectionstring',
]);

function assertSafeSummary(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertSafeSummary);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_SUMMARY_KEYS.has(key.toLowerCase())) {
      throw new BadRequestException(`Operational summary contains forbidden field: ${key}`);
    }
    assertSafeSummary(nested);
  }
}

@Injectable()
export class OperationalChecksService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: OperationalCheckInput) {
    assertSafeSummary(input.summary);
    return this.prisma.operationalCheck.create({
      data: {
        scope: input.scope,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        status: input.status,
        latencyMs: Math.max(0, input.completedAt.getTime() - input.startedAt.getTime()),
        summary: input.summary as Prisma.InputJsonValue,
        diagnosticRef: input.diagnosticRef ?? null,
        actorId: input.actorId ?? null,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      },
    });
  }
}
