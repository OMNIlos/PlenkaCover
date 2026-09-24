import { Prisma, Role } from '@prisma/client';

type CanonicalTemplateSeedClient = Pick<
  Prisma.TransactionClient,
  | 'counterpartyOrderTemplate'
  | 'counterpartyOrderTemplateVersion'
  | 'stockProductionTemplate'
  | 'stockProductionTemplateVersion'
>;

type CanonicalStockTemplateSeedClient = Pick<
  Prisma.TransactionClient,
  'stockProductionTemplate' | 'stockProductionTemplateVersion'
>;

export const CANONICAL_COUNTERPARTY_TEMPLATE_IDS = [
  'tpl-uralpak-sleeve-80',
  'tpl-uralpak-sleeve-60',
] as const;

export const CANONICAL_STOCK_TEMPLATE_IDS = ['stock-template-primary-80'] as const;

export const PILOT_TEMPLATE_POSITIONS = [
  {
    rollCount: 2,
    filmType: 'Рукав',
    actualThickness: '80 мкм',
    accountingThickness: '80 мкм',
    widthMm: 1700,
    plannedLengthM: 275,
    plannedWeightKg: 42.3,
    baseRawMaterialDefinitionId: 'rmd-base-primary',
    spoolType: 'Шпуля 76 мм',
    birka: 'DEMO',
    manualBirka: 'Маркировка А-17',
    comment: 'Канонический шаблон для демонстрации полного производственного контура',
    recipeParameters: [],
  },
] as const;

const COUNTERPARTY_TEMPLATES = [
  {
    id: CANONICAL_COUNTERPARTY_TEMPLATE_IDS[0],
    name: 'УралПак · рукав 80 мкм',
    positions: [
      {
        rollCount: 3,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '80 мкм',
        widthMm: 1700,
        plannedLengthM: 275,
        plannedWeightKg: 41.2,
        rawMaterialId: 'rm-pvd-15803',
        spoolType: 'Шпуля 76 мм',
        birka: 'Прозрачный',
        manualBirka: 'Маркировка А-17',
        comment: 'Комментарий для производства',
        recipeParameters: [
          { label: 'Тип пленки', value: 'Рукав' },
          { label: 'Толщина', value: '80 мкм' },
          { label: 'Ширина', value: '1700 мм' },
          { label: 'Метраж', value: '275 м' },
          { label: 'Сырье', value: 'М1 по шаблону' },
          { label: 'Втулка', value: '76 мм' },
        ],
      },
    ],
  },
  {
    id: CANONICAL_COUNTERPARTY_TEMPLATE_IDS[1],
    name: 'УралПак · рукав 60 мкм',
    positions: [
      {
        rollCount: 2,
        filmType: 'Рукав',
        actualThickness: '60 мкм',
        accountingThickness: '60 мкм',
        widthMm: 1500,
        plannedLengthM: 300,
        plannedWeightKg: 35,
        rawMaterialId: 'rm-pvd-15803',
        spoolType: 'Шпуля 76 мм',
        birka: 'Молочный',
        manualBirka: 'Маркировка М-60',
        comment: 'Канонический шаблон рукава 60 мкм',
        recipeParameters: [
          { label: 'Тип пленки', value: 'Рукав' },
          { label: 'Толщина', value: '60 мкм' },
          { label: 'Ширина', value: '1500 мм' },
          { label: 'Метраж', value: '300 м' },
          { label: 'Сырье', value: 'М1 по шаблону' },
          { label: 'Втулка', value: '76 мм' },
        ],
      },
    ],
  },
] as const;

const STOCK_TEMPLATES = [
  {
    id: CANONICAL_STOCK_TEMPLATE_IDS[0],
    name: 'Первичное полотно 80 мкм',
    normalizedName: 'первичное полотно 80 мкм',
    positions: PILOT_TEMPLATE_POSITIONS,
  },
] as const;

export interface CanonicalPilotTemplateSeedOptions {
  counterpartyId: string;
  createdById?: string | null;
}

export async function seedCanonicalPilotTemplates(
  client: CanonicalTemplateSeedClient,
  options: CanonicalPilotTemplateSeedOptions,
): Promise<void> {
  const createdById = options.createdById ?? null;
  for (const definition of COUNTERPARTY_TEMPLATES) {
    const positions = definition.positions as unknown as Prisma.InputJsonValue;
    const template = await client.counterpartyOrderTemplate.upsert({
      where: { id: definition.id },
      update: {
        counterpartyId: options.counterpartyId,
        name: definition.name,
        status: 'active',
        ownerRole: Role.production_lead,
        positions,
        createdById,
        version: 1,
      },
      create: {
        id: definition.id,
        counterpartyId: options.counterpartyId,
        name: definition.name,
        status: 'active',
        ownerRole: Role.production_lead,
        positions,
        createdById,
        version: 1,
      },
    });
    await client.counterpartyOrderTemplateVersion.upsert({
      where: { templateId_version: { templateId: template.id, version: 1 } },
      update: { positions, createdById },
      create: {
        templateId: template.id,
        version: 1,
        positions,
        createdById,
      },
    });
  }
  await seedCanonicalStockProductionTemplates(client, createdById);
}

export async function seedCanonicalStockProductionTemplates(
  client: CanonicalStockTemplateSeedClient,
  createdById: string | null = null,
): Promise<void> {
  for (const definition of STOCK_TEMPLATES) {
    const positions = definition.positions as unknown as Prisma.InputJsonValue;
    const template = await client.stockProductionTemplate.upsert({
      where: { id: definition.id },
      update: {
        name: definition.name,
        normalizedName: definition.normalizedName,
        status: 'active',
        positions,
        createdById,
        version: 1,
      },
      create: {
        id: definition.id,
        name: definition.name,
        normalizedName: definition.normalizedName,
        status: 'active',
        positions,
        createdById,
        version: 1,
      },
    });
    await client.stockProductionTemplateVersion.upsert({
      where: { templateId_version: { templateId: template.id, version: 1 } },
      update: { positions, createdById },
      create: {
        templateId: template.id,
        version: 1,
        positions,
        createdById,
      },
    });
  }
}
