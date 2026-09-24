import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LABEL_LIFECYCLE } from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260717120000_operator_physical_state_integrity/migration.sql',
);
const leaseMigration = resolve(
  prismaRoot,
  'migrations/20260723120000_operator_operation_leases/migration.sql',
);
const qrVerifyLeaseMigration = resolve(
  prismaRoot,
  'migrations/20260804183000_operator_qr_verify_physical_lease/migration.sql',
);

describe('operator physical operation persistence', () => {
  it('publishes delivery_unknown in the shared label lifecycle contract', () => {
    expect(LABEL_LIFECYCLE).toContain('delivery_unknown');
    expect(LABEL_LIFECYCLE).toContain('submitted');
  });

  it('defines a durable journal and immutable evidence correlation', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
    expect(schema).toContain('model OperatorRollOperation {');
    expect(schema).toMatch(/operationKey\s+String\s+@unique/);
    expect(schema).toMatch(/operationId\s+String\?\s+@unique/);
    expect(schema).toMatch(/operation\s+OperatorRollOperation\?/);
  });

  it('preflights ambiguous enabled bindings before installing partial uniqueness', () => {
    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain('Ambiguous enabled device bindings');
    expect(sql).toContain('operator_roll_operations_one_in_progress_per_line');
    expect(sql).toContain('device_runtimes_one_enabled_kind_per_post');
    expect(sql).toContain('WHERE "status" = \'in_progress\'');
    expect(sql).toContain('WHERE "isEnabled" = true AND "postId" IS NOT NULL');
  });

  it('installs physical leases atomically after rejecting unfenced in-flight work', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');
    const sql = readFileSync(leaseMigration, 'utf8');

    expect(schema).toMatch(/attempt\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/leaseToken\s+String\?\s+@db\.Uuid/);
    expect(schema).toMatch(/leaseExpiresAt\s+DateTime\?/);
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('LOCK TABLE "operator_roll_operations"');
    expect(sql).toContain('Unfenced in-progress operator physical operations exist');
    expect(sql).toContain('operator_roll_operations_physical_lease_check');
    expect(sql).toContain('COMMIT;');
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('ALTER TABLE'));
  });

  it('keeps QR scanner verification inside the physical lease constraint', () => {
    const sql = readFileSync(qrVerifyLeaseMigration, 'utf8');
    const dropConstraint = sql.indexOf(
      'DROP CONSTRAINT "operator_roll_operations_physical_lease_check"',
    );
    const backfill = sql.indexOf('UPDATE "operator_roll_operations"');
    const addConstraint = sql.indexOf(
      'ADD CONSTRAINT "operator_roll_operations_physical_lease_check"',
    );

    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('LOCK TABLE "operator_roll_operations"');
    expect(sql).toContain("'qr_verify'");
    expect(sql).toContain('Unfenced in-progress QR verification exists');
    expect(sql).toContain('operator_roll_operations_physical_lease_check');
    expect(sql).toContain('COMMIT;');
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('ALTER TABLE'));
    expect(dropConstraint).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(dropConstraint);
    expect(addConstraint).toBeGreaterThan(backfill);
  });
});
