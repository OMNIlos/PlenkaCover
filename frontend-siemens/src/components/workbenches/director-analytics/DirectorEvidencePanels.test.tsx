import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ServerDirectorAnalyticsBigBagEvidence,
  ServerDirectorAnalyticsShiftBalanceEvidence,
  ServerDirectorAnalyticsShiftPayroll,
} from '../../../api/director';
import {
  emptyBigBagEvidenceFilterDraft,
  emptyShiftEvidenceFilterDraft,
} from '../../../domain/runtime/directorEvidenceFilters';
import { DirectorBigBagFacts } from './DirectorBigBagFacts';
import { DirectorShiftBalanceTable } from './DirectorShiftBalanceTable';

const source = {
  usage: 'shift_bag_usage',
  production: 'canonical_roll_weight_capture',
  defects: 'linked_stable_defect_weight_capture',
  latestEvidenceAt: '2026-07-24T10:00:00.000Z',
  freshness: 'fresh',
} as const;

const shift: ServerDirectorAnalyticsShiftBalanceEvidence = {
  sessionId: 'session-1',
  shiftId: 'shift-1',
  shiftLabel: 'Ночная смена',
  operatorId: 'operator-1',
  operatorName: 'Анна Соколова',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Экструдер 1',
  startedAt: '2026-07-24T06:00:00.000Z',
  endedAt: '2026-07-24T14:00:00.000Z',
  bigBags: [
    {
      usageId: 'usage-1',
      bigBagId: 'bag-1',
      bigBagCode: 'BB-1',
      materialId: 'material-1',
      material: 'ПНД',
      bigBagStatus: 'consumed',
      startKg: 500,
      endKg: 450,
      currentKg: 450,
      currentMeasuredAt: '2026-07-24T14:00:00.000Z',
      currentFreshness: 'fresh',
      openedAt: '2026-07-24T06:00:00.000Z',
      closedAt: '2026-07-24T14:00:00.000Z',
    },
  ],
  startKg: 500,
  endKg: 450,
  currentKg: 450,
  actualUsageKg: 50,
  expectedUsageKg: 45,
  producedKg: 42,
  rollCount: 1,
  defectKg: 3,
  defectCount: 1,
  unverifiedDefectCount: 2,
  deviationKg: 5,
  deviationPercent: 11.111,
  status: 'mismatch',
  source,
};

const bigBag: ServerDirectorAnalyticsBigBagEvidence = {
  id: 'usage-1',
  bigBagId: 'bag-1',
  bigBagCode: 'BB-1',
  materialId: 'material-1',
  material: 'ПНД',
  bigBagStatus: 'consumed',
  sessionId: 'session-1',
  shiftId: 'shift-1',
  shiftLabel: 'Ночная смена',
  operatorId: 'operator-1',
  operatorName: 'Анна Соколова',
  postId: 'post-1',
  postCode: 'POST-1',
  postName: 'Экструдер 1',
  openedAt: '2026-07-24T06:00:00.000Z',
  closedAt: '2026-07-24T14:00:00.000Z',
  startKg: 500,
  endKg: 450,
  currentKg: 460,
  currentMeasuredAt: '2026-07-24T14:00:00.000Z',
  priceKopecksPerKg: 2_500,
  totalKopecks: 1_125_000,
  priceEffectiveAt: '2026-07-20T12:00:00.000Z',
  bagUsageKg: 50,
  actualUsageKg: 40,
  expectedUsageKg: 45,
  calculatedRemainderKg: 455,
  producedKg: 42,
  rollCount: 1,
  defectKg: 3,
  defectCount: 1,
  unverifiedDefectCount: 0,
  deviationKg: 5,
  deviationPercent: 11.111,
  balanceScope: 'usage_episodes',
  status: 'mismatch',
  source,
};

const shiftGroupLabels = [
  'Смена / период',
  'Оператор / пост',
  'Начало / остаток',
  'Расход факт / план',
  'Выпуск / брак',
  'Отклонение',
  'Статус',
  'Источник / свежесть',
];

const bigBagGroupLabels = [
  'Big-Bag / материал',
  'Смена / исполнитель',
  'Начало / конец / текущий',
  'Big-Bag расход / план смены',
  'Выпуск',
  'Брак',
  'Отклонение / статус',
  'Источник / свежесть',
];

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function renderShiftTable(
  overrides: Partial<React.ComponentProps<typeof DirectorShiftBalanceTable>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorShiftBalanceTable
        balances={[shift]}
        pageNumber={2}
        hasPrevious
        hasNext
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyShiftEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
        {...overrides}
      />,
    );
  });
  return renderer;
}

