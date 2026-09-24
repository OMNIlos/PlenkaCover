import {
  PRODUCTION_COST_UNRESOLVED_LABELS,
  type RollProductionCostView,
} from '../../api/productionCost';

const MONEY_FORMAT = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function rubles(kopecks: number) {
  return `${MONEY_FORMAT.format(kopecks / 100)} ₽`;
}

export function RollCostCell({ cost }: { cost: RollProductionCostView }) {
  if (cost.status !== 'complete') {
    const reason = cost.unresolvedReasons
      .map((item) => PRODUCTION_COST_UNRESOLVED_LABELS[item])
      .join('; ');
    if (
      cost.kind === 'actual_pending' &&
      cost.basis.weightGrams !== null &&
      cost.materialAmountKopecks !== null &&
      cost.spoolAmountKopecks !== null &&
      cost.payrollAmountKopecks !== null
    ) {
      const totalAmountKopecks =
        cost.materialAmountKopecks +
        cost.spoolAmountKopecks +
        cost.payrollAmountKopecks +
        cost.additionalAmountKopecks;
      const weightGrams = BigInt(cost.basis.weightGrams);
      const totalKopecksPerKg = Number(
        (BigInt(totalAmountKopecks) * 1_000n + weightGrams / 2n) / weightGrams,
      );
      return (
        <span className="roll-cost-cell">
          <strong>{rubles(totalAmountKopecks)}</strong>
          <small>{rubles(totalKopecksPerKg)}/кг</small>
        </span>
      );
    }
    return (
      <span className="roll-cost-cell is-unresolved">
        <strong>Не рассчитана: {reason}</strong>
        {cost.kind === 'actual_snapshot' ? <small>Версия {cost.version}</small> : null}
        {cost.kind === 'planned_preview' ? <small>План, актуально сейчас</small> : null}
      </span>
    );
  }

  return (
    <span className="roll-cost-cell">
      <strong>{rubles(cost.totalAmountKopecks)}</strong>
      <small>{rubles(cost.totalKopecksPerKg)}/кг</small>
      {cost.kind === 'actual_snapshot' ? <small>Версия {cost.version}</small> : null}
      {cost.kind === 'planned_preview' ? <small>План, актуально сейчас</small> : null}
    </span>
  );
}
