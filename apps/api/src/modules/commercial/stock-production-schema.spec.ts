import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const shiftMigration = resolve(
  prismaRoot,
  'migrations/20260727120000_individual_shifts_machine_change/migration.sql',
);
const stockMigration = resolve(
  prismaRoot,
  'migrations/20260727130000_stock_production_foundation/migration.sql',
);

describe('individual shift and stock production persistence', () => {
  it('keeps legacy shifts readable and persists intentional machine changes', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model OperatorMachineChange');
    expect(schema).toMatch(/plannedStartAt\s+DateTime\?/);
    expect(schema).toMatch(/plannedEndAt\s+DateTime\?/);
    expect(schema).toMatch(/operationKey\s+String\s+@unique/);
    expect(schema).toContain('@@map("operator_machine_changes")');
  });

  it('supports counterparty-free stock orders and finished-stock provenance', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(/counterpartyId\s+String\?/);
    expect(schema).toMatch(/counterparty\s+Counterparty\?/);
    expect(schema).toMatch(/stockBatchCode\s+String\?\s+@unique/);
    expect(schema).toMatch(/stockProductionTemplateId\s+String\?/);
    expect(schema).toMatch(/stockProductionTemplateName\s+String\?/);
    expect(schema).toMatch(/stockProductionTemplateVersionId\s+String\?/);
    expect(schema).toContain('@@index([requestType, stockProductionTemplateId])');
    expect(schema).toMatch(/producedForStockOrderId\s+String\?/);
    expect(schema).toContain('@@index([producedForStockOrderId');
  });

  it('uses additive migrations with the generated table and column names', () => {
    const shiftSql = readFileSync(shiftMigration, 'utf8');
    const stockSql = readFileSync(stockMigration, 'utf8');

    expect(shiftSql).toContain('ALTER TABLE "shifts" ALTER COLUMN "plannedStartAt" DROP NOT NULL;');
    expect(shiftSql).toContain('ALTER TABLE "shifts" ALTER COLUMN "plannedEndAt" DROP NOT NULL;');
    expect(shiftSql).toContain('CREATE UNIQUE INDEX "operator_machine_changes_operation_key_key"');
    expect(stockSql).toContain(
      'ALTER TABLE "commercial_orders" ALTER COLUMN "counterpartyId" DROP NOT NULL;',
    );
    expect(stockSql).toContain('ADD COLUMN "stockBatchCode" TEXT');
    expect(stockSql).toContain('ADD COLUMN "producedForStockOrderId" TEXT');
    expect(stockSql).toMatch(
      /REFERENCES "commercial_orders"\("id"\)\s+ON DELETE RESTRICT ON UPDATE CASCADE/,
    );
  });
});
