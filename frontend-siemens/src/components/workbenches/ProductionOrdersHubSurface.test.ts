import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ProductionRollDispatchItem, WorkObject } from '../../domain/types';
import type { WarehouseCoverageState, WarehouseCoverageView } from '../../domain/warehouseCoverage';
import {
  formatProductionTimestamp,
  pluralizeOrderNoun,
  productionMoscowDateKey,
  productionHubViewsForMode,
  productionRollsForHub,
  ProductionOrdersHubSurface,
  shortProductionOrderId,
} from './ProductionOrdersHubSurface';

function coverage(state: WarehouseCoverageState): WarehouseCoverageView {
  return {
    workflowVersion: 2,
    state,
    stateVersion: 4,
    generation: 3,
    availability:
      state === 'production_required'
        ? 'unavailable'
        : state === 'warehouse_reserved'
          ? 'verified_full'
          : 'unknown',
    reasonCodes:
      state === 'production_required'
        ? ['no_compatible_rolls']
        : state === 'warehouse_reserved'
          ? ['full_cover_available']
          : ['warehouse_recheck_pending'],
    nextOwner: state === 'recheck_requested' ? 'warehouse' : 'system',
    availableActions: [],
    requiredRollCount: 1,
    matchedRollCount: state === 'warehouse_reserved' ? 1 : 0,
    uncertainRollCount: state === 'unknown' ? 1 : 0,
    calculatedAt: '2026-07-25T08:00:00.000Z',
    stale: state === 'stale',
  };
}

const dispatch = {
  id: 'dispatch-1',
  productionOrderId: 'po-1',
  orderId: 'po-1',
  orderLineId: 'position-1',
  rollId: 'PRODUCTION-ROLL-001',
  sequenceNumber: 1,
  customerAlias: 'Контрагент',
  operatorId: '',
  operatorLabel: 'Не назначен',
  machineId: '',
  machineLabel: 'Не назначен',
  machineAssignedBy: 'Не назначен',
  machineAssignedAt: '2026-07-25T08:00:00.000Z',
  machineAssignmentRequired: true,
  priority: 'обычный',
  plannedNetKg: 40,
  characteristics: 'Полотно · 80 мкм',
  filmType: 'Полотно',
  micron: '80 мкм',
  sizeMeters: '275 м',
  status: 'blocked',
  auditEvent: 'audit:roll_dispatch_assigned',
} satisfies ProductionRollDispatchItem;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function dateKey(date: Date) {
  return productionMoscowDateKey(date);
}

function archivedRoll(id: string, completedAt = `${dateKey(new Date())}T12:00:00.000Z`) {
  return {
    ...dispatch,
    id,
    rollId: id,
    orderId: `order-${id}`,
    productionOrderId: `order-${id}`,
    orderNumber: id,
    status: 'warehouse_pending' as const,
    completedAt,
    updatedAt: completedAt,
  };
}

function productionOrder(state: WarehouseCoverageState, workflowVersion: 1 | 2 = 2): WorkObject {
  return {
    id: 'po-1',
    kind: 'productionOrder',
    title: 'Заказ-наряд A-1',
    statusLabel: 'Готов к согласованию',
    nextOwner: 'Зав. производства',
    severity: 'warning',
    facts: [],
    sections: [],
    actions: [],
    problems: [],
    audit: [],
    productionRollDispatchItems: [dispatch],
    warehouseCoverageWorkflowVersion: workflowVersion,
    coverage: workflowVersion === 2 ? coverage(state) : undefined,
    productionQty: 1,
    sourceGeneration: workflowVersion === 2 ? 3 : null,
    productionOrderId: 'po-1',
  };
}

function renderHub(order: WorkObject) {
  return renderToStaticMarkup(
    createElement(ProductionOrdersHubSurface, {
      orders: [order],
      rollDispatchItems: [dispatch],
      initialView: 'rolls',
      mode: 'all-rolls',
      useLiveData: true,
    }),
  );
}

