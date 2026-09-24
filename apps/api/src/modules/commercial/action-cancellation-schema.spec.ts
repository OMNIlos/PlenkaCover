import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DISPATCH_ITEM_STATUSES,
  DOMAIN_EVENTS,
  ORDER_CANCELLATION_STATUSES,
} from '@plenka/contracts';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260804210000_safe_action_corrections/migration.sql',
);

describe('safe action correction persistence', () => {
  it('publishes cancellation statuses and durable audit facts', () => {
    expect(ORDER_CANCELLATION_STATUSES).toEqual(['active', 'cancelled']);
    expect(DISPATCH_ITEM_STATUSES).toContain('cancelled');
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'audit:finance_production_cleared',
        'audit:commercial_order_amended',
        'audit:commercial_amendment_reconciled',
        'audit:commercial_order_cancelled',
        'audit:commercial_order_reactivated',
        'audit:manual_payment_corrected',
        'audit:operator_shift_machine_assignment_cancelled',
        'notification:commercial_order_amended',
        'notification:commercial_order_cancelled',
        'notification:commercial_order_reactivated',
        'notification:operator_machine_change_cancelled',
      ]),
    );
  });

  it('defines additive order, finance and machine cancellation state', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(/cancellationStatus\s+String\s+@default\("active"\)/);
    expect(schema).toMatch(/cancellationVersion\s+Int\s+@default\(1\)/);
    expect(schema).toMatch(/cancelledAt\s+DateTime\?/);
    expect(schema).toMatch(/cancelledById\s+String\?/);
    expect(schema).toMatch(/cancellationReason\s+String\?\s+@db\.VarChar\(500\)/);
    expect(schema).toMatch(/productionClearedAt\s+DateTime\?/);
    expect(schema).toContain('model CommercialOrderAmendmentCommand {');
    expect(schema).toContain('model FinancePaymentCorrectionCommand {');
    expect(schema).toContain('model OperatorShiftMachineAssignmentCancellationCommand {');
    expect(schema).toMatch(/reversesOperationId\s+String\?\s+@unique/);
    expect(schema).toMatch(/paymentScheduleId\s+String\?/);
    expect(schema).toMatch(/cancelOperationKey\s+String\?\s+@unique\s+@db\.Uuid/);
  });

  it('migrates atomically, backfills only proven clearance and installs active-only indexes', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;
    const sql = readFileSync(migration, 'utf8');

    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('CREATE TABLE "commercial_order_amendment_commands"');
    expect(sql).toContain('CREATE TABLE "finance_payment_correction_commands"');
    expect(sql).toContain('CREATE TABLE "operator_shift_machine_assignment_cancellation_commands"');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "operator_shift_machine_assignments_active_shift_operator_uq"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "operator_shift_machine_assignments_active_shift_post_uq"',
    );
    expect(sql).toContain(`WHERE "status" IN ('planned', 'locked', 'breakdown_reassigned')`);
    expect(sql).toContain('DROP INDEX "operator_shift_machine_assignments_shiftId_operatorId_key"');
    expect(sql).toContain('DROP INDEX "operator_shift_machine_assignments_shiftId_postId_key"');
    expect(sql).toContain('SET "productionClearedAt" = COALESCE(');
    expect(sql).toContain('EXISTS (\n      SELECT 1\n      FROM "production_orders" AS po');
    expect(sql).toContain(`fo."invoiceStatus" = 'invoiced'`);
    expect(sql).toContain(`schedule."kind" = 'invoice_prepayment'`);
    expect(sql).toContain(`schedule."status" = 'paid'`);
    expect(sql).not.toMatch(/"paymentStatus"\s*=\s*'paid'/);
    expect(sql).not.toMatch(/INSERT INTO "payment_operations"/);
    expect(sql).not.toMatch(/INSERT INTO "domain_events"/);
  });
});
