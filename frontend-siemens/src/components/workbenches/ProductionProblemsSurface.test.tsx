import { readFileSync } from 'node:fs';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { ServerProductionProblem } from '../../api/production';
import { ProductionProblemsSurface } from './ProductionProblemsSurface';

const productionStyles = readFileSync(
  new URL('../../styles/35-production-operator-load.css', import.meta.url),
  'utf8',
);
const productionProblemsSource = readFileSync(
  new URL('./ProductionProblemsSurface.tsx', import.meta.url),
  'utf8',
);

const defect: ServerProductionProblem = {
  id: 'problem-1',
  type: 'defect',
  status: 'open',
  orderId: 'order-1',
  rollId: 'A-9-roll-1',
  actorRole: 'operator',
  reason: 'Разрыв полотна',
  recovery: null,
  createdAt: '2026-07-23T08:30:00.000Z',
  defectWeightKg: 42.6,
  defectWeightCapturedAt: '2026-07-23T08:29:30.000Z',
  defectWeightSource: 'operator_scale',
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
}

describe('production defect evidence', () => {
  it('shows the confirmed mass, capture time and physical source', () => {
    const markup = renderToStaticMarkup(
      <ProductionProblemsSurface problems={[defect]} onResolveDefect={vi.fn()} />,
    );

    expect(markup).toContain('42,6 кг');
    expect(markup).toContain('Весы оператора');
    expect(markup).toContain('23.07.2026, 11:29');
    expect(markup).toMatch(/<h2 tabindex="-1" data-dialog-focus-fallback="true">/u);
  });

  it('offers one solve action and resolves the problem without an accounting choice', () => {
    const onResolveDefect = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[defect]} onResolveDefect={onResolveDefect} />,
      );
    });
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === defect.id)
        .props.onClick(),
    );

    expect(button(renderer.root, 'Решить')).toBeDefined();
    expect(button(renderer.root, 'Переделка')).toBeUndefined();
    expect(button(renderer.root, 'Списание')).toBeUndefined();
    act(() => button(renderer.root, 'Решить')?.props.onClick());

    expect(onResolveDefect).toHaveBeenCalledOnce();
    expect(onResolveDefect).toHaveBeenCalledWith(defect.id);
  });

  it('keeps missing physical evidence visible without turning it into an accounting blocker', () => {
    const onResolveDefect = vi.fn();
    const legacy = {
      ...defect,
      id: 'legacy-problem',
      defectWeightKg: null,
      defectWeightCapturedAt: null,
      defectWeightSource: null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[legacy]} onResolveDefect={onResolveDefect} />,
      );
    });
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === legacy.id)
        .props.onClick(),
    );

    expect(nodeText(renderer.root)).toContain('Вес не подтверждён');
    expect(button(renderer.root, 'Решить')?.props.disabled).toBe(false);
    act(() => button(renderer.root, 'Решить')?.props.onClick());
    expect(onResolveDefect).toHaveBeenCalledWith(legacy.id);
  });

  it('opens resolution actions only after the problem card is activated', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[defect]} onResolveDefect={vi.fn()} />,
      );
    });

    const card = renderer.root.find(
      (node) => node.type === 'button' && node.props['data-problem-id'] === defect.id,
    );
    expect(card.props['aria-haspopup']).toBe('dialog');
    expect(button(renderer.root, 'Решить')).toBeUndefined();

    act(() => card.props.onClick());

    expect(nodeText(renderer.root)).toContain('Решение проблемы');
    expect(nodeText(renderer.root)).toContain('Решить');
    expect(nodeText(renderer.root)).not.toContain('Переделка');
    expect(nodeText(renderer.root)).not.toContain('Списание');
    expect(renderer.root.findByProps({ role: 'dialog' }).props['aria-modal']).toBe('true');
  });

  it('closes an actionable dialog when a concurrent refresh resolves the problem', () => {
    const general = {
      ...defect,
      id: 'concurrently-resolved',
      type: 'general' as const,
      reason: 'Нужна ручная проверка параметров',
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[general]} onResolveGeneral={vi.fn()} />,
      );
    });
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === general.id)
        .props.onClick(),
    );
    expect(button(renderer.root, 'Закрыть проблему')).toBeDefined();

    act(() => {
      renderer.update(
        <ProductionProblemsSurface
          problems={[
            {
              ...general,
              status: 'resolved',
              resolvedAt: '2026-07-27T09:00:00.000Z',
            },
          ]}
          onResolveGeneral={vi.fn()}
        />,
      );
    });

    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    expect(button(renderer.root, 'Закрыть проблему')).toBeUndefined();
  });

  it('closes a general problem from the card dialog with an audited result', async () => {
    const general = {
      ...defect,
      id: 'general-problem',
      type: 'general' as const,
      reason: 'Нужна ручная проверка параметров',
    };
    const onResolveGeneral = vi.fn().mockResolvedValue(undefined);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[general]} onResolveGeneral={onResolveGeneral} />,
      );
    });
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === general.id)
        .props.onClick(),
    );

    const note = renderer.root.findByType('textarea');
    expect(button(renderer.root, 'Закрыть проблему')?.props.disabled).toBe(true);
    act(() => note.props.onChange({ currentTarget: { value: 'Параметры проверены' } }));
    await act(async () => button(renderer.root, 'Закрыть проблему')?.props.onClick());

    expect(onResolveGeneral).toHaveBeenCalledWith(general.id, 'Параметры проверены');
  });

  it('keeps material shortage in the commercial correction flow', () => {
    const shortage = {
      ...defect,
      id: 'shortage-problem',
      type: 'raw_material_shortage' as const,
      reason: 'ПВД закончился',
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[shortage]} onResolveGeneral={vi.fn()} />,
      );
    });
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === shortage.id)
        .props.onClick(),
    );

    expect(nodeText(renderer.root)).toContain('Исправление выполняет коммерция');
    expect(renderer.root.findAllByType('textarea')).toHaveLength(0);
    expect(button(renderer.root, 'Закрыть проблему')).toBeUndefined();
  });
});

