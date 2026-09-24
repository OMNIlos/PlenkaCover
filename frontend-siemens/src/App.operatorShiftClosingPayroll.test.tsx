import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./App.tsx', import.meta.url)), 'utf8');

describe('operator closing payroll integration', () => {
  it('uses a retry-stable nonphysical command and stores only the server projection', () => {
    expect(source).toContain('operatorShiftCloseGateRef.current.start(');
    expect(source).toContain('closeOperatorShift({ operationKey, bags: attempt.bags })');
    expect(source).toContain('attempt.operationKey = operationKey');
    expect(source).toContain('attempt.operationKey !== operationKey');
    expect(source).toContain(
      'setOperatorClosingPayroll({ userId: session.id, payroll: result.closingPayroll })',
    );
    expect(source).toContain("setOperatorPendingActionId('operator-close-shift')");
    expect(source).toContain(
      "current === 'operator-close-shift' || current === 'operator-close-shift-uncertain'",
    );
    expect(source).not.toMatch(
      /closingPayroll[\s\S]{0,300}(?:rateKopecksPerKg\s*\*|payableKg\s*\*)/u,
    );
  });

  it('mounts the result only for the same authenticated operator and allows dismissal', () => {
    expect(source).toContain('operatorClosingPayroll?.userId === session.id &&');
    expect(source).toContain('operatorClosingPayroll.payroll.shiftId === operatorRuntime.shift.id');
    expect(source).toMatch(
      /current\.userId !== session\.id \|\|\s*current\.payroll\.shiftId !== operatorRuntime\.shift\.id/u,
    );
    expect(source).toContain('<ShiftClosingPayrollSummary');
    expect(source).toContain('onDismiss={() => setOperatorClosingPayroll(null)}');
    expect(source).toContain('pendingActionId={operatorPendingActionId}');
  });

  it('leaves the protected physical routing calls present and unchanged in ownership', () => {
    expect(source).toContain('verifyAndHandoverOperatorQr(');
    expect(source).toContain('handoverOperatorRoll(rollCode, operationKey)');
    expect(source).toContain('physicalOperationGateRef.current.start(');
  });
});
