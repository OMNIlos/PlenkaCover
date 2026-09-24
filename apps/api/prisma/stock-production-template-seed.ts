import { Prisma } from '@prisma/client';
import { seedCanonicalStockProductionTemplates } from '../src/common/seed/canonical-pilot-templates';

type StockProductionTemplateSeedClient = Pick<
  Prisma.TransactionClient,
  'stockProductionTemplate' | 'stockProductionTemplateVersion'
>;

export async function seedStockProductionTemplate(
  client: StockProductionTemplateSeedClient,
): Promise<void> {
  await seedCanonicalStockProductionTemplates(client);
}
