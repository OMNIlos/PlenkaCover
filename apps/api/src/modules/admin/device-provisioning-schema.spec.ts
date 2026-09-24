import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260804173000_device_runtime_fail_closed_default/migration.sql',
);

describe('fail-closed device provisioning schema', () => {
  it('defaults every newly inserted device to offline at both Prisma and database levels', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(/model DeviceRuntime \{[\s\S]*status\s+String\s+@default\("offline"\)/);
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toMatch(
      /ALTER TABLE "device_runtimes"\s+ALTER COLUMN "status" SET DEFAULT 'offline';/,
    );
    expect(sql).not.toMatch(/UPDATE\s+"device_runtimes"/i);
  });
});