describe('director production problems view', () => {
  it('keeps the physical evidence while omitting routine production actions', () => {
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface mode="director" problems={[defect]} />,
      );
    });

    expect(nodeText(renderer.root)).toContain('Директор');
    expect(nodeText(renderer.root.findByProps({ className: 'production-problem-open-cue' }))).toBe(
      'Открыть',
    );
    act(() =>
      renderer.root
        .find((node) => node.type === 'button' && node.props['data-problem-id'] === defect.id)
        .props.onClick(),
    );

    expect(nodeText(renderer.root)).toContain('42,6 кг');
    expect(nodeText(renderer.root)).toContain('Весы оператора');
    expect(
      renderer.root.findAllByProps({ className: 'production-problem-dialog-actions' }),
    ).toHaveLength(0);
    expect(nodeText(renderer.root)).not.toMatch(
      /Переделка|Списание|В ремонт|Отремонтирован|Отклонить заявку|Закрыть проблему/u,
    );
  });
});

describe('notification-selected production problems', () => {
  it('forces a resolved selected problem into the card list and marks it deterministically', () => {
    const resolved = {
      ...defect,
      id: 'problem-resolved',
      status: 'resolved' as const,
      reason: 'Разрыв подтверждён и закрыт',
      resolvedAt: '2026-07-23T09:00:00.000Z',
    };
    const markup = renderToStaticMarkup(
      <ProductionProblemsSurface
        problems={[resolved]}
        selectedProblemId={resolved.id}
        onResolveDefect={vi.fn()}
      />,
    );

    expect(markup).toContain('data-problem-id="problem-resolved"');
    expect(markup).toContain('is-notification-selected');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toMatch(/<details[^>]*open=""/u);
    expect(markup).toContain('Разрыв подтверждён и закрыт');
  });

  it('keeps a selected resolved problem visible beyond the normal twenty-item history cap', () => {
    const resolved = Array.from({ length: 21 }, (_, index) => ({
      ...defect,
      id: `resolved-${index + 1}`,
      status: 'resolved' as const,
      reason: `Решённая проблема ${index + 1}`,
      resolvedAt: '2026-07-23T09:00:00.000Z',
    }));
    const markup = renderToStaticMarkup(
      <ProductionProblemsSurface problems={resolved} selectedProblemId="resolved-21" />,
    );

    expect(markup).toContain('data-problem-id="resolved-21"');
    expect(markup).toContain('Решённая проблема 21');
  });

  it('keeps the selected problem visible when the active type filter would hide it', () => {
    const selected = {
      ...defect,
      id: 'problem-shortage',
      type: 'raw_material_shortage' as const,
      reason: 'Нет сырья',
    };
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[defect, selected]} selectedProblemId={selected.id} />,
      );
    });
    act(() => button(renderer.root, 'Брак рулона1')?.props.onClick());

    expect(
      renderer.root.findAll(
        (node) => node.type === 'li' && node.props['data-problem-id'] === selected.id,
      ),
    ).toHaveLength(1);
  });

  it('focuses after selected data arrives without stealing focus on later polls', () => {
    const focus = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <ProductionProblemsSurface problems={[]} selectedProblemId={defect.id} />,
        {
          createNodeMock: (element) =>
            element.type === 'button' && element.props['data-problem-id'] === defect.id
              ? { focus }
              : {},
        },
      );
    });
    expect(focus).not.toHaveBeenCalled();

    act(() => {
      renderer.update(
        <ProductionProblemsSurface problems={[defect]} selectedProblemId={defect.id} />,
      );
    });
    expect(focus).toHaveBeenCalledOnce();

    act(() => {
      renderer.update(
        <ProductionProblemsSurface problems={[{ ...defect }]} selectedProblemId={defect.id} />,
      );
    });
    expect(focus).toHaveBeenCalledOnce();
  });

  it('restores focus to the page fallback when a resolved card was removed', () => {
    expect(productionProblemsSource).toMatch(
      /activeTriggerRef\.current\?\.isConnected[\s\S]*data-dialog-focus-fallback/u,
    );
  });

  it('uses a visible static highlight without adding decorative animation', () => {
    const selectedRule = productionStyles.match(
      /\.production-problem-card\.is-notification-selected\s*\{[^}]+\}/u,
    )?.[0];

    expect(selectedRule).toBeDefined();
    expect(selectedRule).toMatch(/background:\s*var\(--surface-selected\)/u);
    expect(selectedRule).not.toMatch(/animation|transition/u);
  });
});

