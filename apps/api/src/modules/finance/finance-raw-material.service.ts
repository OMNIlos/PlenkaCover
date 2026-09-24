import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { valueBigBag } from '../../common/money/big-bag-valuation';
import { PrismaService } from '../../common/prisma/prisma.service';

const MAX_FINANCE_BIG_BAGS = 5_000;

function kgFromGrams(grams: number): string {
  return (grams / 1_000).toFixed(3);
}

function grams(value: number): number {
  return Math.round(value * 1_000);
}

function rubles(kopecks: number | null): string | null {
  return kopecks === null ? null : (kopecks / 100).toFixed(2);
}

@Injectable()
export class FinanceRawMaterialService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const count = await this.prisma.bigBagUnit.count();
    if (count > MAX_FINANCE_BIG_BAGS) {
      throw new UnprocessableEntityException({
        code: 'FINANCE_BIG_BAG_CATALOG_TOO_LARGE',
        message: 'Слишком много партий сырья для безопасной выдачи.',
      });
    }
    const rows = await this.prisma.bigBagUnit.findMany({
      select: {
        id: true,
        code: true,
        material: true,
        supplierName: true,
        batchCode: true,
        receivedAt: true,
        initialKg: true,
        currentKg: true,
        lastMeasuredKg: true,
        lastMeasuredAt: true,
        lastWarehouseMeasuredKg: true,
        lastWarehouseMeasuredAt: true,
        priceKopecksPerKg: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    return rows.map((row) => {
      const initialGrams = row.initialKg === null ? null : grams(row.initialKg);
      const warehouseMeasuredAt = row.lastWarehouseMeasuredAt?.getTime() ?? -1;
      const measuredAt = row.lastMeasuredAt?.getTime() ?? -1;
      const useProductionMeasurement = measuredAt > warehouseMeasuredAt;
      const currentKg = useProductionMeasurement
        ? (row.lastMeasuredKg ?? row.currentKg ?? row.lastWarehouseMeasuredKg ?? null)
        : (row.lastWarehouseMeasuredKg ?? row.currentKg ?? row.lastMeasuredKg ?? null);
      const currentGrams = currentKg === null ? null : grams(currentKg);
      const consumedGrams =
        initialGrams === null || currentGrams === null ? null : initialGrams - currentGrams;
      const initialValue =
        initialGrams === null
          ? null
          : valueBigBag({
              kg: initialGrams / 1_000,
              priceKopecksPerKg: row.priceKopecksPerKg,
            }).totalKopecks;
      const currentValue =
        currentGrams === null
          ? null
          : valueBigBag({
              kg: currentGrams / 1_000,
              priceKopecksPerKg: row.priceKopecksPerKg,
            }).totalKopecks;
      const consumedValue =
        consumedGrams === null || consumedGrams < 0
          ? null
          : valueBigBag({
              kg: consumedGrams / 1_000,
              priceKopecksPerKg: row.priceKopecksPerKg,
            }).totalKopecks;

      return {
        id: row.id,
        code: row.code,
        material: row.material,
        supplier: row.supplierName,
        batchCode: row.batchCode,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        initialWeightKg: initialGrams === null ? null : kgFromGrams(initialGrams),
        purchasePricePerKg:
          row.priceKopecksPerKg === null ? null : (row.priceKopecksPerKg / 100).toFixed(2),
        initialValue: rubles(initialValue),
        currentWeightKg: currentGrams === null ? null : kgFromGrams(currentGrams),
        measuredAt: useProductionMeasurement
          ? (row.lastMeasuredAt?.toISOString() ?? null)
          : (row.lastWarehouseMeasuredAt?.toISOString() ??
            row.lastMeasuredAt?.toISOString() ??
            null),
        currentValue: rubles(currentValue),
        consumedWeightKg:
          consumedGrams === null || consumedGrams < 0 ? null : kgFromGrams(consumedGrams),
        consumedValue: rubles(consumedValue),
      };
    });
  }
}
