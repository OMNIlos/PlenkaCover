import { memo } from 'react';

import type { OperatorShiftClosingPayrollView } from '../../api/operator';
import {
  formatOperatorPayrollKg,
  formatOperatorPayrollMoney,
  formatOperatorPayrollRate,
} from '../../domain/runtime/operatorPayrollFormatters';
import { operatorPayrollReasonLabel } from '../../domain/runtime/operatorPayrollView';

type Props = {
  payroll: OperatorShiftClosingPayrollView;
  onDismiss?: () => void;
};

export const ShiftClosingPayrollSummary = memo(function ShiftClosingPayrollSummary({
  payroll,
  onDismiss,
}: Props) {
  const statusLabel =
    payroll.status === 'complete'
      ? 'Рассчитано'
      : payroll.status === 'partial' && payroll.breakdown.length > 0
        ? 'Рассчитано частично'
        : 'Не рассчитано';

  return (
    <section
      className="operator-closing-payroll"
      aria-label="Начисление по закрытой смене"
      aria-live="polite"
    >
      <header className="operator-closing-payroll__header">
        <div>
          <span className="eyebrow">Смена закрыта</span>
          <h2>Итог смены</h2>
        </div>
        <div className="operator-closing-payroll__header-actions">
          <span className="commercial-state-badge state-info">{statusLabel}</span>
          {onDismiss ? (
            <button type="button" aria-label="Закрыть итог смены" onClick={onDismiss}>
              Закрыть
            </button>
          ) : null}
        </div>
      </header>

      {payroll.status === 'empty' ? (
        <div className="operator-closing-payroll__empty" role="status">
          <strong>Не рассчитано</strong>
          <span>Нет начисляемых фактов для расчёта.</span>
        </div>
      ) : payroll.breakdown.length > 0 ? (
        <div className="operator-closing-payroll__summary">
          <div>
            <span>Оплачиваемый вес</span>
            <strong>{formatOperatorPayrollKg(payroll.summary.payableKg)}</strong>
          </div>
          <div>
            <span>Начислено</span>
            <strong>{formatOperatorPayrollMoney(payroll.summary.payableAmountKopecks)}</strong>
          </div>
        </div>
      ) : null}

      {payroll.breakdown.length > 0 ? (
        <div className="operator-closing-payroll__rates" aria-label="Основания расчёта">
          {payroll.breakdown.map((row) => (
            <article key={row.id}>
              <div>
                <strong>{row.basisLabel}</strong>
                <span>{formatOperatorPayrollKg(row.payableKg)}</span>
              </div>
              <div>
                <span>{formatOperatorPayrollRate(row.rateKopecksPerKg)}</span>
                <strong>{formatOperatorPayrollMoney(row.amountKopecks)}</strong>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {payroll.unresolved.length > 0 ? (
        <div className="operator-closing-payroll__unresolved" role="status">
          <strong>Не рассчитано</strong>
          {payroll.unresolved.map((row) => (
            <div key={row.rollId}>
              <span>{row.rollCode}</span>
              <span>{formatOperatorPayrollKg(row.netKg)}</span>
              <span>{row.reasons.map(operatorPayrollReasonLabel).join(' · ')}</span>
            </div>
          ))}
        </div>
      ) : null}

      {payroll.summary.excludedDefectRollCount > 0 ? (
        <p className="operator-closing-payroll__excluded">
          Брак исключён: {formatOperatorPayrollKg(payroll.summary.excludedDefectKg)} ·{' '}
          {payroll.summary.excludedDefectRollCount}{' '}
          {payroll.summary.excludedDefectRollCount === 1 ? 'рулон' : 'рул.'}
        </p>
      ) : null}
    </section>
  );
});
