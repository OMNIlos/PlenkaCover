import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const financeActionStart = appSource.indexOf("if (action.kind === 'financeReduce')");
const financeActionEnd = appSource.indexOf('const beforeStatus = selectedObject.statusLabel');
const financeActionSource = appSource.slice(financeActionStart, financeActionEnd);

describe('finance payment operation App integration', () => {
  it('routes distribute and manual-paid actions through one exact idempotent operation intent', () => {
    expect(financeActionStart).toBeGreaterThan(-1);
    expect(financeActionEnd).toBeGreaterThan(financeActionStart);
    expect(financeActionSource).toContain('isFinanceDistributePaymentAction(actionId)');
    expect(financeActionSource).toContain('isFinanceManualPaymentAction(actionId)');
    expect(financeActionSource).toContain('buildFinancePaymentOperationIntent(');
    expect(financeActionSource).toContain('paymentOperation?.intent ?? null');
    expect(financeActionSource).toContain(
      'financeOperationGateRef.current.start(idempotentFinanceIntent, mutation)',
    );
  });

  it('passes the gate UUID into the canonical operation-to-status API without client money facts', () => {
    expect(financeActionSource).toMatch(
      /recordFinancePayment\(selectedObject\.id,[\s\S]*?operationKey: operationKey \?\? createOperationKey\(\),[\s\S]*?operationType: paymentOperation\.operationType,[\s\S]*?amount: paymentOperation\.amount/u,
    );
    expect(financeActionSource).not.toContain('createFinancePaymentOperation(');
    expect(financeActionSource).not.toContain('updateFinancePayment(');
    expect(financeActionSource).not.toContain('amountPaid');
    expect(financeActionSource).not.toContain("source: 'manual_platform'");
  });
});
