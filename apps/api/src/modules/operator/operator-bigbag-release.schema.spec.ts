import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('operator BigBag release movement schema', () => {
  it('allows the new append-only fact while retaining all legacy movement kinds', () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../../prisma/migrations/20260811100000_canonical_order_receiving_scope/migration.sql',
      ),
      'utf8',
    );

    expect(migration).toContain('DROP CONSTRAINT "big_bag_movements_kind_check"');
    expect(migration).toContain(
      "CHECK (\"kind\" IN ('registration', 'to_production', 'to_warehouse', 'operator_shift_release'))",
    );
    expect(migration).not.toMatch(
      /UPDATE\s+"big_bag_movements"|DELETE\s+FROM\s+"big_bag_movements"/u,
    );
  });
});
