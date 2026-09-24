import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const surfacesSource = readFileSync(
  new URL('./components/shell/workObjectSurfaces.tsx', import.meta.url),
  'utf8',
);

describe('finance payment correction integration', () => {
  it('routes the exact target through the finance idempotency gate and refreshes live data', () => {
    expect(appSource).toContain('correctFinancePayment(');
    expect(appSource).toContain('financeOperationGateRef.current.start(');
    expect(appSource).toContain('onCorrectFinancePayment={correctLiveFinancePayment}');
    expect(appSource).toMatch(
      /correctFinancePayment\([\s\S]*?fetchFinanceOrders\(\)[\s\S]*?setWorkObjectsByRole/u,
    );
  });

  it('freezes ambiguous correction payloads and presents uncertainty separately', () => {
    expect(appSource).toContain('financePaymentCorrectionReplayRef.current.prepare(');
    expect(appSource).toContain('financePaymentCorrectionIntent(financeOrderId, payload)');
    expect(appSource).toContain('financePaymentCorrectionReplayRef.current.command(');
    expect(appSource).toContain('financePaymentCorrectionReplayRef.current.reject(');
    expect(appSource).toContain('financePaymentCorrectionReplayRef.current.resolve(financeOrderId)');
    expect(appSource).toContain('const reconciledOrder = financeOrders.find(');
    expect(appSource).toContain('unresolvedTarget?.canCorrect');
    expect(appSource).toContain('throw new ApiResponseParseError(200, error)');
    expect(appSource).toContain("'Результат корректировки нужно сверить'");
    expect(appSource).toContain("'Сначала завершите сохранённую корректировку'");
  });

  it('passes correction handling into the finance workbench only', () => {
    expect(surfacesSource).toContain('onCorrectFinancePayment');
    expect(surfacesSource).toContain('onCorrectPayment={onCorrectFinancePayment}');
  });
});
