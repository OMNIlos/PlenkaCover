import { PalletTokenService } from './pallet-token.service';

describe('PalletTokenService', () => {
  const token = `plt_${'a'.repeat(64)}`;

  it('returns the existing document-bound token without a runtime write', async () => {
    const prisma = {
      palletScanToken: {
        findUnique: jest.fn().mockResolvedValue({ documentId: 'document-1', token }),
      },
    };
    const service = new PalletTokenService(prisma as never);

    await expect(service.requireForDocument('document-1')).resolves.toEqual({
      documentId: 'document-1',
      token,
    });
    expect(prisma.palletScanToken.findUnique).toHaveBeenCalledWith({
      where: { documentId: 'document-1' },
      select: { documentId: true, token: true },
    });
  });

  it('fails closed when the migration invariant is broken', async () => {
    const prisma = {
      palletScanToken: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new PalletTokenService(prisma as never);

    await expect(service.requireForDocument('document-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PALLET_SCAN_TOKEN_UNAVAILABLE' }),
    });
  });
});
