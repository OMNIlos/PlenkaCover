import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260810100000_raw_material_global_operation_key/migration.sql',
);
const indexName = 'domain_events_raw_material_operation_key_key';

function domainEventModel(schema: string): string {
  const match = /model DomainEvent \{(?<body>[\s\S]*?)\n\}/u.exec(schema);
  if (!match?.groups?.body) throw new Error('DomainEvent model is missing from Prisma schema');
  return match.groups.body;
}

describe('global raw-material operation key persistence', () => {
  it('keeps the expression-index source fields in the append-only DomainEvent model', () => {
    const model = domainEventModel(readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8'));

    expect(model).toMatch(/type\s+String/u);
    expect(model).toMatch(/objectId\s+String\?/u);
    expect(model).toMatch(/actorRole\s+Role\?/u);
    expect(model).toMatch(/actorId\s+String\?/u);
    expect(model).toMatch(/detail\s+Json\?/u);
    expect(model).toMatch(/reason\s+String\?/u);
    expect(model).toContain('@@map("domain_events")');
  });

  it('fails migration on an existing cross-kind or cross-material duplicate before indexing', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    const duplicateGuard = sql.indexOf('HAVING COUNT(*) > 1');
    const indexCreation = sql.indexOf(`CREATE UNIQUE INDEX "${indexName}"`);

    expect(duplicateGuard).toBeGreaterThanOrEqual(0);
    expect(indexCreation).toBeGreaterThan(duplicateGuard);
    expect(sql).toContain(`'audit:inventory_manual_correction'`);
    expect(sql).toContain(`'audit:raw_material_received'`);
    expect(sql).toContain(`lower("detail"->>'operationKey')`);
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain('duplicate raw-material operationKey');
    expect(sql.trim()).toMatch(/^BEGIN;/u);
    expect(sql.trim()).toMatch(/COMMIT;$/u);
    expect(sql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/iu);
    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/iu);
  });

  it('creates one global partial unique expression index without object scoping', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toMatch(
      new RegExp(
        `CREATE UNIQUE INDEX "${indexName}"[\\s\\S]*ON "domain_events" \\(\\(lower\\("detail"->>'operationKey'\\)\\)\\)[\\s\\S]*WHERE "type" IN \\(`,
        'u',
      ),
    );
    expect(sql).toContain(`"detail" ? 'operationKey'`);
    expect(sql).not.toMatch(new RegExp(`CREATE UNIQUE INDEX "${indexName}"[^;]*"objectId"`, 'u'));
  });
});
