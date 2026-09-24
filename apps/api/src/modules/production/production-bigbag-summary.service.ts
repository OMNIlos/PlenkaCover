import { Injectable } from '@nestjs/common';
import type {
  ProductionBigBagClassification,
  ProductionBigBagSummary,
  ProductionBigBagSummaryItem,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';

const COMPLETED_DISPATCH_STATUSES = ['ready_for_warehouse', 'done', 'defect'] as const;

@Injectable()
export class ProductionBigBagSummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary(): Promise<ProductionBigBagSummary> {
    const unitsPromise = this.prisma.bigBagUnit.findMany({
      where: {
        status: { in: ['available', 'in_use'] },
        registrationStatus: 'registered',
        location: 'production',
      },
      select: {
        id: true,
        code: true,
        material: true,
        baseRawMaterialDefinitionId: true,
        status: true,
        currentKg: true,
        shiftUsages: {
          where: { closedAt: null },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { code: 'asc' },
    });
    const activeDispatchPositions = await this.prisma.rollDispatchItem.findMany({
      where: {
        orderLineId: { not: null },
        status: { notIn: [...COMPLETED_DISPATCH_STATUSES] },
      },
      select: { orderLineId: true },
      distinct: ['orderLineId'],
    });
    const positionIds = activeDispatchPositions
      .map(({ orderLineId }) => orderLineId)
      .filter((id): id is string => id != null);
    const positionsPromise =
      positionIds.length === 0
        ? Promise.resolve([])
        : this.prisma.commercialOrderPosition.findMany({
            where: { id: { in: positionIds } },
            select: {
              id: true,
              baseRawMaterialDefinitionId: true,
              recipeDefinitionVersion: {
                select: {
                  ingredients: {
                    select: { rawMaterialDefinitionId: true },
                  },
                },
              },
            },
          });
    const [positions, units] = await Promise.all([positionsPromise, unitsPromise]);

    const requiredMaterialIds = new Set<string>();
    for (const position of positions) {
      if (position.baseRawMaterialDefinitionId) {
        requiredMaterialIds.add(position.baseRawMaterialDefinitionId);
      }
      for (const ingredient of position.recipeDefinitionVersion?.ingredients ?? []) {
        requiredMaterialIds.add(ingredient.rawMaterialDefinitionId);
      }
    }

    const bags = units.map<ProductionBigBagSummaryItem>((unit) => {
      const classification = this.classify(
        unit.status === 'in_use' || unit.shiftUsages.length > 0,
        unit.baseRawMaterialDefinitionId,
        requiredMaterialIds,
      );
      return {
        id: unit.id,
        code: unit.code,
        material: unit.material,
        materialDefinitionId: unit.baseRawMaterialDefinitionId,
        status: unit.status as ProductionBigBagSummaryItem['status'],
        currentKg: unit.currentKg,
        classification,
      };
    });
    const returnCandidates = bags.filter((bag) => bag.classification === 'idle_not_required');
    const inUse = bags.filter((bag) => bag.classification === 'in_use').length;

    return {
      counts: {
        total: bags.length,
        inUse,
        idle: bags.length - inUse,
        notRequired: returnCandidates.length,
      },
      bags,
      returnCandidates,
      generatedAt: new Date().toISOString(),
    };
  }

  private classify(
    inUse: boolean,
    materialDefinitionId: string | null,
    requiredMaterialIds: ReadonlySet<string>,
  ): ProductionBigBagClassification {
    if (inUse) return 'in_use';
    if (!materialDefinitionId) return 'idle_unclassified';
    return requiredMaterialIds.has(materialDefinitionId) ? 'idle_required' : 'idle_not_required';
  }
}
