import { BadRequestException } from '@nestjs/common';
import { OperationalChecksService } from './operational-checks.service';

describe('OperationalChecksService', () => {
  const prisma = {
    operationalCheck: { create: jest.fn() },
  };
  const service = new OperationalChecksService(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('records a safe append-only check and derives latency', async () => {
    prisma.operationalCheck.create.mockImplementation(({ data }) => Promise.resolve(data));

    await service.record({
      scope: 'onec',
      targetType: 'connection',
      status: 'passed',
      summary: { mode: 'mock' },
      actorId: 'admin-1',
      startedAt: new Date('2026-07-13T10:00:00.000Z'),
      completedAt: new Date('2026-07-13T10:00:00.010Z'),
    });

    expect(prisma.operationalCheck.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'onec',
        targetType: 'connection',
        status: 'passed',
        latencyMs: 10,
        summary: { mode: 'mock' },
      }),
    });
  });

  it.each(['rawPayload', 'password', 'token', 'authorization', 'connectionString'])(
    'rejects forbidden summary key %s recursively',
    async (key) => {
      await expect(
        service.record({
          scope: 'platform',
          targetType: 'api',
          status: 'failed',
          summary: { nested: { [key]: 'secret' } },
          startedAt: new Date(),
          completedAt: new Date(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.operationalCheck.create).not.toHaveBeenCalled();
    },
  );
});
