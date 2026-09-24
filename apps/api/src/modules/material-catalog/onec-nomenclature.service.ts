import { Injectable } from '@nestjs/common';
import type { OneCNomenclatureListItem } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OneCNomenclatureQueryDto } from './dto/onec-nomenclature-query.dto';

export interface OneCNomenclaturePage {
  items: OneCNomenclatureListItem[];
  page: number;
  pageSize: number;
  total: number;
}

@Injectable()
export class OneCNomenclatureService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: OneCNomenclatureQueryDto): Promise<OneCNomenclaturePage> {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 50));
    const search = query.search?.trim().slice(0, 100);
    const where = {
      deleted: false,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' as const } },
              { code: { contains: search, mode: 'insensitive' as const } },
              { article: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const select = {
      externalId: true,
      code: true,
      article: true,
      name: true,
      kindName: true,
      unitName: true,
      archived: true,
    } as const;
    const [items, total] = await Promise.all([
      this.prisma.oneCNomenclatureItem.findMany({
        where,
        select,
        orderBy: [{ name: 'asc' }, { externalId: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.oneCNomenclatureItem.count({ where }),
    ]);
    return {
      items: items.map((item) => ({
        externalId: item.externalId,
        code: item.code,
        article: item.article,
        name: item.name,
        kindName: item.kindName,
        unitName: item.unitName,
        archived: item.archived,
      })),
      page,
      pageSize,
      total,
    };
  }
}
