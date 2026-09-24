import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20260804204500_warehouse_coverage_dimension_policy_v2/migration.sql',
);

describe('warehouse coverage dimension policy migration', () => {
  it('preserves published V1 facts while making new V2 dimensions database-valid', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');

    expect(sql).toContain(
      'DROP CONSTRAINT "warehouse_coverage_calculations_policy_version_ck"',
    );
    expect(sql).toMatch(
      /CHECK\s*\(\s*"policyVersion" IN \(\s*'warehouse-coverage-policy\/v1',\s*'warehouse-coverage-policy\/v2'\s*\)\s*\)/u,
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_fact"()');
    expect(sql).toContain("'widthMilliMm'");
    expect(sql).toContain("'plannedLengthMilliM'");
    expect(sql).toContain("IS DISTINCT FROM 'warehouse-coverage-policy/v2'");
    expect(sql).toMatch(/widthMilliMm'\)::numeric NOT BETWEEN 1 AND 9007199254740991/u);
    expect(sql).toMatch(/plannedLengthMilliM'\)::numeric NOT BETWEEN 1 AND 9007199254740991/u);
    expect(sql).not.toMatch(/(?:UPDATE|DELETE FROM)\s+"warehouse_roll_coverage_facts"/u);
    expect(sql).not.toContain('DISABLE TRIGGER');
  });
});
