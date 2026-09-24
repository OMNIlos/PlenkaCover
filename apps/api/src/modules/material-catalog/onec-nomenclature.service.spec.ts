import { OneCNomenclatureService } from './onec-nomenclature.service';

describe('OneCNomenclatureService', () => {
  it('returns a bounded, deterministic and raw-free generic 1C catalog page', async () => {
    const prisma = {
      oneCNomenclatureItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            externalId: 'aaaaaaaa-1111-4111-8111-111111111111',
            code: '00-000001',
            article: 'ПВД-020',
            name: 'ПВД 15803-020',
            kindName: 'Сырье',
            unitName: 'кг',
            archived: false,
            deleted: false,
            syncedAt: new Date('2026-07-29T08:00:00.000Z'),
            rawPayload: { secret: true },
            purpose: 'hidden financial text',
          },
        ]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new OneCNomenclatureService(prisma as never);

    const result = await service.list({
      page: 2,
      pageSize: 999,
      search: `  ${'П'.repeat(120)}  `,
    });

    expect(result).toEqual({
      items: [
        {
          externalId: 'aaaaaaaa-1111-4111-8111-111111111111',
          code: '00-000001',
          article: 'ПВД-020',
          name: 'ПВД 15803-020',
          kindName: 'Сырье',
          unitName: 'кг',
          archived: false,
        },
      ],
      page: 2,
      pageSize: 100,
      total: 1,
    });
    expect(prisma.oneCNomenclatureItem.findMany).toHaveBeenCalledWith({
      where: {
        deleted: false,
        OR: [
          { name: { contains: 'П'.repeat(100), mode: 'insensitive' } },
          { code: { contains: 'П'.repeat(100), mode: 'insensitive' } },
          { article: { contains: 'П'.repeat(100), mode: 'insensitive' } },
        ],
      },
      select: {
        externalId: true,
        code: true,
        article: true,
        name: true,
        kindName: true,
        unitName: true,
        archived: true,
      },
      orderBy: [{ name: 'asc' }, { externalId: 'asc' }],
      skip: 100,
      take: 100,
    });
    expect(JSON.stringify(result)).not.toMatch(/rawPayload|purpose|syncedAt|deleted/);
  });
});