describe('production defects at 1024 x 768', () => {
  it('keeps compact clickable cards and a bounded resolution dialog without overflow', () => {
    expect(productionStyles).toMatch(
      /\.production-problem-card-trigger\s*\{[^}]*min-height:\s*72px;[^}]*padding:\s*16px 18px;[^}]*cursor:\s*pointer;/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problems-surface\s*\{[^}]*gap:\s*18px;[^}]*padding:\s*clamp\(18px, 1\.6vw, 24px\);/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problem-weight\s*\{[^}]*margin-top:\s*10px;[^}]*padding:\s*12px 14px;/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problem-dialog\s*\{[^}]*max-height:\s*calc\(100vh - 32px\);[^}]*overflow:\s*hidden;/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problem-dialog-backdrop\s*\{[^}]*place-items:\s*center;[^}]*overflow-y:\s*auto;/u,
    );
    expect(productionStyles).not.toMatch(/\.production-problem-dialog\s*\{[^}]*margin-top:/u);
    expect(productionStyles).toMatch(
      /\.production-problem-dialog-actions button\.action-recommended\s*\{[^}]*background:\s*var\(--action-recommended-bg\);[^}]*color:\s*var\(--action-recommended-text\);/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problem-dialog-actions button\.action-destructive\s*\{[^}]*background:\s*var\(--action-destructive-bg\);[^}]*color:\s*var\(--action-destructive-text\);/u,
    );
    expect(productionStyles).toMatch(
      /\.production-problems-surface,[\s\S]*?\.production-problem-card-main\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/u,
    );
    expect(productionStyles).not.toMatch(
      /@media \(min-width: 901px\) and \(max-width: 1100px\)[\s\S]*?\.production-problem-card-actions/u,
    );
  });
});