function renderBigBagTable(
  overrides: Partial<React.ComponentProps<typeof DirectorBigBagFacts>> = {},
): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorBigBagFacts
        bags={[bigBag]}
        pageNumber={1}
        hasPrevious={false}
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyBigBagEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
        {...overrides}
      />,
    );
  });
  return renderer;
}

describe('director evidence panels', () => {
  it('shows the shift own closing weight, not the Big-Bag weight measured later', () => {
    // Real pilot case: the shift consumed 999 → 980 кг, then the warehouse
    // re-weighed the bag at 1100 кг. Showing 1100 made the remainder exceed the start.
    const markup = renderShift({ startKg: 999, endKg: 980, currentKg: 1100 });

    expect(markup).toContain('999 кг / 980 кг');
    expect(markup).not.toContain('999 кг / 1 100 кг');
  });

  it('falls back to the current weight only while the shift has no closing weight', () => {
    const markup = renderShift({ startKg: 999, endKg: null, currentKg: 950 });

    expect(markup).toContain('999 кг / 950 кг');
  });

  function renderShift(
    overrides: Partial<ServerDirectorAnalyticsShiftBalanceEvidence> = {},
    payroll?: ServerDirectorAnalyticsShiftPayroll,
  ) {
    return renderToStaticMarkup(
      <DirectorShiftBalanceTable
        balances={[{ ...shift, ...overrides }]}
        payrollBySessionId={payroll ? new Map([[shift.sessionId, payroll]]) : undefined}
        pageNumber={1}
        hasPrevious={false}
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyShiftEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );
  }

  it('renders the exact server payroll projection for a shift', () => {
    const markup = renderShift(
      { actualUsageKg: 60 },
      {
        status: 'resolved',
        tariffOrder: {
          id: 'payroll-order-1',
          name: 'Приказ № 8-09/25',
          effectiveFrom: '2025-09-29',
          currency: 'RUB',
        },
        rateKopecksPerKg: 450,
        amountKopecks: 27_000,
        tariffRule: 'abc_standard',
        basisLabel: 'АВС · стандарт',
      },
    );

    expect(markup).toContain('Начисление, ₽');
    expect(markup).toContain('270,00 ₽');
    expect(markup).toContain('4,50 ₽/кг');
    expect(markup).toContain('Приказ № 8-09/25');
  });

  it('renders the server unresolved reason without inventing a rate', () => {
    const markup = renderShift(
      { postName: 'Пнд новая', actualUsageKg: 60 },
      { status: 'unresolved', reasons: ['machine_family_unresolved'] },
    );

    expect(markup).toContain('Семейство станка не определено');
  });

  it('shows the ruble equivalent of a Big-Bag using the price the warehouse entered', () => {
    const markup = renderToStaticMarkup(
      <DirectorBigBagFacts
        bags={[bigBag]}
        pageNumber={1}
        hasPrevious={false}
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyBigBagEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('Эквивалент, ₽');
    // 1 125 000 kopecks = 11 250,00 ₽ at 25,00 ₽/kg.
    expect(markup).toContain('11\u00a0250,00 ₽');
    expect(markup).toContain('25,00 ₽/кг');
  });

  it('renders a dash when the warehouse never priced the Big-Bag', () => {
    const markup = renderToStaticMarkup(
      <DirectorBigBagFacts
        bags={[{ ...bigBag, priceKopecksPerKg: null, totalKopecks: null }]}
        pageNumber={1}
        hasPrevious={false}
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyBigBagEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('Цена склада: —');
  });

  it('shows complete shift balance evidence and bounded server pagination', () => {
    const markup = renderToStaticMarkup(
      <DirectorShiftBalanceTable
        balances={[shift]}
        pageNumber={2}
        hasPrevious
        hasNext
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyShiftEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('Точный баланс смен');
    expect(markup).toContain('Сессия session-1');
    expect(markup).toContain('BigBag BB-1');
    expect(markup).toContain('Начало / остаток');
    expect(markup).toContain('500 кг / 450 кг');
    expect(markup).toContain('Выпуск / брак');
    expect(markup).toContain('42 кг / 3 кг');
    expect(markup).toContain('Без стабильного веса: 2');
    // Статус и источник/свежесть убраны из таблицы по решению владельца;
    // фильтр по свежести остаётся в тулбаре.
    expect(markup).not.toContain('<th scope="col">Статус</th>');
    expect(markup).not.toContain('<th scope="col">Источник / свежесть</th>');
    expect(markup).not.toContain('Система · актуально');
    expect(markup).toContain('Стр. 2');
    expect(markup).toContain('Следующая');
  });

  it('shows one immutable BigBag usage row with production and defect linkage', () => {
    const markup = renderToStaticMarkup(
      <DirectorBigBagFacts
        bags={[bigBag]}
        pageNumber={1}
        hasPrevious={false}
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        open
        filters={emptyBigBagEvidenceFilterDraft}
        errors={{}}
        updating={false}
        onOpenChange={vi.fn()}
        onFilterChange={vi.fn()}
        onResetFilters={vi.fn()}
      />,
    );

    expect(markup).toContain('Факты BigBag');
    expect(markup).toContain('BB-1');
    expect(markup).toContain('ПНД');
    expect(markup).toContain('Расчётный расход');
    expect(markup).toContain('Рулоны: 42 кг · брак: 3 кг');
    expect(markup).toContain('Расчётный остаток');
    expect(markup).toContain('455 кг');
    expect(markup).toContain('+5 кг');

    const renderer = renderBigBagTable();
    const table = renderer.root.findByProps({
      className: 'director-analytics-table is-big-bag-evidence',
    });
    expect(table.findAllByType('th').map(textContent)).toEqual([
      'BigBag / материал',
      'Начальный вес',
      'Фактический остаток',
      'Расчётный расход',
      'Расчётный остаток',
      'Отклонение, кг',
      'Эквивалент, ₽',
      'BB-1ПНД',
    ]);
  });

  it('renders signed plus, minus, zero and missing BigBag deviations', () => {
    const bags = [
      { ...bigBag, id: 'usage-plus', bigBagCode: 'BB-PLUS', deviationKg: 1 },
      { ...bigBag, id: 'usage-minus', bigBagCode: 'BB-MINUS', deviationKg: -1 },
      { ...bigBag, id: 'usage-zero', bigBagCode: 'BB-ZERO', deviationKg: 0 },
      {
        ...bigBag,
        id: 'usage-missing',
        bigBagCode: 'BB-MISSING',
        deviationKg: null,
        expectedUsageKg: null,
        calculatedRemainderKg: null,
        producedKg: null,
        defectKg: null,
      },
    ];
    const renderer = renderBigBagTable({ bags });
    const rows = renderer.root.findByType('tbody').findAllByType('tr');
    // The last cell is now the ruble equivalent; deviation is the one before it.
    const deviation = (row: ReactTestInstance) => textContent(row.findAllByType('td').at(-2)!);

    expect(rows.map(deviation)).toEqual(['+1 кг', '−1 кг', '0 кг', 'Нет данных']);
  });

  it('renders all eight shift filter groups, shown count, and pagination after table scroll', () => {
    const renderer = renderShiftTable();
    const details = renderer.root.findByType('details');
    const scroll = renderer.root.findByProps({
      className: 'director-analytics-table-scroll',
    });
    const pagination = renderer.root.findByProps({
      'aria-label': 'Страницы баланса смен',
    });

    expect(details.findAllByType('legend').map(textContent)).toEqual(shiftGroupLabels);
    expect(textContent(details.findByType('summary'))).toContain('Показано: 1');
    expect(scroll.findAllByType('nav')).toHaveLength(0);
    expect(pagination.parent).toBe(details);
  });

  it('renders all eight BigBag filter groups, shown count, and pagination after table scroll', () => {
    const renderer = renderBigBagTable();
    const details = renderer.root.findByType('details');
    const scroll = renderer.root.findByProps({
      className: 'director-analytics-table-scroll',
    });
    const pagination = renderer.root.findByProps({
      'aria-label': 'Страницы фактов BigBag',
    });

    expect(details.findAllByType('legend').map(textContent)).toEqual(bigBagGroupLabels);
    expect(textContent(details.findByType('summary'))).toContain('Показано: 1');
    expect(scroll.findAllByType('nav')).toHaveLength(0);
    expect(pagination.parent).toBe(details);
  });

  it('explains disabled pagination boundaries to keyboard and pointer users', () => {
    const shiftButtons = renderShiftTable({
      pageNumber: 1,
      hasPrevious: false,
      hasNext: false,
    }).root.findAllByType('button');
    const bigBagButtons = renderBigBagTable().root.findAllByType('button');

    for (const button of [...shiftButtons, ...bigBagButtons].filter(
      (candidate) => candidate.props.disabled,
    )) {
      expect(button.props.title).toMatch(/страниц/u);
      expect(button.props['aria-label']).toMatch(/страниц/u);
    }
  });

  it('keeps controlled table disclosure open from updating to ready without duplicate toggles', () => {
    const onShiftOpenChange = vi.fn();
    const shiftRenderer = renderShiftTable({
      balances: [],
      updating: true,
      onOpenChange: onShiftOpenChange,
    });
    const onBigBagOpenChange = vi.fn();
    const bigBagRenderer = renderBigBagTable({
      bags: [],
      updating: true,
      onOpenChange: onBigBagOpenChange,
    });

    expect(shiftRenderer.root.findByType('details').props.open).toBe(true);
    expect(bigBagRenderer.root.findByType('details').props.open).toBe(true);

    act(() => {
      shiftRenderer.update(
        <DirectorShiftBalanceTable
          balances={[shift]}
          pageNumber={2}
          hasPrevious
          hasNext
          onPrevious={vi.fn()}
          onNext={vi.fn()}
          open
          filters={emptyShiftEvidenceFilterDraft}
          errors={{}}
          updating={false}
          onOpenChange={onShiftOpenChange}
          onFilterChange={vi.fn()}
          onResetFilters={vi.fn()}
        />,
      );
      bigBagRenderer.update(
        <DirectorBigBagFacts
          bags={[bigBag]}
          pageNumber={1}
          hasPrevious={false}
          hasNext={false}
          onPrevious={vi.fn()}
          onNext={vi.fn()}
          open
          filters={emptyBigBagEvidenceFilterDraft}
          errors={{}}
          updating={false}
          onOpenChange={onBigBagOpenChange}
          onFilterChange={vi.fn()}
          onResetFilters={vi.fn()}
        />,
      );
    });

    const shiftDetails = shiftRenderer.root.findByType('details');
    const bigBagDetails = bigBagRenderer.root.findByType('details');
    expect(shiftDetails.props.open).toBe(true);
    expect(bigBagDetails.props.open).toBe(true);

    act(() => {
      shiftDetails.props.onToggle({ currentTarget: { open: true } });
      bigBagDetails.props.onToggle({ currentTarget: { open: true } });
    });
    expect(onShiftOpenChange).not.toHaveBeenCalled();
    expect(onBigBagOpenChange).not.toHaveBeenCalled();

    act(() => {
      shiftDetails.props.onToggle({ currentTarget: { open: false } });
      bigBagDetails.props.onToggle({ currentTarget: { open: false } });
    });
    expect(onShiftOpenChange).toHaveBeenCalledWith(false);
    expect(onBigBagOpenChange).toHaveBeenCalledWith(false);
  });

  it('distinguishes empty periods from empty filtered results for both evidence tables', () => {
    const shiftRenderer = renderShiftTable({ balances: [] });
    const bigBagRenderer = renderBigBagTable({ bags: [] });

    expect(textContent(shiftRenderer.root)).toContain('За выбранный период смен не найдено.');
    expect(textContent(bigBagRenderer.root)).toContain('За выбранный период фактов BigBag нет.');

    act(() => {
      shiftRenderer.update(
        <DirectorShiftBalanceTable
          balances={[]}
          pageNumber={1}
          hasPrevious={false}
          hasNext={false}
          onPrevious={vi.fn()}
          onNext={vi.fn()}
          open
          filters={{ ...emptyShiftEvidenceFilterDraft, operatorQuery: 'Анна' }}
          errors={{}}
          updating={false}
          onOpenChange={vi.fn()}
          onFilterChange={vi.fn()}
          onResetFilters={vi.fn()}
        />,
      );
      bigBagRenderer.update(
        <DirectorBigBagFacts
          bags={[]}
          pageNumber={1}
          hasPrevious={false}
          hasNext={false}
          onPrevious={vi.fn()}
          onNext={vi.fn()}
          open
          filters={{ ...emptyBigBagEvidenceFilterDraft, materialQuery: 'ПНД' }}
          errors={{}}
          updating={false}
          onOpenChange={vi.fn()}
          onFilterChange={vi.fn()}
          onResetFilters={vi.fn()}
        />,
      );
    });

    expect(textContent(shiftRenderer.root)).toContain('По выбранным фильтрам смен не найдено.');
    expect(textContent(bigBagRenderer.root)).toContain('По выбранным фильтрам фактов BigBag нет.');
  });
});
