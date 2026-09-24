import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20260807010000_warehouse_coverage_order_spec_invalidation/migration.sql',
);

describe('warehouse coverage order-spec invalidation migration', () => {
  it('adds one exact refreshable state without weakening immutable facts or inventory epochs', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');

    expect(sql).toContain("'order_spec_changed'");
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_state"()');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION "warehouse_coverage_validate_roll"()');
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION "warehouse_coverage_assert_decision_set"(decision_id UUID)',
    );
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER "warehouse_coverage_order_change_retirement_deferred"',
    );
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain(
      'current_position_versions IS NOT DISTINCT FROM calculation."positionVersions"',
    );
    expect(sql).toContain('OLD."state" <> \'order_spec_changed\'');
    expect(sql).toContain('"producedByCoverageDecisionId" = OLD."currentDecisionId"');
    expect(sql).toContain('"status" = \'cancelled\'');
    expect(sql).toContain('state."state" = \'order_spec_changed\'');
    expect(sql).toContain('OLD."state" = \'order_spec_changed\'');
    expect(sql).toContain('order_row."cancellationStatus" <> \'active\'');
    expect(sql).not.toMatch(
      /(?:UPDATE|DELETE FROM)\s+"warehouse_coverage_(?:calculations|decisions)"/u,
    );
    expect(sql).not.toMatch(/UPDATE\s+"warehouse_coverage_inventory_epochs"\s+SET\s+"epoch"/u);
    expect(sql).not.toContain('DISABLE TRIGGER');
  });
});
