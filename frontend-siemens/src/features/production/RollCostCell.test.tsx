import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RollProductionCostView } from '../../api/productionCost';
import { RollCostCell } from './RollCostCell';

const PLANNED_COMPLETE: RollProductionCostView = {
  kind: 'planned_preview',
  status: 'complete',
  calculationVersion: 'production-cost-v1',
  basis: { kind: 'planned', weightGrams: 40_000 },
  materialAmountKopecks: 20_000,
  spoolAmountKopecks: 9_000,
  payrollAmountKopecks: 3_000,
  additionalAmountKopecks: 0,
  totalAmountKopecks: 32_000,
  totalKopecksPerKg: 800,
  unresolvedReasons: [],
};

function render(cost: RollProductionCostView) {
  return renderToStaticMarkup(<RollCostCell cost={cost} />);
}

describe('RollCostCell', () => {
  it('marks a live planned value without presenting it as a frozen fact', () => {
    const markup = render(PLANNED_COMPLETE);

    expect(markup).toContain('320 ₽');
    expect(markup).toContain('8 ₽/кг');
    expect(markup).toContain('План, актуально сейчас');
    expect(markup).not.toContain('Версия');
  });

  it('names every unresolved source and never formats a partial cost as zero', () => {
    const markup = render({
      kind: 'actual_snapshot',
      status: 'partial',
      calculationVersion: 'production-cost-v1',
      snapshotId: 'cost-snapshot-2',
      version: 3,
      producedAt: '2026-08-07T00:30:00.000Z',
      closedAt: '2026-08-07T01:00:00.000Z',
      createdAt: '2026-08-07T01:00:01.000Z',
      basis: { kind: 'actual', weightGrams: 42_300 },
      materialAmountKopecks: 30_000,
      spoolAmountKopecks: null,
      payrollAmountKopecks: 4_000,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['spool_price_unresolved', 'spool_geometry_unresolved'],
    });

    expect(markup).toContain(
      'Не рассчитана: Нет цены шпули на дату выпуска; Нет ширины шпули',
    );
    expect(markup).toContain('Версия 3');
    expect(markup).not.toContain('0 ₽');
    expect(markup).not.toContain('₽/кг');
  });

  it('shows an actual pending reason without inventing a snapshot version', () => {
    const markup = render({
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: 'production-cost-v1',
      basis: { kind: 'actual', weightGrams: null },
      materialAmountKopecks: null,
      spoolAmountKopecks: null,
      payrollAmountKopecks: null,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['weight_unresolved'],
    });

    expect(markup).toContain('Не рассчитана: Нет подтверждённого веса рулона');
    expect(markup).not.toContain('Версия');
    expect(markup).not.toContain('0 ₽');
  });

  it('shows a provisional amount without lifecycle captions when inputs are complete', () => {
    const markup = render({
      kind: 'actual_pending',
      status: 'pending',
      calculationVersion: 'production-cost-v1',
      basis: { kind: 'actual', weightGrams: 40_000 },
      materialAmountKopecks: 20_000,
      spoolAmountKopecks: 9_000,
      payrollAmountKopecks: 3_000,
      additionalAmountKopecks: 0,
      totalAmountKopecks: null,
      totalKopecksPerKg: null,
      unresolvedReasons: ['dispatch_not_completed'],
    });

    expect(markup).toContain('320 ₽');
    expect(markup).toContain('8 ₽/кг');
    expect(markup).not.toContain('Предварительно');
    expect(markup).not.toContain('Выпуск рулона не завершён');
    expect(markup).not.toContain('Не рассчитана');
    expect(markup).not.toContain('Версия');
  });
});
