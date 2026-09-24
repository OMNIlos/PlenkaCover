import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PILOT_RUNTIME_DELETE_TABLES,
  PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS,
} from '../../common/seed/pilot-demo-reset';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(prismaRoot, 'migrations/20260806230000_pallet_scan_tokens/migration.sql');

describe('pallet scan token persistence', () => {
  it('models one opaque token per immutable pallet-list document', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(/model PalletListDocument \{[\s\S]*scanToken\s+PalletScanToken\?/);
    expect(schema).toMatch(/model PalletScanToken \{[\s\S]*documentId\s+String\s+@id/);
    expect(schema).toMatch(
      /token\s+String\s+@unique\s+@default\(dbgenerated\([\s\S]*@db\.VarChar\(68\)/,
    );
    expect(schema).toContain('@@map("pallet_scan_tokens")');
  });

  it('backfills legacy documents and makes token rows immutable', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('CREATE TABLE "pallet_scan_tokens"');
    expect(sql).toContain(`CHECK ("token" ~ '^plt_[0-9a-f]{64}$')`);
    expect(sql).toContain('REFERENCES "pallet_list_documents"("id")');
    expect(sql).toMatch(
      /INSERT INTO "pallet_scan_tokens" \("documentId"\)\s+SELECT "id"\s+FROM "pallet_list_documents"/,
    );
    expect(sql).toContain('ON CONFLICT ("documentId") DO NOTHING');
    expect(sql).toContain('AFTER INSERT ON "pallet_list_documents"');
    expect(sql).toContain('ensure_pallet_scan_token');
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "pallet_scan_tokens"');
    expect(sql).toContain('pallet scan tokens are immutable');
  });

  it('applies the table, trigger functions and legacy backfill atomically', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const statements = readFileSync(migration, 'utf8').trim();
    expect(statements).toMatch(/^BEGIN;\s/);
    expect(statements).toMatch(/\sCOMMIT;$/);
    expect(statements.indexOf('BEGIN;')).toBeLessThan(
      statements.indexOf('CREATE TABLE "pallet_scan_tokens"'),
    );
    expect(statements.indexOf('INSERT INTO "pallet_scan_tokens"')).toBeLessThan(
      statements.lastIndexOf('COMMIT;'),
    );
    expect(statements.indexOf('CREATE TRIGGER "pallet_scan_tokens_immutable"')).toBeLessThan(
      statements.lastIndexOf('COMMIT;'),
    );
  });

  it('keeps the pilot reset compatible with the immutable child table', () => {
    expect(PILOT_RUNTIME_DELETE_TABLES.indexOf('pallet_scan_tokens')).toBeLessThan(
      PILOT_RUNTIME_DELETE_TABLES.indexOf('pallet_list_documents'),
    );
    expect(PILOT_RUNTIME_DISABLE_TRIGGER_STATEMENTS).toContain(
      'ALTER TABLE "pallet_scan_tokens" DISABLE TRIGGER USER',
    );
  });
});
