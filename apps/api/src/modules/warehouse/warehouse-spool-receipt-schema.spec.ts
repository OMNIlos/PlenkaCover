import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PILOT_ORDER_PURGE_DELETE_TABLES,
  PILOT_ORDER_PURGE_PRESERVED_TABLES,
} from '../../common/seed/pilot-order-history-purge';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migrationPath = resolve(
  prismaRoot,
  'migrations/20260822010000_spool_stock_receipts/migration.sql',
);
const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('warehouse spool receipt schema', () => {
  it('defines an append-only receipt ledger with bounded quantities and restricted actors', () => {
    expect(schema).toContain('model SpoolStockReceipt {');
    expect(migration).toContain('CREATE TABLE "spool_stock_receipts"');
    expect(migration).toContain('"spool_stock_receipts_quantity_positive_ck"');
    expect(migration).toContain('"spool_stock_receipts_operationKey_key"');
    expect(migration).toContain('"spool_stock_receipts_priceReferenceId_fkey"');
    expect(migration).toContain('"spool_stock_receipts_receivedById_fkey"');
    expect(migration).toContain('"spool_stock_receipts_append_only"');
    expect(migration).toContain('"spool_stock_receipts_no_truncate"');
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('preserves receipt facts during the optional pilot order purge', () => {
    expect(PILOT_ORDER_PURGE_PRESERVED_TABLES).toContain('spool_stock_receipts');
    expect(PILOT_ORDER_PURGE_DELETE_TABLES).not.toContain('spool_stock_receipts');
  });
});
