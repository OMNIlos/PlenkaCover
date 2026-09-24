import { RollTokenService } from './roll-token.service';

describe('RollTokenService', () => {
  const token = `prt_${'a'.repeat(64)}`;

  it('uses the database default and returns the existing immutable token', async () => {
    const prisma = {
      rollScanToken: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ rollCode: 'ROLL-1', token }),
      },
    };
    const service = new RollTokenService(prisma as never);

    await expect(service.getOrCreate('ROLL-1')).resolves.toEqual({ rollCode: 'ROLL-1', token });
    expect(prisma.rollScanToken.createMany).toHaveBeenCalledWith({
      data: { rollCode: 'ROLL-1' },
      skipDuplicates: true,
    });
    expect(prisma.rollScanToken.createMany.mock.calls[0][0].data).not.toHaveProperty('token');
  });

  it('looks up exact bytes without normalization', async () => {
    const prisma = {
      rollScanToken: {
        findUnique: jest.fn().mockResolvedValue({ rollCode: 'ROLL-1' }),
      },
    };
    const service = new RollTokenService(prisma as never);

    await expect(service.findExact(token)).resolves.toEqual({ rollCode: 'ROLL-1' });
    expect(prisma.rollScanToken.findUnique).toHaveBeenCalledWith({
      where: { token },
      select: { rollCode: true },
    });
  });
});
