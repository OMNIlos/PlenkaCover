import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('warehouse receiving scope schema', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(
    join(
      process.cwd(),
      'prisma/migrations/20260811100000_canonical_order_receiving_scope/migration.sql',
    ),
    'utf8',
  );

  it('uses one additive nullable unique key without deleting legacy receiving facts', () => {
    const taskModel = schema.match(/model WarehouseAcceptanceTask \{[\s\S]*?\n\}/u)?.[0] ?? '';

    expect(taskModel).toMatch(/receivingScopeKey\s+String\?\s+@unique/u);
    expect(taskModel).toContain('rows                  ScanRow[]');
    expect(migration).toContain('ADD COLUMN "receivingScopeKey" TEXT');
    expect(migration).toContain('warehouse_acceptance_tasks_receivingScopeKey_key');
    expect(migration).not.toMatch(
      /UPDATE\s+"warehouse_acceptance_tasks"|DELETE\s+FROM\s+"warehouse_acceptance_tasks"/u,
    );
  });
});