function renderTechnicalApprovalOrder() {
  const order: WorkObject = {
    id: 'commercial-order-1',
    kind: 'productionOrder',
    title: 'Готовность к выпуску A-502',
    statusLabel: 'Требует решения',
    nextOwner: 'Зав. производства',
    severity: 'warning',
    facts: [{ label: 'Контрагент', value: 'Клиент Б', scope: 'production' }],
    sections: [],
    actions: [
      {
        id: 'production-technical-approve-cover:commercial-order-1',
        label: 'Подтвердить техническую пригодность',
        level: 'recommended',
        enabled: true,
      },
    ],
    problems: [],
    audit: [],
  };

  return renderToStaticMarkup(
    createElement(ProductionOrdersHubSurface, {
      orders: [order],
      rollDispatchItems: [],
      initialView: 'orders',
      mode: 'order-selection',
      useLiveData: true,
    }),
  );
}

describe('production hub section boundaries', () => {
  it('keeps archive and summary out of Заказ-наряды', () => {
    expect(productionHubViewsForMode('order-selection').map((view) => view.id)).toEqual([
      'orders',
      'rolls',
    ]);
  });

  it('keeps Заказы out of Все рулоны', () => {
    expect(productionHubViewsForMode('all-rolls').map((view) => view.id)).toEqual([
      'rolls',
      'archive',
      'summary',
    ]);
  });

  it('shows only rolls from selected orders in Заказ-наряды', () => {
    const rolls = [
      { id: 'r1', orderId: 'po-1' },
      { id: 'r2', orderId: 'po-2' },
      { id: 'r3', orderId: 'po-1' },
    ] as ProductionRollDispatchItem[];

    expect(
      productionRollsForHub('order-selection', rolls, ['po-1']).map((roll) => roll.id),
    ).toEqual(['r1', 'r3']);
    expect(productionRollsForHub('order-selection', rolls, [])).toEqual([]);
    expect(productionRollsForHub('all-rolls', rolls, [])).toEqual(rolls);
  });

  it('shows the newest received order first by default', () => {
    const order = (id: string, title: string, updatedAt: string): WorkObject => ({
      ...productionOrder('production_required'),
      id,
      title,
      productionOrderId: id,
      productionRollDispatchItems: [
        {
          ...dispatch,
          id: `dispatch-${id}`,
          productionOrderId: id,
          orderId: id,
          rollId: `roll-${id}`,
          updatedAt,
        },
      ],
    });
    const newest = order('po-z', 'Заказ-наряд NEW', '2026-08-21T08:00:00.000Z');
    const oldest = order('po-a', 'Заказ-наряд OLD', '2026-08-20T08:00:00.000Z');
    const markup = renderToStaticMarkup(
      createElement(ProductionOrdersHubSurface, {
        orders: [newest, oldest],
        rollDispatchItems: [
          ...newest.productionRollDispatchItems!,
          ...oldest.productionRollDispatchItems!,
        ],
        initialView: 'orders',
        mode: 'order-selection',
        useLiveData: true,
      }),
    );

    expect(markup.indexOf(newest.title)).toBeLessThan(markup.indexOf(oldest.title));
  });

  it('keeps a technical order id compact and visually secondary', () => {
    expect(shortProductionOrderId('cmc8v2gm20001a414i3f04x9z')).toBe('…f04x9z');
    expect(shortProductionOrderId('PO-42')).toBe('PO-42');
  });

  it('declines заказ-наряд with the selected count', () => {
    expect(pluralizeOrderNoun(1)).toBe('заказ-наряд');
    expect(pluralizeOrderNoun(3)).toBe('заказ-наряда');
    expect(pluralizeOrderNoun(7)).toBe('заказ-нарядов');
    expect(pluralizeOrderNoun(11)).toBe('заказ-нарядов');
    expect(pluralizeOrderNoun(21)).toBe('заказ-наряд');
    expect(pluralizeOrderNoun(112)).toBe('заказ-нарядов');
  });

  it('formats API timestamps in Moscow time and keeps unknown values as-is', () => {
    expect(formatProductionTimestamp('2026-07-10T15:48:35.790Z')).toBe('10.07, 18:48');
    expect(productionMoscowDateKey(new Date('2026-07-31T21:30:00.000Z'))).toBe('2026-08-01');
    expect(formatProductionTimestamp('сегодня')).toBe('сегодня');
  });

  it.each<WarehouseCoverageState>(['unknown', 'stale', 'recheck_requested', 'warehouse_reserved'])(
    'does not expose assignment for blocking V2 state %s',
    (state) => {
      expect(renderHub(productionOrder(state))).not.toContain('data-action="assign-operator"');
    },
  );

  it('exposes assignment only after a V2 production order exists for the finalized route', () => {
    const ready = productionOrder('production_required');
    expect(renderHub(ready)).toContain('data-action="assign-operator"');

    expect(renderHub({ ...ready, productionOrderId: null })).not.toContain(
      'data-action="assign-operator"',
    );
  });

  it('retains V1 production behavior', () => {
    expect(renderHub(productionOrder('production_required', 1))).toContain(
      'data-action="assign-operator"',
    );
  });

  it('renders the same server projection after a fresh reload mount', () => {
    const order = productionOrder('production_required');
    const initialRender = renderHub(order);
    const reloadRender = renderHub({
      ...order,
      coverage: order.coverage ? { ...order.coverage } : undefined,
    });

    expect(reloadRender).toBe(initialRender);
    expect(reloadRender).not.toMatch(
      /Покрытие склада|Произвести:|Расчёт №|Совместимые рулоны не найдены/u,
    );
  });

  it('renders the exact technical-cover action label from the server projection', () => {
    const markup = renderTechnicalApprovalOrder();

    expect(markup).toContain('Подтвердить техническую пригодность');
    expect(markup).not.toContain('>Согласовать<');
  });

  it('keeps canonical orders visible and exposes retry when supplemental actions fail', () => {
    const markup = renderToStaticMarkup(
      createElement(ProductionOrdersHubSurface, {
        orders: [productionOrder('production_required')],
        rollDispatchItems: [dispatch],
        initialView: 'orders',
        mode: 'order-selection',
        useLiveData: true,
        commercialActionsState: 'error',
        onRetryCommercialActions: () => undefined,
      }),
    );

    expect(markup).toContain('Заказ-наряд A-1');
    expect(markup).toContain('Действия по согласованию недоступны');
    expect(markup).toContain('Повторить');
    expect(markup).not.toContain('Нет заявок для заказ-наряда');
  });

  it('keeps canonical orders visible while supplemental actions are reloading', () => {
    const markup = renderToStaticMarkup(
      createElement(ProductionOrdersHubSurface, {
        orders: [productionOrder('production_required')],
        rollDispatchItems: [dispatch],
        initialView: 'orders',
        mode: 'order-selection',
        useLiveData: true,
        commercialActionsState: 'loading',
        onRetryCommercialActions: () => undefined,
      }),
    );

    expect(markup).toContain('Заказ-наряд A-1');
    expect(markup).toContain('Загружаем действия по согласованию');
    expect(markup).not.toContain('>Повторить<');
  });

  it('distinguishes archive loading, error, retry, and empty from active fallback rows', async () => {
    const first = deferred<ProductionRollDispatchItem[]>();
    const second = deferred<ProductionRollDispatchItem[]>();
    const fetchArchive = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const fallback = archivedRoll('ACTIVE-FALLBACK');
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [],
          rollDispatchItems: [fallback],
          initialView: 'archive',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive: fetchArchive,
        }),
      );
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Загружаем архив');
    expect(nodeText(renderer.root)).not.toContain('ACTIVE-FALLBACK');

    await act(async () => {
      first.reject(new Error('archive unavailable'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('Архив не загружен');
    expect(nodeText(renderer.root)).toContain('Повторить');
    expect(nodeText(renderer.root)).not.toContain('Заказов за период нет');

    const retry = renderer.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate) === 'Повторить');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.props.onClick();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('Загружаем архив');

    await act(async () => {
      second.resolve([archivedRoll('ARCHIVE-READY')]);
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('ARCHIVE-READY');
    expect(nodeText(renderer.root)).not.toContain('Архив не загружен');
    renderer.unmount();
  });

  it('aborts an obsolete archive range and ignores its late response', async () => {
    const first = deferred<ProductionRollDispatchItem[]>();
    const second = deferred<ProductionRollDispatchItem[]>();
    const fetchArchive = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [],
          rollDispatchItems: [],
          initialView: 'archive',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive: fetchArchive,
        }),
      );
      await Promise.resolve();
    });
    const firstSignal = fetchArchive.mock.calls[0]?.[2]?.signal as AbortSignal | undefined;

    const today = renderer.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate) === 'Сегодня');
    await act(async () => {
      today?.props.onClick();
      await Promise.resolve();
    });
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchArchive).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve([archivedRoll('LATEST-RANGE')]);
      await Promise.resolve();
      first.resolve([archivedRoll('STALE-RANGE')]);
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain('LATEST-RANGE');
    expect(nodeText(renderer.root)).not.toContain('STALE-RANGE');
    renderer.unmount();
  });

  it('describes live archive rows as completed rolls without closing a partially active order', async () => {
    const archiveItem = {
      ...archivedRoll('ARCHIVE-PARTIAL'),
      orderId: 'po-1',
      productionOrderId: 'po-1',
      orderNumber: 'A-1',
      actualNetKg: 12.5,
    };
    let renderer!: ReactTestRenderer;
    const onFetchArchive = vi.fn().mockResolvedValue([archiveItem]);

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [productionOrder('production_required')],
          rollDispatchItems: [dispatch],
          initialView: 'archive',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = nodeText(renderer.root);
    expect(rendered).toContain('Есть завершённые рулоны');
    expect(rendered).toContain('статус всего заказ-наряда этим срезом не определяется');
    expect(rendered).not.toContain('Закрыто');
    expect(rendered).not.toContain('Склад принял');
    renderer.unmount();
  });

  it('shows the complete planned specification for an archived roll without inventing fact kg', async () => {
    const archiveItem = {
      ...archivedRoll('ARCHIVE-SPEC'),
      orderNumber: 'A-SPEC',
      filmType: 'Рукав',
      actualThickness: '29',
      accountingThickness: '60',
      plannedNetKg: 8,
      plannedLengthM: undefined,
      meterageMeters: undefined,
      sizeMeters: 'нет данных',
      widthMm: undefined,
      actualNetKg: undefined,
    };
    let renderer!: ReactTestRenderer;
    const onFetchArchive = vi.fn().mockResolvedValue([archiveItem]);

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [],
          rollDispatchItems: [],
          initialView: 'archive',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const orderToggle = renderer.root
      .findAllByType('button')
      .find((candidate) => nodeText(candidate).includes('A-SPEC'));
    expect(orderToggle).toBeDefined();
    if (!orderToggle?.props['aria-expanded']) {
      await act(async () => {
        orderToggle?.props.onClick();
        await Promise.resolve();
      });
    }

    const rendered = nodeText(renderer.root);
    expect(rendered).toContain('Рукав · 29 мкм (60 мкм) · 8 кг');
    expect(rendered).toContain('Факт не указан');
    renderer.unmount();
  });

  it('keeps a missing archive actual weight out of the fact KPI and never substitutes planned kg', async () => {
    const missingActual = {
      ...archivedRoll('ARCHIVE-NO-ACTUAL'),
      orderId: 'order-partial',
      productionOrderId: 'order-partial',
      orderNumber: 'A-PARTIAL',
      actualNetKg: undefined,
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [],
          rollDispatchItems: [],
          initialView: 'summary',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive: () => Promise.resolve([missingActual]),
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const rendered = nodeText(renderer.root);
    expect(rendered).toContain('Факт веса не указан');
    expect(rendered).toContain('без факта веса 1');
    expect(rendered).not.toContain('40 кг /');
    renderer.unmount();
  });

  it('derives the live month range and calendar months from the current date', async () => {
    const now = new Date();
    const [year, month] = productionMoscowDateKey(now).split('-').map(Number);
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const previousMonth = new Date(Date.UTC(year, month - 2, 1));
    const monthTitle = (date: Date) => {
      const value = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'UTC',
        month: 'long',
        year: 'numeric',
      }).format(date);
      return `${value[0]?.toLocaleUpperCase('ru-RU')}${value.slice(1)}`;
    };
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ProductionOrdersHubSurface, {
          orders: [],
          rollDispatchItems: [],
          initialView: 'archive',
          mode: 'all-rolls',
          useLiveData: true,
          onFetchArchive: () => Promise.resolve([]),
        }),
      );
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain(`${dateKey(monthStart)} — ${dateKey(now)}`);

    const calendarToggle = renderer.root.findAll(
      (node) =>
        node.type === 'button' &&
        typeof node.props.className === 'string' &&
        node.props.className.includes('management-period-calendar-toggle'),
    )[0];
    act(() => calendarToggle?.props.onClick());
    expect(nodeText(renderer.root)).toContain(monthTitle(previousMonth));
    expect(nodeText(renderer.root)).toContain(monthTitle(monthStart));
    renderer.unmount();
  });

  it('keeps only primary order values and removes the crossed-out secondary text', () => {
    const order: WorkObject = {
      ...productionOrder('production_required'),
      statusLabel: 'В производстве',
      commercialOrder: {
        commercialConfirmationPolicy: 'required' as const,
        requiresCommercialRecipeConfirmation: false,
      } as WorkObject['commercialOrder'],
    };
    const markup = renderToStaticMarkup(
      createElement(ProductionOrdersHubSurface, {
        orders: [order],
        rollDispatchItems: [dispatch],
        initialView: 'orders',
        mode: 'order-selection',
        useLiveData: true,
      }),
    );

    expect(markup).toContain('В производстве');
    expect(markup).toContain('Контрагент');
    expect(markup).not.toContain('<small>Не выбран</small>');
    expect(markup).not.toContain('<small>Передан операторам автоматически</small>');
    expect(markup).not.toContain('<small>Коммерция</small>');
    expect(markup).not.toContain('<small>0 назн. · 1 блок.</small>');
    expect(markup).not.toContain('Нужно подтверждение коммерции');
  });

  it('keeps two accepted canonical roll identities visible with the terminal label', () => {
    const acceptedRolls = ['PRODUCTION-ROLL-001', 'PRODUCTION-ROLL-002'].map((rollId, index) => ({
      ...dispatch,
      id: `dispatch-${index + 1}`,
      rollId,
      sequenceNumber: index + 1,
      status: 'warehouse_accepted' as const,
    }));
    const order = {
      ...productionOrder('production_required'),
      statusLabel: 'Принят складом',
      productionRollDispatchItems: acceptedRolls,
    };

    const renderer = TestRenderer.create(
      createElement(ProductionOrdersHubSurface, {
        orders: [order],
        rollDispatchItems: acceptedRolls,
        initialView: 'orders',
        mode: 'order-selection',
        useLiveData: true,
      }),
    );
    const disclosure = renderer.root.findByProps({ className: 'production-order-disclosure' });
    act(() => disclosure.props.onClick({ stopPropagation: vi.fn() }));
    const rendered = nodeText(renderer.root);

    expect(rendered).toContain('PRODUCTION-ROLL-001');
    expect(rendered).toContain('PRODUCTION-ROLL-002');
    expect(rendered).toContain('Принят складом');
    expect(renderer.root.findAllByProps({ className: 'status-warehouse_accepted' })).toHaveLength(
      2,
    );
    renderer.unmount();
  });
});
