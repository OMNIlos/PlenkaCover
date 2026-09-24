import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260810130000_counterparty_inn_uniqueness/migration.sql',
);
const indexName = 'counterparties_manual_inn_key';
const canonicalExpression = `upper(regexp_replace(btrim("inn"), '[[:space:]]+', '', 'g'))`;

function counterpartyModel(schema: string): string {
  const match = /model Counterparty \{(?<body>[\s\S]*?)\n\}/u.exec(schema);
  if (!match?.groups?.body) throw new Error('Counterparty model is missing from Prisma schema');
  return match.groups.body;
}

describe('counterparty canonical manual INN persistence', () => {
  it('preserves nullable INN and KPP in the Prisma identity contract', () => {
    const model = counterpartyModel(readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8'));
    expect(model).toMatch(/inn\s+String\?/u);
    expect(model).toMatch(/kpp\s+String\?/u);
  });

  it('fails before normalization when existing manual canonical INNs collide', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    const preflight = sql.indexOf('HAVING COUNT(*) > 1');
    const normalization = sql.indexOf('UPDATE "counterparties"');
    const uniqueIndex = sql.indexOf(`CREATE UNIQUE INDEX "${indexName}"`);

    expect(sql).toContain(canonicalExpression);
    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(normalization).toBeGreaterThan(preflight);
    expect(uniqueIndex).toBeGreaterThan(normalization);
    expect(sql.slice(0, normalization)).toContain(`"billingSource" = 'manual_platform'`);
    expect(sql).toContain('duplicate canonical counterparty INN');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/\bIF\s+NOT\s+EXISTS\b/iu);
  });

  it('canonicalizes and deduplicates only manual quick-create INNs', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain(`NULLIF(${canonicalExpression}, '')`);
    const index = sql.slice(sql.indexOf(`CREATE UNIQUE INDEX "${indexName}"`));
    expect(index).toContain(canonicalExpression);
    expect(index).toContain(`WHERE "billingSource" = 'manual_platform'`);
    expect(index).toContain('AND "inn" IS NOT NULL');
    expect(sql).not.toContain('counterparties_inn_canonical_check');
    expect(sql).not.toMatch(/ADD\s+CONSTRAINT[\s\S]*CHECK/iu);
    expect(sql.trim()).toMatch(/^BEGIN;/u);
    expect(sql.trim()).toMatch(/COMMIT;$/u);
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE)\b/iu);
  });
});
