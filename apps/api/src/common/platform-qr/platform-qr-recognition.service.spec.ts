import { PlatformQrRecognitionService } from './platform-qr-recognition.service';

const ROLL_TOKEN = `prt_${'a'.repeat(64)}`;
const BIG_BAG_TOKEN = `bbt_${'b'.repeat(64)}`;
const PALLET_TOKEN = `plt_${'c'.repeat(64)}`;

function harness() {
  const prisma = {
    rollScanToken: { findUnique: jest.fn() },
    bigBagScanToken: { findUnique: jest.fn() },
    palletScanToken: { findUnique: jest.fn() },
  };
  return {
    prisma,
    service: new PlatformQrRecognitionService(prisma as never),
  };
}

describe('PlatformQrRecognitionService', () => {
  it('recognizes the stable roll QR into a safe canonical identity', async () => {
    const { prisma, service } = harness();
    prisma.rollScanToken.findUnique.mockResolvedValue({
      roll: { id: 'roll-1', rollCode: 'ROLL-0001' },
    });

    const result = await service.resolve(ROLL_TOKEN);

    expect(result).toEqual({
      outcome: 'recognized',
      object: { kind: 'roll', objectId: 'roll-1', code: 'ROLL-0001' },
    });
    expect(prisma.rollScanToken.findUnique).toHaveBeenCalledWith({
      where: { token: ROLL_TOKEN },
      select: { roll: { select: { id: true, rollCode: true } } },
    });
    expect(JSON.stringify(result)).not.toContain(ROLL_TOKEN);
  });

  it('recognizes the stable Big-Bag QR without returning token or lifecycle internals', async () => {
    const { prisma, service } = harness();
    prisma.bigBagScanToken.findUnique.mockResolvedValue({
      bigBag: { id: 'bag-1', code: 'BB-ПВД-01', material: 'ПВД первичный' },
    });

    const result = await service.resolve(BIG_BAG_TOKEN);

    expect(result).toEqual({
      outcome: 'recognized',
      object: {
        kind: 'big_bag',
        objectId: 'bag-1',
        code: 'BB-ПВД-01',
        material: 'ПВД первичный',
      },
    });
    expect(prisma.bigBagScanToken.findUnique).toHaveBeenCalledWith({
      where: { token: BIG_BAG_TOKEN },
      select: { bigBag: { select: { id: true, code: true, material: true } } },
    });
    expect(JSON.stringify(result)).not.toMatch(/bbt_|registrationStatus|location|rawPayload/u);
  });

  it('recognizes the stable pallet-list QR into document ID and pallet number', async () => {
    const { prisma, service } = harness();
    prisma.palletScanToken.findUnique.mockResolvedValue({
      document: { id: 'document-1', palletId: 'PAL-0007' },
    });

    const result = await service.resolve(PALLET_TOKEN);

    expect(result).toEqual({
      outcome: 'recognized',
      object: { kind: 'pallet', objectId: 'document-1', code: 'PAL-0007' },
    });
    expect(prisma.palletScanToken.findUnique).toHaveBeenCalledWith({
      where: { token: PALLET_TOKEN },
      select: { document: { select: { id: true, palletId: true } } },
    });
    expect(JSON.stringify(result)).not.toMatch(/plt_|payload|rollIds|orderIds/u);
  });

  it('distinguishes an unsupported payload from a missing object of a known QR kind', async () => {
    const { prisma, service } = harness();
    prisma.bigBagScanToken.findUnique.mockResolvedValue(null);

    await expect(service.resolve('BB-ПВД-01')).resolves.toEqual({ outcome: 'invalid' });
    await expect(service.resolve(BIG_BAG_TOKEN)).resolves.toEqual({
      outcome: 'not_found',
      kind: 'big_bag',
    });
    expect(prisma.rollScanToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.palletScanToken.findUnique).not.toHaveBeenCalled();
  });
});
