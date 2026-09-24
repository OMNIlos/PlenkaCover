import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260810140000_gateway_command_utc_clock/migration.sql',
);

describe('gateway command UTC-naive database clock', () => {
  it('makes the deadline default independent from the PostgreSQL session timezone', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain(`ALTER COLUMN "deadlineAt" SET DEFAULT`);
    expect(sql).toContain(`ALTER COLUMN "createdAt" SET DEFAULT`);
    expect(sql).toContain(`clock_timestamp() AT TIME ZONE 'UTC'`);
  });

  it('replaces the legacy lease trigger with the same UTC clock domain', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "gateway_commands_legacy_lease_compat"()');
    expect(sql).toContain(`clock_timestamp() AT TIME ZONE 'UTC'`);
    expect(sql).not.toMatch(/clock_timestamp\(\)(?!\s+AT TIME ZONE 'UTC')/gu);
    expect(sql.trim()).toMatch(/^BEGIN;/u);
    expect(sql.trim()).toMatch(/COMMIT;$/u);
  });
});
