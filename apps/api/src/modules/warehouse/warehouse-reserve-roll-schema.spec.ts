import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOMAIN_EVENTS, ROLE_CAPABILITIES } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260806030000_platform_reserve_roll/migration.sql',
);
const coverageFactSourceMigration = resolve(
  prismaRoot,
  'migrations/20260806060000_warehouse_coverage_manual_platform_fact_source/migration.sql',
);

describe('platform reserve roll persistence', () => {
  it('gates the warehouse command and publishes its audit fact', () => {
    expect(ROLE_CAPABILITIES.warehouse).toContain('reserve_roll:create');
    expect(DOMAIN_EVENTS).toContain('audit:warehouse_reserve_roll_created');
  });

  it('stores one bounded idempotency result per physical roll', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toContain('model WarehouseReserveRollCommand {');
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/);
    expect(schema).toMatch(/rollId\s+String\s+@unique/);
    expect(schema).toMatch(/sourcePositionId\s+String\s+@unique/);
    expect(schema).toMatch(/resultSnapshot\s+Json/);
  });

  it('adds only the command journal and restrictive foreign keys', () => {
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE "warehouse_reserve_roll_commands"');
    expect(sql).toContain('"warehouse_reserve_roll_commands_operationKey_key"');
    expect(sql).toContain('"warehouse_reserve_roll_commands_rollId_key"');
    expect(sql).toContain('"warehouse_reserve_roll_commands_sourcePositionId_key"');
    expect(sql).toContain('REFERENCES "warehouse_rolls"("id")');
    expect(sql).toContain('REFERENCES "commercial_orders"("id")');
    expect(sql).toContain('REFERENCES "commercial_order_positions"("id")');
    expect(sql).not.toMatch(/UPDATE\s+"warehouse_rolls"/u);
    expect(sql).not.toMatch(/DELETE\s+FROM/u);
  });

  it('allows manual platform reserve facts without recasting their provenance', () => {
    const sql = readFileSync(coverageFactSourceMigration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('DROP CONSTRAINT "warehouse_coverage_facts_source_ck"');
    expect(sql).toContain('ADD CONSTRAINT "warehouse_coverage_facts_source_ck"');
    expect(sql).toMatch(
      /CHECK\s*\(\s*"source" IN \(\s*'production_handover',\s*'warehouse_recheck',\s*'migration_backfill',\s*'manual_platform'\s*\)\s*\)/u,
    );
    expect(sql).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+"warehouse_roll_coverage_facts"/u);
  });
});
