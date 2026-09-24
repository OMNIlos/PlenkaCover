import { Prisma, Role } from '@prisma/client';
import { normalizeCatalogName } from '../../modules/material-catalog/recipe-catalog.rules';

const MATERIAL_SEED_ROWS = [
  ['rmd-base-primary', 'ПВД Первичное', 'base'],
  ['rmd-base-secondary', 'ПВД Вторичное', 'base'],
  ['rmd-base-aika', 'ПВД Айка', 'base'],
  ['rmd-base-pvd-tsp', 'ПВД ТСП', 'base'],
  ['rmd-base-danaflex', 'Данафлекс', 'base'],
  ['rmd-base-stretch', 'Стрейч', 'base'],
  ['rmd-product-antiblock', 'Антиблок', 'custom'],
  ['rmd-product-antistatic', 'Антистатик', 'custom'],
  ['rmd-product-pvd-mel', 'ПВД МЕЛ', 'custom'],
  ['rmd-product-pvd-primary-108', 'ПВД Первичка 108', 'custom'],
  ['rmd-product-pvd-primary-153', 'ПВД Первичка 153', 'custom'],
  ['rmd-product-pvd-primary-tape', 'ПВД Первичка ленты', 'custom'],
  ['rmd-product-pvd-primary-ll092', 'ПВД Первичка линейка LL092', 'custom'],
  ['rmd-product-pvd-primary-blue-tape', 'ПВД Первичка синие ленты', 'custom'],
  ['rmd-product-pnd-primary', 'ПНД Первичка', 'custom'],
  ['rmd-product-pnd-primary-hd', 'ПНД Первичка HD', 'custom'],
  ['rmd-product-pp-primary', 'ПП Первичка', 'custom'],
  ['rmd-product-klinol', 'Клинол', 'custom'],
  ['rmd-product-color-yellow', 'Краситель желтый', 'custom'],
  ['rmd-product-color-white', 'Краситель белый', 'custom'],
  ['rmd-product-color-green', 'Краситель зеленый', 'custom'],
  ['rmd-product-color-orange', 'Краситель оранжевый', 'custom'],
  ['rmd-product-color-blue', 'Краситель синей', 'custom'],
  ['rmd-product-color-black', 'Краситель черный', 'custom'],
  ['rmd-product-chalk-additive', 'Меловая добавка', 'custom'],
  ['rmd-product-processing-additive', 'Процессинговая добавка', 'custom'],
  ['rmd-product-slip', 'Скользячка / слип', 'custom'],
  ['rmd-product-uv-stabilizer', 'Уф - стабилизатор', 'custom'],
] as const;

export const MATERIAL_DEFINITIONS = MATERIAL_SEED_ROWS.map(([id, name, kind]) => ({
  id,
  name,
  normalizedName: normalizeCatalogName(name),
  kind,
  status: 'active' as const,
  isProductionSelectable: true as const,
}));

export type MaterialCatalogSeedClient = Pick<
  Prisma.TransactionClient,
  'rawMaterialDefinition' | 'rawMaterialStock'
>;

export async function seedMaterialCatalog(client: MaterialCatalogSeedClient): Promise<void> {
  for (const definition of MATERIAL_DEFINITIONS) {
    await client.rawMaterialDefinition.upsert({
      where: { normalizedName: definition.normalizedName },
      create: { ...definition, createdByRole: Role.admin },
      update: {
        name: definition.name,
        normalizedName: definition.normalizedName,
        kind: definition.kind,
        status: definition.status,
        isProductionSelectable: true,
      },
    });
  }

  const stocks = await client.rawMaterialStock.findMany({
    select: {
      id: true,
      label: true,
      rawMaterialDefinitionId: true,
    },
  });
  for (const stock of stocks) {
    const normalizedName = normalizeCatalogName(stock.label);
    const definition = await client.rawMaterialDefinition.upsert({
      where: { normalizedName },
      create: {
        name: stock.label.trim(),
        normalizedName,
        kind: 'custom',
        status: 'active',
        createdByRole: Role.admin,
      },
      update: {},
    });
    if (stock.rawMaterialDefinitionId === definition.id) continue;
    await client.rawMaterialStock.update({
      where: { id: stock.id },
      data: { rawMaterialDefinitionId: definition.id },
    });
  }
}
