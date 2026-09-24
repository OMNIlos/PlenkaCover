import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PRISMA_ROOT = resolve(__dirname, '../../../prisma');
const MIGRATION_NAME = '20260802180000_onec_invoice_payment_sync';

describe('1С finance persistence contract', () => {
  const schema = readFileSync(resolve(PRISMA_ROOT, 'schema.prisma'), 'utf8');
  const migrationPath = resolve(PRISMA_ROOT, 'migrations', MIGRATION_NAME, 'migration.sql');

  it('stores the commercial note and finance money with fixed precision', () => {
    expect(schema).toMatch(/commercialFinanceNote\s+String\?\s+@db\.VarChar\(2000\)/);
    expect(schema).toMatch(/amountValue\s+Decimal\?\s+@db\.Decimal\(18,\s*2\)/);
    expect(schema).toMatch(/amount\s+Decimal\s+@db\.Decimal\(18,\s*2\)/);
  });

  it('defines receipt and append-only allocation entities', () => {
    expect(schema).toContain('model PaymentReceipt {');
    expect(schema).toContain('model FinancePaymentAllocation {');
    expect(schema).toMatch(/allocationKey\s+String\s+@unique\s+@db\.Char\(64\)/);
    expect(schema).toContain('reversesId');
  });

  it('ships a forward-only migration with decimal conversions and new tables', () => {
    expect(existsSync(migrationPath)).toBe(true);
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('DECIMAL(18,2)');
    expect(migration).toContain('finance_payment_receipts');
    expect(migration).toContain('finance_payment_allocations');
    expect(migration).toContain('ROUND("amount"::numeric, 2)');
  });
});
