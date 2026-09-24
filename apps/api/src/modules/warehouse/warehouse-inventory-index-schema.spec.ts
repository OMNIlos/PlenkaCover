import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260807070000_warehouse_inventory_received_at_cursor_index/migration.sql',
);
const indexName = 'warehouse_rolls_inventory_received_at_id_idx';

function warehouseRollModel(schema: string): string {
  const match = /model WarehouseRoll \{(?<body>[\s\S]*?)\n\}/u.exec(schema);
  if (!match?.groups?.body) throw new Error('WarehouseRoll model is missing from Prisma schema');
  return match.groups.body;
}

describe('warehouse inventory cursor index', () => {
  it('maps the receivedAt and id cursor index without duplicating the unique rollCode index', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
    const model = warehouseRollModel(schema);

    expect(model).toContain(`@@index([receivedAt, id], map: "${indexName}")`);
    expect(model).not.toMatch(/@@index\(\[rollCode,\s*id\]/u);
  });

  it('creates exactly one nonblocking additive index outside a transaction', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql.trim()).toBe(
      `CREATE INDEX CONCURRENTLY "${indexName}"\n` + '  ON "warehouse_rolls" ("receivedAt", "id");',
    );
    expect(sql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/iu);
    expect(sql).not.toMatch(/\b(?:BEGIN|COMMIT|ALTER|DROP|DELETE|UPDATE|INSERT|TRUNCATE)\b/iu);
    expect(sql).not.toContain('"rollCode"');
  });
});
