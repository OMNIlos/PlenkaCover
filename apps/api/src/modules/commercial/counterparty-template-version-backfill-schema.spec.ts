import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = resolve(
  __dirname,
  '../../../prisma/migrations/20260826120000_backfill_counterparty_template_versions/migration.sql',
);

describe('counterparty template version backfill', () => {
  it('creates only a missing immutable snapshot for the active root version', () => {
    expect(existsSync(migration)).toBe(true);
    const sql = readFileSync(migration, 'utf8');

    expect(sql).toContain('INSERT INTO "counterparty_order_template_versions"');
    expect(sql).toContain('template."positions"');
    expect(sql).toContain('version."version" = template."version"');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('ON CONFLICT ("templateId", "version") DO NOTHING');
  });
});
