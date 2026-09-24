import { Prisma } from '@prisma/client';
import { withSerializableRetry } from './admin-transaction';

describe('withSerializableRetry', () => {
  it('retries one P2034 serialization failure', async () => {
    const work = jest.fn();
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('conflict', {
            code: 'P2034',
            clientVersion: 'test',
          }),
        )
        .mockResolvedValueOnce('ok'),
    };
    await expect(withSerializableRetry(prisma as never, work)).resolves.toBe('ok');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
