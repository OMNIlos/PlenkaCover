import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';

export async function withSerializableRetry<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const serializationConflict =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
      if (!serializationConflict) throw error;
      if (attempt === 1) {
        throw new ConflictException({
          code: 'ADMIN_ACCESS_INVALID',
          message: 'Concurrent access change; retry the request.',
        });
      }
    }
  }
  throw new Error('Unreachable transaction state.');
}
