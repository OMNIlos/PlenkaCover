import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type {
  ServerDirectorAnalyticsShiftBalanceEvidence,
  ServerDirectorAnalyticsShiftPayroll,
} from '../../../api/director';
import { DirectorShiftBalanceTable } from './DirectorShiftBalanceTable';

const balance: ServerDirectorAnalyticsShiftBalanceEvidence = {
  sessionId: 'session-payroll-1',
  shiftId: 'shift-payroll-1',
  shiftLabel: 'Смена с серверным начислением',
  operatorId: 'operator-1',
  operatorName: 'Анна Соколова',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Бегемот',
  startedAt: '2026-08-06T13:38:01.609Z',
  endedAt: '2026-08-06T19:39:24.826Z',
  bigBags: [
    {
      usageId: 'usage-1',
      bigBagId: 'bag-1',
      bigBagCode: 'BB-1',
      materialId: 'material-1',
      material: 'ПВД Айка',
      bigBagStatus: 'consumed',
      startKg: 100,
      endKg: 40,
      currentKg: 40,
      currentMeasuredAt: '2026-08-06T19:39:24.826Z',
      currentFreshness: 'fresh',
      openedAt: '2026-08-06T13:38:01.609Z',
      closedAt: '2026-08-06T19:39:24.826Z',
    },
  ],
  startKg: 100,
  endKg: 40,
  currentKg: 40,
  actualUsageKg: 60,
  expectedUsageKg: 55,
  producedKg: 52,
  rollCount: 2,
  defectKg: 3,
  defectCount: 1,
  unverifiedDefectCount: 0,
  deviationKg: 5,
  deviationPercent: 9.091,
  status: 'mismatch',
  source: {
    usage: 'shift_bag_usage',
    production: 'canonical_roll_weight_capture',
    defects: 'linked_stable_defect_weight_capture',
    latestEvidenceAt: '2026-08-06T19:39:24.826Z',
    freshness: 'fresh',
  },
};

function render(payroll?: ServerDirectorAnalyticsShiftPayroll): string {
  return renderToStaticMarkup(
    <DirectorShiftBalanceTable
      balances={[balance]}
      payrollBySessionId={
        payroll ? new Map<string, ServerDirectorAnalyticsShiftPayroll>([[balance.sessionId, payroll]]) : undefined
      }
      pageNumber={1}
      hasPrevious={false}
      hasNext={false}
      onPrevious={vi.fn()}
      onNext={vi.fn()}
    />,
  );
}

describe('DirectorShiftBalanceTable backend payroll projection', () => {
  it('shows mixed payroll without inventing a single rate', () => {
    const markup = render({
      status: 'resolved',
      tariffOrder: { id: 'order', name: 'Приказ', effectiveFrom: '2026-09-01', currency: 'RUB' },
      rateKopecksPerKg: null,
      tariffRule: null,
      amountKopecks: 400_000,
      basisLabel: 'ГОСТ: 400 кг × 4,5 ₽/кг; Тех: 400 кг × 5,5 ₽/кг',
    });
    expect(markup).toContain('Несколько ставок');
    expect(markup).toContain('4,5 ₽/кг');
    expect(markup).toContain('5,5 ₽/кг');
    expect(markup).not.toContain('undefined');
  });
  it('renders the backend amount even when it contradicts every former local ladder branch', () => {
    const markup = render({
      status: 'resolved',
      tariffOrder: {
        id: 'payroll-order-server-authority',
        name: 'Приказ № 11-08/26',
        effectiveFrom: '2026-08-05',
        currency: 'RUB',
      },
      rateKopecksPerKg: 777,
      amountKopecks: 12_345,
      tariffRule: 'alabuga_override',
      basisLabel: 'Сервер: специальное правило',
    });

    expect(markup).toContain('Начисление, ₽');
    expect(markup).toContain('123,45 ₽');
    expect(markup).toContain('7,77 ₽/кг');
    expect(markup).toContain('Алабуга');
    expect(markup).toContain('Приказ № 11-08/26');
    expect(markup).toContain('Сервер: специальное правило');
    expect(markup).not.toContain('270,00 ₽');
  });

  it('preserves an explicit server zero and renders unresolved server reasons', () => {
    const zero = render({
      status: 'resolved',
      tariffOrder: {
        id: 'payroll-order-zero',
        name: 'Приказ с нулевой ставкой',
        effectiveFrom: '2026-08-05',
        currency: 'RUB',
      },
      rateKopecksPerKg: 0,
      amountKopecks: 0,
      tariffRule: 'primary',
      basisLabel: 'Серверная нулевая ставка',
    });
    expect(zero).toContain('0,00 ₽');
    expect(zero).toContain('0,00 ₽/кг');

    const unresolved = render({
      status: 'unresolved',
      reasons: ['shift_duration_unresolved', 'material_class_unresolved'],
    });
    expect(unresolved).toContain('Длительность смены не определена');
    expect(unresolved).toContain('Сырьё не определено');
    expect(unresolved).not.toContain('270,00 ₽');
  });

  it('does not infer payroll when the aggregate server projection is unavailable', () => {
    const markup = render();

    expect(markup).toContain('Расчёт зарплаты недоступен');
    expect(markup).not.toContain('270,00 ₽');
  });
});
