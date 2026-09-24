import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IxEmptyState } from '@siemens/ix-react';

import {
  initialOperatorRuntime,
  operatorRollHubRows,
  sortOperatorRollHubRows,
} from '../../domain/operatorRuntime';
import { OperatorRollsHubSurface } from './OperatorRollsHubSurface';

type CapturedEffect = {
  callback: () => void | (() => void);
  dependencies?: readonly unknown[];
};

const capturedEffects = vi.hoisted<CapturedEffect[]>(() => []);

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useEffect: (callback: CapturedEffect['callback'], dependencies?: readonly unknown[]) => {
      capturedEffects.push({ callback, dependencies });
    },
    useLayoutEffect: () => undefined,
  };
});

function renderSurface(
  scope: 'all' | 'handover',
  selectedRollId: string | null = null,
  onSelectRoll: (rollId: string) => void = () => undefined,
  runtime = initialOperatorRuntime,
) {
  return renderToStaticMarkup(
    <OperatorRollsHubSurface
      runtime={runtime}
      selectedRollId={selectedRollId}
      onSelectRoll={onSelectRoll}
      scope={scope}
    />,
  );
}

function runSelectionEffect(selectedRollId: string | null) {
  const onSelectRoll = vi.fn();
  renderSurface('all', selectedRollId, onSelectRoll);
  const selectionEffect = capturedEffects.find(({ dependencies }) =>
    dependencies?.includes(onSelectRoll),
  );
  expect(selectionEffect).toBeDefined();
  selectionEffect?.callback();
  return onSelectRoll;
}

beforeEach(() => {
  capturedEffects.length = 0;
});

describe('OperatorRollsHubSurface date range', () => {
  it.each(['all', 'handover'] as const)('enables period selection for %s rows', (scope) => {
    expect(renderSurface(scope)).toContain('aria-label="Период списка: Все"');
  });
});

describe('OperatorRollsHubSurface dialog focus fallback', () => {
  it.each(['all', 'handover'] as const)(
    'keeps a stable focus target in the always-visible %s hub heading',
    (scope) => {
      expect(renderSurface(scope)).toMatch(/<h2 tabindex="-1" data-dialog-focus-fallback="true">/u);
    },
  );
});

describe('OperatorRollsHubSurface responsive column contract', () => {
  const expectedColumns = [
    'queue',
    'roll',
    'order',
    'priority',
    'status',
    'step',
    'machine',
    'parameters',
    'weight',
    'qrWarehouse',
    'blocker',
    'updated',
  ];

  it('marks every header with the stable semantic column key', () => {
    const markup = renderSurface('all');
    const headerColumns = Array.from(
      markup.matchAll(/<span(?=[^>]*role="columnheader")(?=[^>]*data-column="([^"]+)")[^>]*>/gu),
      (match) => match[1],
    );

    expect(headerColumns).toEqual(expectedColumns);
  });

  it('marks every body row cell with the same semantic column keys', () => {
    const markup = renderSurface('all');
    const bodyColumns = Array.from(
      markup.matchAll(/<span(?=[^>]*role="cell")(?=[^>]*data-column="([^"]+)")[^>]*>/gu),
      (match) => match[1],
    );

    expect(bodyColumns.length).toBeGreaterThan(expectedColumns.length);
    expect(new Set(bodyColumns)).toEqual(new Set(expectedColumns));
  });
});

describe('OperatorRollsHubSurface customer privacy', () => {
  it('does not render customer aliases or the redundant current caption', () => {
    const markup = renderSurface('all');

    expect(markup).not.toMatch(/Клиент [A-ZА-Я]/u);
    expect(markup).not.toContain('текущий');
  });
});

describe('OperatorRollsHubSurface roll summary', () => {
  it('projects the commercial recipe and planned weight for each roll', () => {
    expect(
      operatorRollHubRows(initialOperatorRuntime).find(({ id }) => id === 'R-A17-01'),
    ).toMatchObject({
      recipe: '80% первичка / 20% вторичка',
      plannedWeight: '41,2 кг',
    });
  });

  it('shows recipe and planned weight instead of the technical roll code', () => {
    const markup = renderSurface('all');

    expect(markup).toContain(
      '<strong title="80% первичка / 20% вторичка">80% первичка / 20% вторичка</strong>',
    );
    expect(markup).toContain('<small>План: 41,2 кг</small>');
    expect(markup).not.toContain('<strong>R-A17-01</strong>');
    expect(markup).toContain('aria-label="Открыть рулон R-A17-01');
  });
});

