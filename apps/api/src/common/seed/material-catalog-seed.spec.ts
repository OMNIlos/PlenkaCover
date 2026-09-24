import { MATERIAL_DEFINITIONS, seedMaterialCatalog } from './material-catalog-seed';

type Definition = {
  id: string;
  name: string;
  normalizedName: string;
  kind: string;
  status: string;
  isProductionSelectable: boolean;
  createdByRole: string;
};

type Stock = {
  id: string;
  label: string;
  rawMaterialDefinitionId: string | null;
};

function createHarness() {
  const definitions = new Map<string, Definition>();
  const stocks: Stock[] = [
    {
      id: 'stock-primary-polyethylene',
      label: 'ПВД 15803-020',
      rawMaterialDefinitionId: null,
    },
    {
      id: 'stock-secondary-polyethylene',
      label: 'ПВД 10803-020',
      rawMaterialDefinitionId: null,
    },
  ];
  let customSequence = 0;

  const prisma = {
    rawMaterialDefinition: {
      findUnique: jest.fn(
        async ({ where }: { where: { normalizedName: string } }) =>
          [...definitions.values()].find(
            (definition) => definition.normalizedName === where.normalizedName,
          ) ?? null,
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<Definition> }) => {
          const definition = definitions.get(where.id);
          if (!definition) throw new Error(`Unknown definition ${where.id}`);
          Object.assign(definition, data);
          return { ...definition };
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id?: string; normalizedName?: string };
          create: Omit<Definition, 'id' | 'isProductionSelectable'> & {
            id?: string;
            isProductionSelectable?: boolean;
          };
          update: Partial<Definition>;
        }) => {
          const existing = where.id
            ? definitions.get(where.id)
            : [...definitions.values()].find(
                (definition) => definition.normalizedName === where.normalizedName,
              );
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }

          const definition: Definition = {
            id: create.id ?? `custom-definition-${++customSequence}`,
            name: create.name,
            normalizedName: create.normalizedName,
            kind: create.kind,
            status: create.status,
            isProductionSelectable: create.isProductionSelectable ?? false,
            createdByRole: create.createdByRole,
          };
          definitions.set(definition.id, definition);
          return { ...definition };
        },
      ),
      count: jest.fn(
        async ({ where }: { where: { kind: string } }) =>
          [...definitions.values()].filter((definition) => definition.kind === where.kind).length,
      ),
    },
    rawMaterialStock: {
      findMany: jest.fn(async () => stocks.map((stock) => ({ ...stock }))),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { rawMaterialDefinitionId: string };
        }) => {
          const stock = stocks.find((candidate) => candidate.id === where.id);
          if (!stock) throw new Error(`Unknown stock ${where.id}`);
          stock.rawMaterialDefinitionId = data.rawMaterialDefinitionId;
          return { ...stock };
        },
      ),
      count: jest.fn(
        async ({ where }: { where: { rawMaterialDefinitionId: null } }) =>
          stocks.filter((stock) => stock.rawMaterialDefinitionId === where.rawMaterialDefinitionId)
            .length,
      ),
    },
  };

  return { definitions, prisma, stocks };
}

describe('seedMaterialCatalog', () => {
  it('upserts the exact deduplicated shared catalog and links every stock once', async () => {
    const { definitions, prisma, stocks } = createHarness();

    await seedMaterialCatalog(prisma as never);
    const firstLinks = stocks.map((stock) => stock.rawMaterialDefinitionId);
    await seedMaterialCatalog(prisma as never);

    expect(await prisma.rawMaterialDefinition.count({ where: { kind: 'base' } })).toBe(6);
    expect(await prisma.rawMaterialStock.count({ where: { rawMaterialDefinitionId: null } })).toBe(
      0,
    );
    expect(prisma.rawMaterialStock.update).toHaveBeenCalledTimes(stocks.length);
    expect(stocks.map((stock) => stock.rawMaterialDefinitionId)).toEqual(firstLinks);
    expect(definitions.size).toBe(MATERIAL_DEFINITIONS.length + stocks.length);
    expect(MATERIAL_DEFINITIONS).toHaveLength(28);
    expect(new Set(MATERIAL_DEFINITIONS.map(({ normalizedName }) => normalizedName)).size).toBe(28);
    expect(
      [...definitions.values()].filter(({ isProductionSelectable }) => isProductionSelectable),
    ).toEqual(
      MATERIAL_DEFINITIONS.map((definition) => ({
        ...definition,
        createdByRole: 'admin',
      })),
    );
    expect(MATERIAL_DEFINITIONS.map(({ name }) => name)).toEqual([
      'ПВД Первичное',
      'ПВД Вторичное',
      'ПВД Айка',
      'ПВД ТСП',
      'Данафлекс',
      'Стрейч',
      'Антиблок',
      'Антистатик',
      'ПВД МЕЛ',
      'ПВД Первичка 108',
      'ПВД Первичка 153',
      'ПВД Первичка ленты',
      'ПВД Первичка линейка LL092',
      'ПВД Первичка синие ленты',
      'ПНД Первичка',
      'ПНД Первичка HD',
      'ПП Первичка',
      'Клинол',
      'Краситель желтый',
      'Краситель белый',
      'Краситель зеленый',
      'Краситель оранжевый',
      'Краситель синей',
      'Краситель черный',
      'Меловая добавка',
      'Процессинговая добавка',
      'Скользячка / слип',
      'Уф - стабилизатор',
    ]);
  });
});
