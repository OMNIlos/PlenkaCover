import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchDirectorOperatorRollVariances,
  type ServerDirectorAnalyticsOperatorOverPlan,
  type ServerDirectorOperatorRollVariancePage,
} from '../../../api/director';
import { DirectorOperatorOverconsumptionPanel } from './DirectorOperatorOverconsumptionPanel';

vi.mock('../../../api/director', () => ({
  fetchDirectorOperatorRollVariances: vi.fn(),
}));

const fetchVariances = vi.mocked(fetchDirectorOperatorRollVariances);

const aggregate = {
  series: [
    {
      bucketStartDate: '2026-07-23',
      affectedRollCount: 2,
      affectedOperatorCount: 1,
      overPlanKg: 5,
    },
    {
      bucketStartDate: '2026-07-24',
      affectedRollCount: 1,
      affectedOperatorCount: 1,
      overPlanKg: 2.5,
    },
  ],
  totals: [
    {
      period: 'week',
      fromDate: '2026-07-18',
      toDate: '2026-07-24',
      affectedRollCount: 3,
      affectedOperatorCount: 1,
      overPlanKg: 7.5,
    },
    {
      period: 'month',
      fromDate: '2026-06-25',
      toDate: '2026-07-24',
      affectedRollCount: 6,
      affectedOperatorCount: 2,
      overPlanKg: 14,
    },
  ],
  topOperators: [
    {
      operatorId: 'operator-1',
      operatorName: 'Анна Соколова',
      affectedRollCount: 3,
      overPlanKg: 7.5,
    },
    {
      operatorId: 'operator-2',
      operatorName: 'Сергей Волков',
      affectedRollCount: 2,
      overPlanKg: 4,
    },
  ],
  missingPlanCount: 2,
  missingActorCount: 1,
} satisfies ServerDirectorAnalyticsOperatorOverPlan;

const exactPage = {
  items: [
    {
      operatorId: 'operator-1',
      operatorName: 'Анна Соколова',
      orderId: 'order-1',
      orderNumber: 'A-9',
      rollId: 'roll-1',
      rollCode: 'A-9-1',
      producedAt: '2026-07-22T07:00:00.000Z',
      actualCapturedAt: '2026-07-22T07:05:00.000Z',
      plannedKg: 40,
      actualKg: 45,
      varianceKg: 5,
      overPlanKg: 5,
      provenance: 'post_session' as const,
    },
    {
      operatorId: 'operator-2',
      operatorName: 'Сергей Волков',
      orderId: 'order-2',
      orderNumber: 'A-10',
      rollId: 'roll-2',
      rollCode: 'A-10-1',
      producedAt: '2026-07-22T08:00:00.000Z',
      actualCapturedAt: '2026-07-22T08:05:00.000Z',
      plannedKg: 40,
      actualKg: 35,
      varianceKg: -5,
      overPlanKg: 0,
      provenance: 'operation_actor' as const,
    },
    {
      operatorId: null,
      operatorName: null,
      orderId: 'order-3',
      orderNumber: 'A-11',
      rollId: 'roll-3',
      rollCode: 'A-11-1',
      producedAt: '2026-07-22T09:00:00.000Z',
      actualCapturedAt: '2026-07-22T09:05:00.000Z',
      plannedKg: null,
      actualKg: 42,
      varianceKg: null,
      overPlanKg: null,
      provenance: 'plan_missing' as const,
    },
  ],
  nextCursor: null,
} satisfies ServerDirectorOperatorRollVariancePage;

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderPanel(displayMode: 'chart' | 'table') {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <DirectorOperatorOverconsumptionPanel
        aggregate={aggregate}
        range={{ from: '2026-07-18', to: '2026-07-24' }}
        displayMode={displayMode}
      />,
    );
  });
  return renderer;
}

function textContent(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('DirectorOperatorOverconsumptionPanel', () => {
  it('shows positive-only week/month totals, top operators, and partial-data counters', () => {
    const renderer = renderPanel('chart');
    const text = textContent(renderer.root);

    expect(text).toContain('7 дней');
    expect(text).toContain('7,5 кг');
    expect(text).toContain('30 дней');
    expect(text).toContain('14 кг');
    expect(text).toContain('Только положительное превышение плана');
    expect(text).toContain('Анна Соколова');
    expect(text).toContain('3 рул.');
    expect(text).toContain('Сергей Волков');
    expect(text).toContain('4 кг');
    expect(text).toContain('Неполные данные');
    expect(text).toContain('План не зафиксирован: 2 рул.');
    expect(text).toContain('Исполнитель не определён: 1 рул.');
    expect(fetchVariances).not.toHaveBeenCalled();
  });

  it('loads exact data once and renders every fact including underweight and null labels', async () => {
    fetchVariances.mockResolvedValue(exactPage);
    const renderer = renderPanel('chart');

    act(() => {
      renderer.update(
        <DirectorOperatorOverconsumptionPanel
          aggregate={aggregate}
          range={{ from: '2026-07-18', to: '2026-07-24' }}
          displayMode="table"
        />,
      );
    });
    await flushEffects();

    expect(fetchVariances).toHaveBeenCalledTimes(1);
    const headers = renderer.root.findAllByType('th').map((header) => header.children.join(''));
    expect(headers).toEqual([
      'Заказ',
      'Рулон',
      'План',
      'Факт',
      'Отклонение',
      'Перерасход',
      'Исполнитель',
      'Произведён',
      'Замер веса',
    ]);
    const text = textContent(renderer.root);
    expect(text).toContain('A-9');
    expect(text).toContain('A-9-1');
    expect(text).toContain('40 кг');
    expect(text).toContain('45 кг');
    expect(text).toContain('5 кг');
    expect(text).toContain('Анна Соколова');
    expect(text).toContain('22.07.2026');
    expect(text).toContain('A-10-1');
    expect(text).toContain('−5 кг');
    expect(text).toContain('0 кг');
    expect(text).toContain('План не зафиксирован');
    expect(text).toContain('Исполнитель не определён');

    act(() => {
      renderer.update(
        <DirectorOperatorOverconsumptionPanel
          aggregate={aggregate}
          range={{ from: '2026-07-18', to: '2026-07-24' }}
          displayMode="chart"
        />,
      );
    });
    act(() => {
      renderer.update(
        <DirectorOperatorOverconsumptionPanel
          aggregate={aggregate}
          range={{ from: '2026-07-18', to: '2026-07-24' }}
          displayMode="table"
        />,
      );
    });
    await flushEffects();
    expect(fetchVariances).toHaveBeenCalledTimes(1);
  });
});
