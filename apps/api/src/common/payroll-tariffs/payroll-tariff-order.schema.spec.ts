import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AUDIT_SYSTEM_ACTOR_KEYS,
  PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY,
} from '../audit/audit-actor';

const PRISMA_ROOT = resolve(__dirname, '../../../prisma');
const MIGRATION_PATH = resolve(
  PRISMA_ROOT,
  'migrations/20260813140000_payroll_tariff_orders/migration.sql',
);
const schema = readFileSync(resolve(PRISMA_ROOT, 'schema.prisma'), 'utf8');
const migration = existsSync(MIGRATION_PATH) ? readFileSync(MIGRATION_PATH, 'utf8') : '';

describe('payroll tariff order persistence', () => {
  it('declares versioned orders and an append-only command journal with restrictive actors', () => {
    expect(schema).toMatch(/model PayrollTariffOrder \{/u);
    expect(schema).toMatch(/effectiveFrom\s+DateTime\s+@db\.Timestamptz\(3\)/u);
    expect(schema).toMatch(/matrix\s+Json/u);
    expect(schema).toMatch(/revision\s+Int\s+@default\(1\)/u);
    expect(schema).toMatch(
      /createdBy\s+User\?\s+@relation\("PayrollTariffOrderCreator",[\s\S]*onDelete: Restrict\)/u,
    );
    expect(schema).toMatch(
      /updatedBy\s+User\?\s+@relation\("PayrollTariffOrderUpdater",[\s\S]*onDelete: Restrict\)/u,
    );
    expect(schema).toMatch(
      /publishedBy\s+User\?\s+@relation\("PayrollTariffOrderPublisher",[\s\S]*onDelete: Restrict\)/u,
    );

    expect(schema).toMatch(/model PayrollTariffOrderCommand \{/u);
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/u);
    expect(schema).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/u);
    expect(schema).toMatch(/order\s+PayrollTariffOrder\s+@relation\([\s\S]*onDelete: Restrict\)/u);
    expect(schema).toMatch(
      /actor\s+User\s+@relation\("PayrollTariffOrderCommandActor",[\s\S]*onDelete: Restrict\)/u,
    );
  });

  it('creates additive tables, exact lifecycle checks, and resolver indexes', () => {
    expect(migration).toContain('CREATE TABLE "payroll_tariff_orders"');
    expect(migration).toContain('CREATE TABLE "payroll_tariff_order_commands"');
    expect(migration).toMatch(/status" IN \('draft', 'published'\)/u);
    expect(migration).toMatch(/currency" = 'RUB'/u);
    expect(migration).toMatch(/revision" >= 1/u);
    expect(migration).toMatch(/action" IN \('create', 'update', 'publish'\)/u);
    expect(migration).toMatch(/requestFingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/u);
    expect(migration).toContain('payroll_tariff_orders_published_effective_from_uq');
    expect(migration).toMatch(
      /UNIQUE INDEX "payroll_tariff_orders_published_effective_from_uq"[\s\S]*WHERE "status" = 'published'/u,
    );
    expect(migration).toMatch(
      /INDEX "payroll_tariff_orders_schedule_idx"[\s\S]*"status", "effectiveFrom" DESC, "id"/u,
    );
    expect(migration).toContain('payroll_tariff_order_commands_operationKey_key');
  });

  it('uses only RESTRICT foreign keys and protects immutable command and published history', () => {
    const foreignKeys = migration.match(/FOREIGN KEY[\s\S]*?;/gu) ?? [];
    expect(foreignKeys).toHaveLength(5);
    for (const foreignKey of foreignKeys) {
      expect(foreignKey).toContain('ON DELETE RESTRICT');
    }
    expect(migration).toContain('payroll_tariff_order_commands_append_only');
    expect(migration).toContain('payroll_tariff_order_commands_no_truncate');
    expect(migration).toContain('payroll_tariff_orders_lifecycle_guard');
    expect(migration).toContain('payroll_tariff_orders_no_truncate');
  });

  it('bootstraps one exact system-authored order without destructive data SQL', () => {
    expect(AUDIT_SYSTEM_ACTOR_KEYS).toContain(PAYROLL_TARIFF_BOOTSTRAP_SYSTEM_ACTOR_KEY);
    expect(migration).toContain('payroll-tariff-order-8-09-25-2025-09-29');
    expect(migration).toContain('2025-09-28 21:00:00+00');
    expect(migration).toContain('audit:payroll_tariff_order_created');
    expect(migration).toContain("'payroll_tariff_bootstrap'");
    expect(migration).not.toMatch(/^\s*(?:UPDATE|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/gimu);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)\b/iu);
    expect(migration).not.toMatch(
      /ALTER\s+TABLE\s+"(?:operator_shift_close_commands|roll_production_cost_snapshots)"/iu,
    );
  });
});
