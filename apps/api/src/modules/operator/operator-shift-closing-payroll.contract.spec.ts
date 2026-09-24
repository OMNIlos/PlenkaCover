import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperatorShiftClosingPayroll, OperatorShiftCloseResult } from '@plenka/contracts';
import { validate } from 'class-validator';
import { CloseShiftDto } from './dto/shift.dto';

const ROOT = join(__dirname, '../../..');
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260808070000_add_operator_shift_close_commands/migration.sql'),
  'utf8',
);
const ORDER_REFERENCE_MIGRATION = readFileSync(
  join(
    ROOT,
    'prisma/migrations/20260813150000_operator_shift_close_payroll_order_refs/migration.sql',
  ),
  'utf8',
);

describe('operator shift closing payroll contract', () => {
  it('requires a UUID idempotency key on every close request', async () => {
    const missing = Object.assign(new CloseShiftDto(), { bags: [] });
    const invalid = Object.assign(new CloseShiftDto(), {
      operationKey: 'not-a-uuid',
      bags: [],
    });
    const valid = Object.assign(new CloseShiftDto(), {
      operationKey: '11111111-1111-4111-8111-111111111111',
      bags: [],
    });

    expect((await validate(missing)).map(({ property }) => property)).toContain('operationKey');
    expect((await validate(invalid)).map(({ property }) => property)).toContain('operationKey');
    expect((await validate(valid)).map(({ property }) => property)).not.toContain('operationKey');
  });

  it('keeps the existing payroll rows and summary without inventing one aggregate rate', () => {
    const closingPayroll = {
      sessionId: 'session-1',
      shiftId: 'shift-1',
      status: 'complete',
      appliedTariffOrders: [
        {
          id: 'payroll-tariff-order-8-09-25-2025-09-29',
          name: 'Приказ № 8-09/25',
          effectiveFrom: '2025-09-29',
          currency: 'RUB',
        },
      ],
      summary: {
        payableAmountKopecks: 12_300,
        payableKg: 41,
        machineShiftCount: 1,
        unresolvedKg: 0,
        unresolvedFactCount: 0,
        excludedDefectKg: 2,
        excludedDefectRollCount: 1,
      },
      breakdown: [
        {
          id: 'row-1',
          tariffOrderId: 'payroll-tariff-order-8-09-25-2025-09-29',
          shiftId: 'shift-1',
          shiftLabel: 'Смена 1',
          shiftDate: '2026-08-08',
          postId: 'post-1',
          postCode: 'POST-1',
          postName: 'Экструдер 1',
          machineFamily: 'urp',
          shiftDuration: '12h',
          shiftOutputKg: 41,
          payableKg: 41,
          rateKopecksPerKg: 300,
          amountKopecks: 12_300,
          tariffRule: 'primary',
          basisLabel: 'Базовый тариф',
          materialClass: null,
          filmClass: null,
          specialCustomer: false,
        },
      ],
      unresolved: [],
    } satisfies OperatorShiftClosingPayroll;

    const result = {
      balance: {
        producedKg: 41,
        defectKg: 2,
        expectedUsageKg: 41,
        actualUsageKg: 41,
        deviationPercent: 0,
        status: 'ok',
      },
      problemId: null,
      releasedRollIds: [],
      closingPayroll,
    } satisfies OperatorShiftCloseResult;

    expect(result.closingPayroll.breakdown).toHaveLength(1);
    expect(result.closingPayroll.appliedTariffOrders).toHaveLength(1);
    expect(result.closingPayroll).not.toHaveProperty('rateKopecksPerKg');
    expect(result.closingPayroll).not.toHaveProperty('basisLabel');
  });

  it('stores one durable replayable close result with referential ownership', () => {
    expect(SCHEMA).toContain('model OperatorShiftCloseCommand {');
    expect(SCHEMA).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/u);
    expect(SCHEMA).toMatch(/requestFingerprint\s+String\s+@db\.Char\(64\)/u);
    expect(SCHEMA).toMatch(/resultSnapshot\s+Json/u);
    expect(SCHEMA).toMatch(/operatorId\s+String/u);
    expect(SCHEMA).toMatch(/sessionId\s+String\s+@unique/u);
    expect(SCHEMA).toMatch(/assignmentId\s+String\s+@unique/u);
    expect(SCHEMA).toMatch(/shiftId\s+String/u);
    expect(SCHEMA).toMatch(/postId\s+String/u);
    expect(SCHEMA).toMatch(/actorRole\s+Role/u);
  });

  it('uses an additive migration with restrictive foreign keys and immutable history', () => {
    expect(MIGRATION.trimStart()).toMatch(/^BEGIN;/u);
    expect(MIGRATION.trimEnd()).toMatch(/COMMIT;$/u);
    expect(MIGRATION).toContain('CREATE TABLE "operator_shift_close_commands"');
    expect(MIGRATION).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(MIGRATION).toContain('CREATE UNIQUE INDEX');
    expect(MIGRATION).toContain('operator_shift_close_commands_actor_role_check');
    expect(MIGRATION).toContain('operator_shift_close_commands_result_ownership_check');
    expect(MIGRATION).toContain('operator_shift_close_commands_session_owner_fkey');
    expect(MIGRATION).toContain('operator_shift_close_commands_assignment_owner_fkey');
    expect(MIGRATION).toContain('operator_shift_close_commands_immutable');
    expect(MIGRATION).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/iu);
    expect(MIGRATION).not.toMatch(/DELETE\s+FROM|UPDATE\s+"/iu);
  });

  it('expands the durable result check for order references without invalidating legacy rows', () => {
    expect(ORDER_REFERENCE_MIGRATION).toContain(
      'DROP CONSTRAINT "operator_shift_close_commands_result_ownership_check"',
    );
    expect(ORDER_REFERENCE_MIGRATION).toContain("'appliedTariffOrders'");
    expect(ORDER_REFERENCE_MIGRATION).toContain(
      "NOT ((\"resultSnapshot\" -> 'closingPayroll') ? 'appliedTariffOrders')",
    );
    expect(ORDER_REFERENCE_MIGRATION).toContain(
      "jsonb_typeof(\"resultSnapshot\" #> '{closingPayroll,appliedTariffOrders}') = 'array'",
    );
    expect(ORDER_REFERENCE_MIGRATION).not.toMatch(/DROP\s+(?:TABLE|COLUMN|INDEX)/iu);
    expect(ORDER_REFERENCE_MIGRATION).not.toMatch(/DELETE\s+FROM|UPDATE\s+"/iu);
  });
});
