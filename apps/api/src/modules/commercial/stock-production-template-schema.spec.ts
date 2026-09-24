import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CAPABILITIES, DOMAIN_EVENTS, ROLE_CAPABILITIES } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260727190000_stock_production_templates/migration.sql',
);
const normalizedNameMigration = resolve(
  prismaRoot,
  'migrations/20260727211500_stock_template_normalized_name/migration.sql',
);

describe('stock production template contracts and persistence', () => {
  it('keeps template reads shared while production leads own template changes', () => {
    expect(CAPABILITIES).toEqual(
      expect.arrayContaining(['stock_production_template:read', 'stock_production_template:write']),
    );
    expect(ROLE_CAPABILITIES.commercial).toContain('stock_production_template:read');
    expect(ROLE_CAPABILITIES.commercial).not.toContain('stock_production_template:write');
    expect(ROLE_CAPABILITIES.production_lead).toEqual(
      expect.arrayContaining(['stock_production_template:read', 'stock_production_template:write']),
    );
  });

  it('registers every audited template lifecycle fact', () => {
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:stock_production_template_created',
        'audit:stock_production_template_updated',
        'audit:stock_production_template_applied',
      ]),
    );
  });

  it('persists current templates and immutable template versions', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
    const currentTemplateModel = schema.slice(
      schema.indexOf('model StockProductionTemplate {'),
      schema.indexOf('model StockProductionTemplateVersion {'),
    );

    expect(schema).toMatch(/model StockProductionTemplate \{/);
    expect(currentTemplateModel).toMatch(/normalizedName\s+String\s+@unique/);
    expect(schema).toMatch(/model StockProductionTemplateVersion \{/);
    expect(schema).toMatch(/versions\s+StockProductionTemplateVersion\[\]/);
    expect(schema).toMatch(/@@unique\(\[templateId, version\]\)/);
    expect(schema).toContain('@@map("stock_production_templates")');
    expect(schema).toContain('@@map("stock_production_template_versions")');
  });

  it('enforces the canonical template name with an atomic unique database key', () => {
    expect(existsSync(normalizedNameMigration)).toBe(true);
    if (!existsSync(normalizedNameMigration)) return;

    const sql = readFileSync(normalizedNameMigration, 'utf8');

    expect(sql).toContain('ADD COLUMN "normalizedName" TEXT');
    expect(sql).toContain('"normalizedName" = "normalize_material_catalog_name"("name")');
    expect(sql).toContain('ALTER COLUMN "normalizedName" SET NOT NULL');
    expect(sql).toContain('CREATE UNIQUE INDEX "stock_production_templates_normalizedName_key"');
    expect(sql).toContain('stock_production_templates_normalized_name_check');
  });

  it('migrates template history and restrictive order provenance additively', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');

    expect(sql).toContain('CREATE TABLE "stock_production_templates"');
    expect(sql).toContain('CREATE TABLE "stock_production_template_versions"');
    expect(sql).toContain('ADD COLUMN "stockProductionTemplateId" TEXT');
    expect(sql).toContain('ADD COLUMN "stockProductionTemplateName" TEXT');
    expect(sql).toContain('ADD COLUMN "stockProductionTemplateVersionId" TEXT');
    expect(sql).toContain('CREATE UNIQUE INDEX "stock_production_templates_name_key"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "stock_production_template_versions_templateId_version_key"',
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("stockProductionTemplateId"\)[\s\S]*REFERENCES "stock_production_templates"\("id"\)[\s\S]*ON DELETE RESTRICT/,
    );
    expect(sql).toMatch(
      /FOREIGN KEY \("stockProductionTemplateVersionId"\)[\s\S]*REFERENCES "stock_production_template_versions"\("id"\)[\s\S]*ON DELETE RESTRICT/,
    );
  });

  it('seeds one usable template and one immutable version on repeated runs', async () => {
    const { seedStockProductionTemplate } =
      await import('../../../prisma/stock-production-template-seed');
    const templates = new Map<string, Record<string, unknown>>();
    const versions = new Map<string, Record<string, unknown>>();
    const client = {
      stockProductionTemplate: {
        upsert: jest.fn(
          async ({
            where,
            update,
            create,
          }: {
            where: { id: string };
            update: Record<string, unknown>;
            create: Record<string, unknown> & { id: string };
          }) => {
            const existing = templates.get(where.id);
            if (existing) {
              Object.assign(existing, update);
              return { ...existing };
            }
            templates.set(create.id, { ...create });
            return { ...create };
          },
        ),
      },
      stockProductionTemplateVersion: {
        upsert: jest.fn(
          async ({
            where,
            update,
            create,
          }: {
            where: { templateId_version: { templateId: string; version: number } };
            update: Record<string, unknown>;
            create: Record<string, unknown> & { templateId: string; version: number };
          }) => {
            const key = `${where.templateId_version.templateId}:${where.templateId_version.version}`;
            const existing = versions.get(key);
            if (existing) {
              Object.assign(existing, update);
              return { ...existing };
            }
            versions.set(key, { ...create });
            return { ...create };
          },
        ),
      },
    };

    await seedStockProductionTemplate(client as never);
    await seedStockProductionTemplate(client as never);

    const positions = [
      {
        rollCount: 2,
        filmType: 'Рукав',
        actualThickness: '80 мкм',
        accountingThickness: '80 мкм',
        widthMm: 1700,
        plannedLengthM: 275,
        baseRawMaterialDefinitionId: 'rmd-base-primary',
        plannedWeightKg: 42.3,
        spoolType: 'Шпуля 76 мм',
        birka: 'DEMO',
        manualBirka: 'Маркировка А-17',
        comment: 'Канонический шаблон для демонстрации полного производственного контура',
        recipeParameters: [],
      },
    ];
    expect([...templates.values()]).toEqual([
      {
        id: 'stock-template-primary-80',
        name: 'Первичное полотно 80 мкм',
        normalizedName: 'первичное полотно 80 мкм',
        status: 'active',
        positions,
        createdById: null,
        version: 1,
      },
    ]);
    expect([...versions.values()]).toEqual([
      {
        templateId: 'stock-template-primary-80',
        version: 1,
        positions,
        createdById: null,
      },
    ]);
  });
});