describe('OperatorRollsHubSurface filters', () => {
  it('keeps only the three operator-facing lifecycle filters', () => {
    const markup = renderSurface('all');

    expect(markup).toMatch(/<button[^>]*>Активные<\/button>/u);
    expect(markup).toMatch(/<button[^>]*>Брак<\/button>/u);
    expect(markup).toMatch(/<button[^>]*>Завершенные<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*>Действия<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*>Проблемы<\/button>/u);
    expect(markup).not.toMatch(/<button[^>]*>Блокеры<\/button>/u);
  });
});

describe('OperatorRollsHubSurface selection reconciliation', () => {
  const archivedRollId = operatorRollHubRows(initialOperatorRuntime).find(
    (row) => row.isArchived,
  )?.id;
  const firstActiveRollId = sortOperatorRollHubRows(
    operatorRollHubRows(initialOperatorRuntime).filter((row) => !row.isArchived),
    'queue',
    'asc',
  )[0]?.id;

  it('preserves an explicitly empty selection', () => {
    const onSelectRoll = runSelectionEffect(null);

    expect(onSelectRoll).not.toHaveBeenCalled();
  });

  it('reconciles a stale non-null selection to the first available row', () => {
    const onSelectRoll = runSelectionEffect('missing-roll');

    expect(onSelectRoll).toHaveBeenCalledOnce();
    expect(onSelectRoll).toHaveBeenCalledWith(firstActiveRollId, false);
  });

  it('preserves a selected roll hidden by the active filter', () => {
    expect(archivedRollId).toBeDefined();

    const onSelectRoll = runSelectionEffect(archivedRollId ?? 'missing-roll');

    expect(onSelectRoll).not.toHaveBeenCalled();
  });

  it('preserves a valid selection from initial URL hydration', () => {
    expect(firstActiveRollId).toBeDefined();

    const onSelectRoll = runSelectionEffect(firstActiveRollId ?? 'missing-roll');

    expect(onSelectRoll).not.toHaveBeenCalled();
  });
});

describe('OperatorRollsHubSurface defect recovery', () => {
  it('shows only the failed attempt in my-defect view, not its healthy replacement', () => {
    const sourceOrder = initialOperatorRuntime.orders[0]!;
    const sourceRoll = sourceOrder.rolls[0]!;
    const runtime = {
      ...initialOperatorRuntime,
      orders: [
        {
          ...sourceOrder,
          status: 'assigned' as const,
          currentRoll: 1,
          currentDispatchItemId: 'PRD-R-A17-01-R1',
          rolls: [
            {
              ...sourceRoll,
              status: 'defect',
              toleranceState: 'blocked' as const,
            },
            {
              ...sourceRoll,
              id: 'R-A17-01-R1',
              dispatchItemId: 'PRD-R-A17-01-R1',
              replacesDispatchItemId: sourceRoll.dispatchItemId,
              sequenceNumber: 1,
              attemptNumber: 2,
              queueRank: 11,
              status: 'assigned',
              toleranceState: 'pending' as const,
            },
          ],
        },
      ],
    };

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorRollsHubSurface
          runtime={runtime}
          selectedRollId={null}
          onSelectRoll={() => undefined}
        />,
      );
    });
    const defectFilter = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Брак');
    act(() => defectFilter?.props.onClick());
    const tree = JSON.stringify(renderer.toJSON());

    expect(tree).toContain('operator-rolls-hub-row severity-critical');
    expect(tree).toContain('R-A17-01');
    expect(tree).toContain('Неизменяемый факт');
    expect(tree).not.toContain('R-A17-01-R1');
  });

  it('explains that the defect view is scoped to the current operator', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorRollsHubSurface
          runtime={initialOperatorRuntime}
          selectedRollId={null}
          onSelectRoll={() => undefined}
        />,
      );
    });
    const defectFilter = renderer.root
      .findAllByType('button')
      .find((button) => button.children.join('') === 'Брак');
    act(() => defectFilter?.props.onClick());

    expect(renderer.root.findByType(IxEmptyState).props.subHeader).toBe(
      'У текущего оператора нет бракованных рулонов.',
    );
  });
});
