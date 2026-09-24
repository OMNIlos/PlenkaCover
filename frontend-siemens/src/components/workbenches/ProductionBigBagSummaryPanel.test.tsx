import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ProductionBigBagSummary } from '../../api/productionBigBags';
import { ProductionBigBagSummaryPanel } from './ProductionBigBagSummaryPanel';

const summary: ProductionBigBagSummary = {
  counts: { total: 4, inUse: 1, idle: 3, notRequired: 1 },
  bags: [
    {
      id: 'bag-use',
      code: 'BB-01',
      material: 'ПВД Первичное',
      materialDefinitionId: 'primary',
      status: 'in_use',
      currentKg: 420,
      classification: 'in_use',
    },
    {
      id: 'bag-required',
      code: 'BB-02',
      material: 'ПВД Вторичное',
      materialDefinitionId: 'secondary',
      status: 'available',
      currentKg: 200,
      classification: 'idle_required',
    },
    {
      id: 'bag-return',
      code: 'BB-03',
      material: 'ПВД Айка',
      materialDefinitionId: 'aika',
      status: 'available',
      currentKg: 180,
      classification: 'idle_not_required',
    },
    {
      id: 'bag-legacy',
      code: 'BB-LEGACY',
      material: 'Старое сырьё',
      materialDefinitionId: null,
      status: 'available',
      currentKg: 90,
      classification: 'idle_unclassified',
    },
  ],
  returnCandidates: [
    {
      id: 'bag-return',
      code: 'BB-03',
      material: 'ПВД Айка',
      materialDefinitionId: 'aika',
      status: 'available',
      currentKg: 180,
      classification: 'idle_not_required',
    },
  ],
  generatedAt: '2026-08-03T12:00:00.000Z',
};

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ProductionBigBagSummaryPanel', () => {
  it('renders role-level counts and only safe return candidates', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProductionBigBagSummaryPanel loadSummary={vi.fn().mockResolvedValue(summary)} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = nodeText(renderer.root);
    expect(text).toContain('Big-Bag в производстве');
    expect(text).toContain('Всего 4');
    expect(text).toContain('В работе 1');
    expect(text).toContain('Не используются 3');
    expect(text).toContain('Не нужны заказам 1');
    expect(text).toContain('BB-03');
    expect(text).toContain('ПВД Айка');
    expect(text).toContain('Сообщить складу устно');
    expect(text).toContain('BB-LEGACY');
    expect(text).toContain('Не предлагать к возврату автоматически');
    expect(renderer.root.findAllByType('button').map(nodeText)).not.toContain(
      'Создать заявку складу',
    );
  });

  it('explains an empty production area instead of rendering a blank list', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProductionBigBagSummaryPanel
          loadSummary={vi.fn().mockResolvedValue({
            counts: { total: 0, inUse: 0, idle: 0, notRequired: 0 },
            bags: [],
            returnCandidates: [],
            generatedAt: '2026-08-03T12:00:00.000Z',
          })}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('На производстве нет зарегистрированных Big-Bag.');
  });

  it('shows an explicit initial loading state', async () => {
    const pending = deferred<ProductionBigBagSummary>();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProductionBigBagSummaryPanel loadSummary={() => pending.promise} />,
      );
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Загружаем сводку Big-Bag…');
    renderer.unmount();
  });

  it('renders a clear error state when the initial summary request fails', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProductionBigBagSummaryPanel
          loadSummary={vi.fn().mockRejectedValue(new Error('Сервис Big-Bag недоступен.'))}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root.findByProps({ role: 'alert' }))).toContain(
      'Сервис Big-Bag недоступен.',
    );
  });

  it('keeps the last successful summary visible during a controlled refresh', async () => {
    const pending = deferred<ProductionBigBagSummary>();
    const loadSummary = vi
      .fn<() => Promise<ProductionBigBagSummary>>()
      .mockResolvedValueOnce(summary)
      .mockReturnValueOnce(pending.promise);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <ProductionBigBagSummaryPanel
          loadSummary={loadSummary}
          refreshGeneration={0}
          showRefreshAction={false}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      renderer.update(
        <ProductionBigBagSummaryPanel
          loadSummary={loadSummary}
          refreshGeneration={1}
          showRefreshAction={false}
        />,
      );
      await Promise.resolve();
    });

    expect(loadSummary).toHaveBeenCalledTimes(2);
    expect(nodeText(renderer.root)).toContain('BB-03');
    expect(renderer.root.findAllByType('button').map(nodeText)).not.toContain('Обновить');

    await act(async () => {
      pending.resolve(summary);
      await Promise.resolve();
      await Promise.resolve();
    });
    renderer.unmount();
  });
});
