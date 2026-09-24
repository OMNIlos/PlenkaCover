import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type PlatformQrKind = 'roll' | 'big_bag' | 'pallet';

export type PlatformQrObject =
  | { kind: 'roll'; objectId: string; code: string }
  | { kind: 'big_bag'; objectId: string; code: string; material: string }
  | { kind: 'pallet'; objectId: string; code: string };

export type PlatformQrResolution =
  | { outcome: 'invalid' }
  | { outcome: 'not_found'; kind: PlatformQrKind }
  | { outcome: 'recognized'; object: PlatformQrObject };

const ROLL_TOKEN = /^prt_[0-9a-f]{64}$/u;
const BIG_BAG_TOKEN = /^bbt_[0-9a-f]{64}$/u;
const PALLET_TOKEN = /^plt_[0-9a-f]{64}$/u;

@Injectable()
export class PlatformQrRecognitionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(payload: string): Promise<PlatformQrResolution> {
    if (ROLL_TOKEN.test(payload)) return this.resolveRoll(payload);
    if (BIG_BAG_TOKEN.test(payload)) return this.resolveBigBag(payload);
    if (PALLET_TOKEN.test(payload)) return this.resolvePallet(payload);
    return { outcome: 'invalid' };
  }

  private async resolveRoll(payload: string): Promise<PlatformQrResolution> {
    const record = await this.prisma.rollScanToken.findUnique({
      where: { token: payload },
      select: { roll: { select: { id: true, rollCode: true } } },
    });
    return record
      ? {
          outcome: 'recognized',
          object: { kind: 'roll', objectId: record.roll.id, code: record.roll.rollCode },
        }
      : { outcome: 'not_found', kind: 'roll' };
  }

  private async resolveBigBag(payload: string): Promise<PlatformQrResolution> {
    const record = await this.prisma.bigBagScanToken.findUnique({
      where: { token: payload },
      select: { bigBag: { select: { id: true, code: true, material: true } } },
    });
    return record
      ? {
          outcome: 'recognized',
          object: {
            kind: 'big_bag',
            objectId: record.bigBag.id,
            code: record.bigBag.code,
            material: record.bigBag.material,
          },
        }
      : { outcome: 'not_found', kind: 'big_bag' };
  }

  private async resolvePallet(payload: string): Promise<PlatformQrResolution> {
    const record = await this.prisma.palletScanToken.findUnique({
      where: { token: payload },
      select: { document: { select: { id: true, palletId: true } } },
    });
    return record
      ? {
          outcome: 'recognized',
          object: { kind: 'pallet', objectId: record.document.id, code: record.document.palletId },
        }
      : { outcome: 'not_found', kind: 'pallet' };
  }
}
