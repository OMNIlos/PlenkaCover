import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(prismaRoot, 'migrations/20260808060000_add_shift_bigbag_episodes/migration.sql'),
  'utf8',
);

describe('shift BigBag episode persistence', () => {
  it('adds one immutable episode history behind every stable session-to-bag link', () => {
    expect(schema).toContain('model ShiftBagUsageEpisode {');
    expect(schema).toMatch(/episodes\s+ShiftBagUsageEpisode\[\]/u);
    expect(schema).toContain('@@unique([usageId, sequence])');
    expect(migration).toContain('shift_bag_usage_episodes_one_open_per_usage_idx');
    expect(migration).toContain('INSERT INTO "shift_bag_usage_episodes"');
  });

  it('preflights old facts and never rewrites or removes the stable usage data', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain(
      'existing shift BigBag usage cannot be represented as an immutable episode',
    );
    expect(migration).not.toMatch(/UPDATE\s+"shift_bag_usages"/iu);
    expect(migration).not.toMatch(/DELETE\s+FROM/iu);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/iu);
  });

  it('rejects update/delete/truncate of confirmed episode history at the database boundary', () => {
    expect(migration).toContain('shift_bag_usage_episodes_history_guard');
    expect(migration).toContain("IF TG_OP IN ('DELETE', 'TRUNCATE') THEN");
    expect(migration).toContain('shift_bag_usage_episodes_no_truncate');
    expect(migration).toContain('BEFORE TRUNCATE ON "shift_bag_usage_episodes"');
  });
});
