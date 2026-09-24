import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('reports ready after a successful database query', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const service = new HealthService(prisma as never);

    await expect(service.readiness()).resolves.toMatchObject({
      status: 'ready',
      service: 'plenka-api',
    });
  });

  it('returns a safe 503 without leaking the database error', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('postgres://user:secret@db/plenka')),
    };
    const service = new HealthService(prisma as never);

    let error: unknown;
    try {
      await service.readiness();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse())).not.toContain(
      'secret',
    );
  });
});
