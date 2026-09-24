import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = readFileSync(
  resolve(prismaRoot, 'migrations/20260809193000_warehouse_browser_capture_context/migration.sql'),
  'utf8',
);
const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

function model(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, 'u'));
  if (!match) throw new Error(`Missing Prisma model ${name}`);
  return match[0];
}

describe('warehouse browser capture persistence', () => {
  it('allows browser-HID and role actions without borrowing a production post', () => {
    const operation = model('WarehouseOperation');

    expect(operation).toMatch(/postId\s+String\?/u);
    expect(operation).toMatch(/post\s+Post\?/u);
    expect(operation).toMatch(/captureChannel\s+String\s+@default\("machine_post_gateway"\)/u);
    expect(migration).toContain('ALTER COLUMN "postId" DROP NOT NULL');
    expect(migration).toContain(
      'ADD COLUMN "captureChannel" TEXT NOT NULL DEFAULT \'machine_post_gateway\'',
    );
    expect(migration).toContain('"warehouse_operations_capture_channel_check"');
    expect(migration).toContain("'warehouse_browser_hid'");
    expect(migration).toContain("'machine_post_gateway'");
    expect(migration).toContain("'warehouse_role_action'");
  });

  it('is additive and never rewrites or deletes warehouse facts', () => {
    expect(migration).toContain('BEGIN;');
    expect(migration).toContain('COMMIT;');
    expect(migration).not.toMatch(/DELETE\s+FROM|TRUNCATE|DROP\s+(?:TABLE|COLUMN)/iu);
    expect(migration).not.toMatch(/UPDATE\s+"warehouse_operations"/iu);
  });
});
