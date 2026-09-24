import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAIN_EVENTS, ROLE_CAPABILITIES } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260806040000_production_cost_inputs/migration.sql',
);

describe('production cost input persistence', () => {
  it('grants cost management only to finance and defines both audit facts', () => {
    expect(ROLE_CAPABILITIES.finance).toContain('material_cost:manage');
    for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) {
      if (role !== 'finance') expect(capabilities).not.toContain('material_cost:manage');
    }
    expect(DOMAIN_EVENTS).toContain('audit:material_cost_reference_updated');
    expect(DOMAIN_EVENTS).toContain('audit:additional_production_cost_recorded');
  });

  it('keeps price and additional-cost facts append-only and idempotent', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model MaterialPriceReference {');
    expect(schema).toContain('model AdditionalProductionCost {');
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/g);
    expect(schema).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/g);
    expect(schema).toContain('@@unique([rawMaterialDefinitionId, effectiveFrom])');
  });

  it('enforces positive price and an exclusive, allocation-compatible cost target', () => {
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('material_price_references_price_positive_ck');
    expect(sql).toContain('additional_production_costs_amount_nonnegative_ck');
    expect(sql).toContain('additional_production_costs_target_ck');
    expect(sql).toContain(`"allocationBasis" = 'direct'`);
    expect(sql).toContain(`"allocationBasis" = 'finished_net_kg'`);
    expect(sql).not.toMatch(
      /UPDATE\s+"(?:material_price_references|additional_production_costs)"/u,
    );
    expect(sql).not.toMatch(/DELETE\s+FROM/u);
  });
});
