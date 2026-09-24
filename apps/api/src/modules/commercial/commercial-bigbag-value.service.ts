import { Injectable } from '@nestjs/common';
import type { CommercialBigBagValue } from '@plenka/contracts';
import { valueBigBag } from '../../common/money/big-bag-valuation';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class CommercialBigBagValueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<CommercialBigBagValue[]> {
    const bags = await this.prisma.bigBagUnit.findMany({
      where: { status: { in: ['available', 'in_use'] } },
      select: {
        id: true,
        code: true,
        material: true,
        status: true,
        location: true,
        initialKg: true,
        currentKg: true,
        lastMeasuredKg: true,
        lastMeasuredAt: true,
        priceKopecksPerKg: true,
        priceEffectiveAt: true,
      },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
    });

    return bags.map((bag) => {
      const currentKg = bag.currentKg ?? bag.lastMeasuredKg ?? bag.initialKg ?? 0;
      return {
        id: bag.id,
        code: bag.code,
        material: bag.material,
        status: bag.status as CommercialBigBagValue['status'],
        location: bag.location as CommercialBigBagValue['location'],
        currentKg,
        currentMeasuredAt: bag.lastMeasuredAt?.toISOString() ?? null,
        ...valueBigBag({
          kg: currentKg,
          priceKopecksPerKg: bag.priceKopecksPerKg,
        }),
        priceEffectiveAt: bag.priceEffectiveAt?.toISOString() ?? null,
      };
    });
  }
}
