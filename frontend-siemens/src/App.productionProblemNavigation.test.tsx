import { createElement, forwardRef, type ComponentProps, type ReactNode } from 'react';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveRoleSnapshot } from './api/liveRoleSnapshot';
import { ApiError } from './api/client';
import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from './api/penalties';
import type { ServerProductionProblem } from './api/production';
import type { RoleInboxPage } from './api/roleInbox';
import { productionProblemSelectionFromSearch } from './api/liveRefresh';
import { NotificationCenter, ProductHeader, RoleNavigation } from './components/shell/appShell';
import { ProductionProblemsSurface } from './components/workbenches/ProductionProblemsSurface';
import { ProductionMachinePlanningSurface } from './components/workbenches/ProductionMachinePlanningSurface';
import { ProductionOrdersHubSurface } from './components/workbenches/ProductionOrdersHubSurface';
import { StockProductionTemplateDirectory } from './components/workbenches/StockProductionTemplateDirectory';
import { PenaltyManagementSurface } from './components/workbenches/directorPenalties';
import { IntakeCreateSurface } from './components/shell/intakeCreateSurface';
import {
  CounterpartyTemplateList,
  TemplateDirectorySurface,
} from './components/shell/workObjectSurfaces';
import { DirectorWorkbench } from './components/workbenches/directorWorkbench';
import type { NotificationItem } from './domain/types';
import { productionWorkObjects } from './domain/fixtures/production';
import App from './App';

const mocks = vi.hoisted(() => ({
  fetchDirectorControl: vi.fn(),
  fetchDirectorDecisionObjects: vi.fn(),
  fetchDirectorDecisions: vi.fn(),
  fetchDirectorFinanceObjects: vi.fn(),
  fetchDirectorProductionObjects: vi.fn(),
  fetchDirectorWarehouseObjects: vi.fn(),
  fetchCounterpartyTemplates: vi.fn(),
  createCounterpartyTemplateFromFields: vi.fn(),
  updateCounterpartyTemplateStatus: vi.fn(),
  fetchCommercialCounterparties: vi.fn(),
  searchCommercialCounterparties: vi.fn(),
  fetchCommercialTemplates: vi.fn(),
  fetchRawMaterialCatalog: vi.fn(),
  fetchRecipeCatalog: vi.fn(),
  createCommercialOrderFromIntake: vi.fn(),
  createCommercialOrderFromDraft: vi.fn(),
  fetchCommercialOrderDetail: vi.fn(),
  fetchProductionLiveOrdersWithStatus: vi.fn(),
  fetchProductionOperatorMachines: vi.fn(),
  fetchProductionOperatorOptions: vi.fn(),
  fetchProductionPosts: vi.fn(),
  fetchProductionProblems: vi.fn(),
  fetchProductionShifts: vi.fn(),
  approveProductionOrder: vi.fn(),
  reorderProductionRolls: vi.fn(),
  fetchPenaltySnapshot: vi.fn(),
  createProductionOperatorPenalty: vi.fn(),
  fetchRoleInbox: vi.fn(),
  liveContours: new Set<string>(),
  loadLiveRoleSnapshot: vi.fn(),
  resolveProductionProblem: vi.fn(),
  requestIntentionalMachineChange: vi.fn(),
  showActionToast: vi.fn(),
}));

vi.mock('./api/director', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/director')>();
  return {
    ...actual,
    fetchDirectorControl: mocks.fetchDirectorControl,
    fetchDirectorDecisionObjects: mocks.fetchDirectorDecisionObjects,
    fetchDirectorDecisions: mocks.fetchDirectorDecisions,
    fetchDirectorFinanceObjects: mocks.fetchDirectorFinanceObjects,
    fetchDirectorProductionObjects: mocks.fetchDirectorProductionObjects,
    fetchDirectorWarehouseObjects: mocks.fetchDirectorWarehouseObjects,
  };
});

vi.mock('./api/liveRoleSnapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveRoleSnapshot')>();
  return { ...actual, loadLiveRoleSnapshot: mocks.loadLiveRoleSnapshot };
});

vi.mock('./api/liveContours', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/liveContours')>();
  return {
    ...actual,
    isLiveContour: (role: string) => mocks.liveContours.has(role),
  };
});

vi.mock('./api/commercial', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/commercial')>();
  return {
    ...actual,
    fetchCounterpartyTemplates: mocks.fetchCounterpartyTemplates,
    createCounterpartyTemplateFromFields: mocks.createCounterpartyTemplateFromFields,
    updateCounterpartyTemplateStatus: mocks.updateCounterpartyTemplateStatus,
    createCommercialOrderFromDraft: mocks.createCommercialOrderFromDraft,
  };
});

vi.mock('./features/commercial/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./features/commercial/api')>();
  return {
    ...actual,
    fetchCommercialCounterparties: mocks.fetchCommercialCounterparties,
    searchCommercialCounterparties: mocks.searchCommercialCounterparties,
    fetchCommercialTemplates: mocks.fetchCommercialTemplates,
    createCommercialOrderFromIntake: mocks.createCommercialOrderFromIntake,
    fetchCommercialOrderDetail: mocks.fetchCommercialOrderDetail,
  };
});

vi.mock('./api/materialRecipeCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/materialRecipeCatalog')>();
  return {
    ...actual,
    fetchRawMaterialCatalog: mocks.fetchRawMaterialCatalog,
    fetchRecipeCatalog: mocks.fetchRecipeCatalog,
  };
});

vi.mock('./api/production', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/production')>();
  return {
    ...actual,
    fetchProductionLiveOrdersWithStatus: mocks.fetchProductionLiveOrdersWithStatus,
    fetchProductionOperatorMachines: mocks.fetchProductionOperatorMachines,
    fetchProductionOperatorOptions: mocks.fetchProductionOperatorOptions,
    fetchProductionPosts: mocks.fetchProductionPosts,
    fetchProductionProblems: mocks.fetchProductionProblems,
    fetchProductionShifts: mocks.fetchProductionShifts,
    approveProductionOrder: mocks.approveProductionOrder,
    reorderProductionRolls: mocks.reorderProductionRolls,
    resolveProductionProblem: mocks.resolveProductionProblem,
    requestIntentionalMachineChange: mocks.requestIntentionalMachineChange,
  };
});

vi.mock('./api/penalties', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/penalties')>();
  return {
    ...actual,
    fetchPenaltySnapshot: mocks.fetchPenaltySnapshot,
    createProductionOperatorPenalty: mocks.createProductionOperatorPenalty,
  };
});

vi.mock('./api/roleInbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/roleInbox')>();
  return { ...actual, fetchRoleInbox: mocks.fetchRoleInbox };
});

vi.mock('./components/shell/actionToasts', () => ({
  actionToastTitle: (title: string) => title,
  operatorActionToast: vi.fn(),
  setupActionToastPosition: vi.fn(),
  showActionToast: mocks.showActionToast,
}));

vi.mock('@siemens/ix-react', async () => {
  const host = forwardRef<HTMLDivElement, { children?: ReactNode }>(({ children }, ref) =>
    createElement('div', { ref }, children),
  );
  return {
    IxApplication: host,
    IxEmptyState: host,
    IxMessageBar: host,
    IxPill: host,
  };
});

const selectedProblem: ServerProductionProblem = {
  id: 'problem-1',
  type: 'defect',
  status: 'open',
  orderId: 'order-1',
  positionId: 'position-1',
  rollId: 'ROLL-1',
  actorRole: 'operator',
  reason: 'Разрыв полотна',
  recovery: null,
  createdAt: '2026-07-23T08:30:00.000Z',
  resolvedAt: null,
  postId: null,
  post: null,
  order: { id: 'order-1', orderNumber: 'З-1' },
  defectWeightKg: 42.6,
  defectWeightCapturedAt: '2026-07-23T08:29:30.000Z',
  defectWeightSource: 'operator_scale',
};

const generalProblem: ServerProductionProblem = {
  ...selectedProblem,
  id: 'problem-general',
  type: 'general',
  positionId: null,
  rollId: null,
  reason: 'Поставка сырья задержалась',
  defectWeightKg: null,
  defectWeightCapturedAt: null,
  defectWeightSource: null,
};

function productionSnapshot(
  problems: ServerProductionProblem[],
  inbox: RoleInboxPage = { items: [], nextCursor: null, unreadCount: 0 },
  options: {
    capabilities?: string[];
    penaltySnapshot?: PenaltySnapshotRuntime;
    penaltyFilters?: PenaltySnapshotFilters;
    commercialActionsState?: 'ready' | 'error';
    orders?: Extract<LiveRoleSnapshot, { role: 'production' }>['orders'];
  } = {},
): Extract<LiveRoleSnapshot, { role: 'production' }> {
  return {
    role: 'production',
    me: {
      userId: 'production-user',
      role: 'production_lead',
      capabilities: options.capabilities ?? ['production:read'],
      displayName: 'Зав. производства',
      isActive: true,
      sessionPurpose: null,
      session: {
        id: 'session-1',
        purpose: 'office',
        state: 'active',
        createdAt: '2026-07-23T08:00:00.000Z',
        expiresAt: '2026-07-23T20:00:00.000Z',
        lastSeenAt: '2026-07-23T08:30:00.000Z',
      },
      workContext: { kind: 'office', assignment: null },
      passwordChangeRequired: false,
    },
    inbox,
    orders: options.orders ?? [],
    commercialActionsState: options.commercialActionsState ?? 'ready',
    shifts: [],
    posts: [],
    penaltySnapshot: options.penaltySnapshot ?? {
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    },
    penaltyFilters: options.penaltyFilters ?? {},
    problems,
    operators: [],
    operatorMachineView: null,
  };
}

function penaltySnapshot(
  id: string,
  status: PenaltySnapshotRuntime['items'][number]['status'] = 'cancelled',
): PenaltySnapshotRuntime {
  return {
    items: [
      {
        penaltyId: id,
        employeeId: 'operator-1',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        targetRole: 'operator',
        scopeObjectId: 'Заказ A-101 целиком',
        reason: 'Брак',
        amountLabel: '10 ₽',
        author: 'Зав. производства',
        status,
        createdAt: '2026-08-08T08:00:00.000Z',
        history: [],
      },
    ],
    summary: { totalCount: 1, totalAmountKopecks: 1000, topReason: 'брак' },
  };
}

function directorSnapshot(problems: ServerProductionProblem[]): LiveRoleSnapshot {
  return {
    role: 'director',
    me: {
      userId: 'director-user',
      role: 'director',
      capabilities: ['director:read'],
      displayName: 'Директор',
      isActive: true,
      sessionPurpose: null,
      session: {
        id: 'director-session',
        purpose: 'office',
        state: 'active',
        createdAt: '2026-07-23T08:00:00.000Z',
        expiresAt: '2026-07-23T20:00:00.000Z',
        lastSeenAt: '2026-07-23T08:30:00.000Z',
      },
      workContext: { kind: 'office', assignment: null },
      passwordChangeRequired: false,
    },
    inbox: { items: [], nextCursor: null, unreadCount: 0 },
    control: {
      pendingDecisions: 0,
      penalties: 0,
      overdueOrders: 0,
      penaltiesAmount: 0,
      plannedInvoicedAmount: 0,
      paidAmount: 0,
      unbilledAmount: 0,
      overdueAmount: 0,
      producedKg: 42.6,
      defectKg: 42.6,
      warehouseAcceptedRolls: 0,
    },
    decisions: [],
    decisionObjects: [],
    penaltySnapshot: {
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    },
    penaltyFilters: {},
    penaltyTargets: [],
    problems,
  };
}

function notification(id: string): NotificationItem {
  return {
    id,
    recipientRole: 'production',
    severity: 'info',
    title: id,
    body: id,
    createdAt: '2026-07-24T10:00:00.000Z',
    requiresAck: false,
    sound: false,
  };
}

function inboxPage(ids: string[], nextCursor: string | null, unreadCount: number): RoleInboxPage {
  return {
    items: ids.map(notification),
    nextCursor,
    unreadCount,
  };
}

const planningShift: ComponentProps<typeof ProductionMachinePlanningSurface>['shifts'][number] = {
  id: 'shift-1',
  label: 'Плановая смена',
  plannedStartAt: null,
  plannedEndAt: null,
  status: 'open',
  machineAssignments: [
    {
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: '2026-07-27T09:00:00.000Z',
    },
  ],
};

const planningPosts = [
  { id: 'post-1', code: 'POST-1', name: 'Станок 1', status: 'active', agentStatus: 'online' },
  { id: 'post-2', code: 'POST-2', name: 'Станок 2', status: 'active', agentStatus: 'online' },
];

const planningOperators = [
  { operatorId: 'operator-1', displayName: 'Сергей Волков', active: 1, planned: 0, total: 1 },
];

function planningSnapshot(): Extract<LiveRoleSnapshot, { role: 'production' }> {
  return {
    ...productionSnapshot([]),
    shifts: [planningShift],
    posts: planningPosts,
    operators: planningOperators,
    operatorMachineView: {
      shift: planningShift,
      operators: [{ id: 'operator-1', displayName: 'Сергей Волков' }],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installBrowser(href: string) {
  let currentUrl = new URL(href);
  const storage = new Map<string, string>();
  const location = {
    get href() {
      return currentUrl.toString();
    },
    get search() {
      return currentUrl.search;
    },
    assign: vi.fn(),
  };
  const history = {
    state: null,
    replaceState: vi.fn((state: unknown, _title: string, next?: string | URL | null) => {
      history.state = state as null;
      if (next !== undefined && next !== null) currentUrl = new URL(String(next), currentUrl);
    }),
  };
  const media = {
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  vi.stubGlobal('window', {
    innerWidth: 1280,
    location,
    history,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: vi.fn(() => media),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: vi.fn(() => 1),
    cancelAnimationFrame: vi.fn(),
  });
  return {
    href: () => currentUrl.toString(),
    replaceState: history.replaceState,
    search: () => currentUrl.search,
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => nodeText(candidate) === label);
}

async function renderApp() {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

describe('App production-problem notification reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.liveContours.clear();
    mocks.liveContours.add('production');
    mocks.liveContours.add('director');
    mocks.fetchCounterpartyTemplates.mockReset().mockResolvedValue({
      templates: [],
      versions: [],
      draftPositions: {},
    });
    mocks.createCounterpartyTemplateFromFields.mockReset().mockResolvedValue({
      templates: [],
      versions: [],
      draftPositions: {},
    });
    mocks.updateCounterpartyTemplateStatus.mockReset();
    mocks.fetchCommercialCounterparties.mockReset().mockResolvedValue([]);
    mocks.searchCommercialCounterparties.mockReset().mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    mocks.fetchCommercialTemplates.mockReset().mockResolvedValue([]);
    mocks.fetchRawMaterialCatalog
      .mockReset()
      .mockResolvedValue([{ id: 'material-pvd', name: 'ПВД 10803-020', kind: 'base' }]);
    mocks.fetchRecipeCatalog.mockReset().mockResolvedValue([
      {
        id: 'recipe-clear',
        name: 'Прозрачная рецептура',
        version: {
          id: 'recipe-version-clear',
          version: 1,
          ingredients: [
            {
              rawMaterialDefinitionId: 'material-pvd',
              name: 'ПВД 10803-020',
              shareBasisPoints: 10_000,
            },
          ],
        },
      },
    ]);
    mocks.createCommercialOrderFromIntake.mockReset().mockResolvedValue({ id: 'order-live' });
    mocks.createCommercialOrderFromDraft.mockReset().mockResolvedValue({
      id: 'order-live',
      kind: 'commercialOrder',
      title: 'Заявка A-1',
      statusLabel: 'Нужна проверка коммерции',
      nextOwner: 'Коммерция',
      severity: 'info',
      filterTags: ['Входящие заявки'],
      facts: [],
      sections: [],
      actions: [],
      problems: [],
      audit: [],
    });
    mocks.fetchCommercialOrderDetail.mockReset().mockResolvedValue({ id: 'order-live' });
    mocks.fetchDirectorControl.mockReset();
    mocks.fetchDirectorDecisionObjects.mockReset();
    mocks.fetchDirectorDecisions.mockReset();
    mocks.fetchDirectorFinanceObjects.mockReset();
    mocks.fetchDirectorProductionObjects.mockReset();
    mocks.fetchDirectorWarehouseObjects.mockReset();
    mocks.fetchDirectorControl.mockResolvedValue(null);
    mocks.fetchDirectorDecisionObjects.mockResolvedValue(null);
    mocks.fetchDirectorDecisions.mockResolvedValue([]);
    mocks.fetchDirectorFinanceObjects.mockResolvedValue([]);
    mocks.fetchDirectorProductionObjects.mockResolvedValue([]);
    mocks.fetchDirectorWarehouseObjects.mockResolvedValue([]);
    mocks.loadLiveRoleSnapshot.mockReset();
    mocks.fetchProductionLiveOrdersWithStatus
      .mockReset()
      .mockResolvedValue({ orders: [], commercialActionsState: 'ready' });
    mocks.fetchProductionOperatorMachines.mockReset();
    mocks.fetchProductionOperatorOptions.mockReset();
    mocks.fetchProductionPosts.mockReset();
    mocks.fetchProductionProblems.mockReset();
    mocks.fetchProductionShifts.mockReset();
    mocks.approveProductionOrder.mockReset();
    mocks.reorderProductionRolls.mockReset().mockResolvedValue(undefined);
    mocks.fetchPenaltySnapshot.mockReset();
    mocks.createProductionOperatorPenalty.mockReset();
    mocks.fetchRoleInbox.mockReset();
    mocks.resolveProductionProblem.mockReset();
    mocks.requestIntentionalMachineChange.mockReset();
    mocks.showActionToast.mockReset();
    mocks.fetchPenaltySnapshot.mockResolvedValue({
      items: [],
      summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
    });
  });

  it('never exposes request creation in production even with order:create capability', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BD%D0%B0%D1%80%D1%8F%D0%B4%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, {
        capabilities: ['production:read', 'order:create'],
      }),
    );

    const renderer = await renderApp();
    expect(button(renderer.root, 'Создать заявку')).toBeUndefined();
    expect(renderer.root.findAllByType(IntakeCreateSurface)).toHaveLength(0);
    expect(mocks.fetchCounterpartyTemplates).not.toHaveBeenCalled();
    expect(mocks.fetchCommercialCounterparties).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('shows client lifecycle and stock editing actions for live production data', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B%20%D0%B8%20%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([]));
    mocks.searchCommercialCounterparties.mockResolvedValue({
      items: [
        {
          id: 'cp-live',
          displayName: 'Клиент производства',
          legalName: null,
          inn: null,
          billingSource: 'one_c',
          syncStatus: 'synced',
        },
      ],
      nextCursor: null,
    });
    mocks.fetchCounterpartyTemplates.mockResolvedValue({
      templates: [
        {
          id: 'tpl-live',
          counterpartyId: 'cp-live',
          name: 'Рукав 80 мкм',
          activeVersionId: 'tplv-live',
          status: 'active',
          ownerRole: 'Зав. производства',
          usageCount: 2,
          lastUsedAt: '09.08.2026',
          updatedAt: '10.08.2026',
        },
        {
          id: 'tpl-archived',
          counterpartyId: 'cp-live',
          name: 'Архивный рукав 60 мкм',
          activeVersionId: 'tplv-archived',
          status: 'archived',
          ownerRole: 'Зав. производства',
          usageCount: 1,
          lastUsedAt: '08.08.2026',
          updatedAt: '09.08.2026',
        },
      ],
      versions: [
        {
          id: 'tplv-live',
          templateId: 'tpl-live',
          version: 'v1',
          fields: [],
          reason: 'Создан',
          createdBy: 'Зав. производства',
          createdAt: '10.08.2026',
          affectsProduction: true,
          affectsMoney: false,
        },
        {
          id: 'tplv-archived',
          templateId: 'tpl-archived',
          version: 'v1',
          fields: [],
          reason: 'Создан',
          createdBy: 'Зав. производства',
          createdAt: '09.08.2026',
          affectsProduction: true,
          affectsMoney: false,
        },
      ],
      draftPositions: {},
    });
    mocks.updateCounterpartyTemplateStatus.mockImplementation(
      (_counterpartyId: string, templateId: string, status: 'active' | 'archived') =>
        Promise.resolve({
          templates: [
            {
              id: templateId,
              counterpartyId: 'cp-live',
              name: templateId === 'tpl-live' ? 'Рукав 80 мкм' : 'Архивный рукав 60 мкм',
              activeVersionId: templateId === 'tpl-live' ? 'tplv-live' : 'tplv-archived',
              status,
              ownerRole: 'Зав. производства',
              usageCount: templateId === 'tpl-live' ? 2 : 1,
              lastUsedAt: templateId === 'tpl-live' ? '09.08.2026' : '08.08.2026',
              updatedAt: '11.08.2026',
            },
          ],
          versions: [],
          draftPositions: {},
        }),
    );

    const renderer = await renderApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const markup = nodeText(renderer.root);

    expect(markup).toContain('Клиент производства');
    expect(markup).toContain('Рукав 80 мкм');
    expect(markup).toContain('Архивный рукав 60 мкм');
    expect(markup).not.toContain('УралПак');
    expect(markup).not.toContain('Шаблоны доступны для просмотра');
    expect(markup).not.toContain('Создание и изменение временно недоступны');
    expect(renderer.root.findByProps({ 'aria-label': 'В списке 1' })).toBeDefined();
    expect(button(renderer.root, 'Добавить шаблон')).toBeDefined();
    expect(button(renderer.root, 'Редактировать')).toBeDefined();
    expect(button(renderer.root, 'Дублировать')).toBeDefined();
    expect(button(renderer.root, 'Архивировать')).toBeDefined();
    expect(button(renderer.root, 'Сделать активным')).toBeDefined();
    expect(button(renderer.root, 'Шаблоны на запас')).toBeDefined();
    expect(mocks.searchCommercialCounterparties).toHaveBeenCalledWith(
      { q: '', limit: 20 },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.fetchCommercialCounterparties).not.toHaveBeenCalled();
    expect(mocks.fetchCounterpartyTemplates).toHaveBeenCalledWith(['cp-live'], {
      signal: expect.any(AbortSignal),
    });
    const templateCards = renderer.root.findAllByProps({ className: 'template-card' });
    const activeCard = templateCards.find((card) => nodeText(card).includes('Рукав 80 мкм'));
    const archivedCard = templateCards.find((card) =>
      nodeText(card).includes('Архивный рукав 60 мкм'),
    );
    expect(activeCard).toBeDefined();
    expect(archivedCard).toBeDefined();
    await act(async () => {
      button(activeCard!, 'Архивировать')?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.updateCounterpartyTemplateStatus).toHaveBeenCalledWith(
      'cp-live',
      'tpl-live',
      'archived',
    );
    await act(async () => {
      button(archivedCard!, 'Сделать активным')?.props.onClick();
      await Promise.resolve();
    });
    expect(mocks.updateCounterpartyTemplateStatus).toHaveBeenCalledWith(
      'cp-live',
      'tpl-archived',
      'active',
    );
    await act(async () => {
      button(renderer.root, 'Шаблоны на запас')?.props.onClick();
      await Promise.resolve();
    });
    const stockDirectory = renderer.root.findByType(StockProductionTemplateDirectory);
    expect(stockDirectory.props.readOnly).toBe(false);
    expect(stockDirectory.props.materials).toEqual([
      { id: 'material-pvd', name: 'ПВД 10803-020', kind: 'base' },
    ]);
    expect(stockDirectory.props.recipes[0]?.name).toBe('Прозрачная рецептура');
    expect(nodeText(stockDirectory)).not.toContain('Каталог доступен только для просмотра');
    expect(button(stockDirectory, 'Добавить шаблон на запас')).toBeDefined();
    renderer.unmount();
  });

  it('debounces bounded counterparty search, ignores stale pages, and paginates safely', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B%20%D0%B8%20%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([]));
    const stalePage = deferred<{
      items: Array<{
        id: string;
        displayName: string;
        legalName: null;
        inn: null;
        billingSource: string;
        syncStatus: string;
      }>;
      nextCursor: string | null;
    }>();
    mocks.searchCommercialCounterparties
      .mockResolvedValueOnce({
        items: [
          {
            id: 'cp-selected',
            displayName: 'Выбранный клиент',
            legalName: null,
            inn: null,
            billingSource: 'one_c',
            syncStatus: 'synced',
          },
        ],
        nextCursor: null,
      })
      .mockReturnValueOnce(stalePage.promise)
      .mockResolvedValueOnce({
        items: [
          {
            id: 'cp-fresh',
            displayName: 'Новый результат',
            legalName: null,
            inn: null,
            billingSource: 'one_c',
            syncStatus: 'synced',
          },
        ],
        nextCursor: 'cursor-fresh',
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: 'cp-more',
            displayName: 'Следующая страница',
            legalName: null,
            inn: null,
            billingSource: 'one_c',
            syncStatus: 'synced',
          },
        ],
        nextCursor: null,
      });

    const renderer = await renderApp();
    expect(mocks.searchCommercialCounterparties).toHaveBeenCalledTimes(1);
    expect(mocks.searchCommercialCounterparties).toHaveBeenNthCalledWith(
      1,
      { q: '', limit: 20 },
      { signal: expect.any(AbortSignal) },
    );

    const searchInput = renderer.root.findByProps({ 'aria-label': 'Поиск контрагентов' });
    await act(async () => {
      searchInput.props.onChange({ target: { value: 'старый' } });
      await vi.advanceTimersByTimeAsync(250);
    });
    const staleSignal = mocks.searchCommercialCounterparties.mock.calls[1]?.[1]?.signal;
    expect(staleSignal).toBeInstanceOf(AbortSignal);

    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Поиск контрагентов' })
        .props.onChange({ target: { value: 'новый' } });
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(mocks.searchCommercialCounterparties).toHaveBeenCalledTimes(2);
    expect(staleSignal.aborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.searchCommercialCounterparties).toHaveBeenNthCalledWith(
      3,
      { q: 'новый', limit: 20 },
      { signal: expect.any(AbortSignal) },
    );
    let list = renderer.root.findByType(CounterpartyTemplateList);
    expect(list.props.selectedCounterpartyId).toBe('cp-selected');
    expect(list.props.counterpartyCatalog.map((item: { id: string }) => item.id)).toEqual([
      'cp-selected',
      'cp-fresh',
    ]);

    await act(async () => {
      stalePage.resolve({
        items: [
          {
            id: 'cp-stale',
            displayName: 'Устаревший результат',
            legalName: null,
            inn: null,
            billingSource: 'one_c',
            syncStatus: 'synced',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    list = renderer.root.findByType(CounterpartyTemplateList);
    expect(list.props.counterpartyCatalog).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'cp-stale' })]),
    );

    await act(async () => {
      button(renderer.root, 'Показать ещё')?.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.searchCommercialCounterparties).toHaveBeenNthCalledWith(
      4,
      { q: 'новый', cursor: 'cursor-fresh', limit: 20 },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.fetchCounterpartyTemplates).toHaveBeenCalledWith(['cp-more'], {
      signal: expect.any(AbortSignal),
    });
    expect(
      renderer.root
        .findByType(CounterpartyTemplateList)
        .props.counterpartyCatalog.map((item: { id: string }) => item.id),
    ).toEqual(['cp-selected', 'cp-fresh', 'cp-more']);
    expect(mocks.fetchCommercialCounterparties).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('keeps counterparty browsing and client CRUD visible when template loading fails', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B%20%D0%B8%20%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([]));
    mocks.searchCommercialCounterparties.mockResolvedValue({
      items: [
        {
          id: 'cp-live',
          displayName: 'Клиент без шаблонов',
          legalName: null,
          inn: null,
          billingSource: 'one_c',
          syncStatus: 'synced',
        },
      ],
      nextCursor: null,
    });
    mocks.fetchCounterpartyTemplates.mockRejectedValue(new Error('templates offline'));

    const renderer = await renderApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Клиент без шаблонов');
    expect(nodeText(renderer.root)).toContain('Шаблоны клиентов временно недоступны');
    expect(nodeText(renderer.root)).not.toContain('Клиентские шаблоны недоступны');
    expect(renderer.root.findByType(CounterpartyTemplateList)).toBeDefined();
    expect(renderer.root.findByType(TemplateDirectorySurface)).toBeDefined();
    expect(button(renderer.root, 'Добавить шаблон')).toBeDefined();
    renderer.unmount();
  });

  it('loads material and recipe options for client templates and saves a selected material id', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9A%D0%BE%D0%BD%D1%82%D1%80%D0%B0%D0%B3%D0%B5%D0%BD%D1%82%D1%8B%20%D0%B8%20%D1%88%D0%B0%D0%B1%D0%BB%D0%BE%D0%BD%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([]));
    mocks.searchCommercialCounterparties.mockResolvedValue({
      items: [
        {
          id: 'cp-live',
          displayName: 'Клиент производства',
          legalName: null,
          inn: null,
          billingSource: 'one_c',
          syncStatus: 'synced',
        },
      ],
      nextCursor: null,
    });

    const renderer = await renderApp();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let surface = renderer.root.findByType(TemplateDirectorySurface);
    expect(surface.props.materials.map((item: { name: string }) => item.name)).toEqual([
      'ПВД 10803-020',
    ]);
    expect(surface.props.recipes.map((item: { name: string }) => item.name)).toEqual([
      'Прозрачная рецептура',
    ]);

    act(() => surface.props.onOpenEditor('add'));
    surface = renderer.root.findByType(TemplateDirectorySurface);
    const editor = surface.props.editor;
    act(() =>
      surface.props.onEditorChange({
        ...editor,
        name: 'Тестовый шаблон',
        positions: [
          {
            ...editor.positions[0],
            widthMm: '1700',
            plannedLengthM: '275',
            plannedWeightKg: '41.2',
            rawMaterial: 'ПВД 10803-020',
            baseRawMaterialDefinitionId: 'material-pvd',
          },
        ],
      }),
    );

    await act(async () => {
      await renderer.root.findByType(TemplateDirectorySurface).props.onSave();
      await Promise.resolve();
    });
    expect(mocks.createCounterpartyTemplateFromFields).toHaveBeenCalledWith(
      'cp-live',
      'Тестовый шаблон',
      [expect.objectContaining({ baseRawMaterialDefinitionId: 'material-pvd' })],
    );
    expect(mocks.fetchRawMaterialCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.fetchRecipeCatalog).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('passes the supplemental production read error and retry into the live orders surface', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BD%D0%B0%D1%80%D1%8F%D0%B4%D1%8B',
    );
    const retry = deferred<Extract<LiveRoleSnapshot, { role: 'production' }>>();
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(productionSnapshot([], undefined, { commercialActionsState: 'error' }))
      .mockReturnValueOnce(retry.promise);

    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionOrdersHubSurface);

    expect(surface.props.commercialActionsState).toBe('error');
    expect(surface.props.onRetryCommercialActions).toEqual(expect.any(Function));

    act(() => surface.props.onRetryCommercialActions());
    expect(renderer.root.findByType(ProductionOrdersHubSurface).props.commercialActionsState).toBe(
      'loading',
    );

    await act(async () => {
      retry.resolve(productionSnapshot([], undefined, { commercialActionsState: 'ready' }));
      await Promise.resolve();
    });
    expect(renderer.root.findByType(ProductionOrdersHubSurface).props.commercialActionsState).toBe(
      'ready',
    );
    renderer.unmount();
  });

  it('uses the exact mixed penalty snapshot without a secondary Production queue and denies create by capability', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%A8%D1%82%D1%80%D0%B0%D1%84%D1%8B',
    );
    const mixed: PenaltySnapshotRuntime = {
      items: [
        ...penaltySnapshot('issued', 'issued').items,
        ...penaltySnapshot('disputed', 'disputed').items,
        ...penaltySnapshot('cancelled', 'cancelled').items,
      ],
      summary: { totalCount: 3, totalAmountKopecks: 3000, topReason: 'брак' },
    };
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, {
        capabilities: ['penalty:read'],
        penaltySnapshot: mixed,
      }),
    );

    const renderer = await renderApp();
    const surface = renderer.root.findByType(PenaltyManagementSurface);
    const navigation = renderer.root.findByType(RoleNavigation);

    expect(surface.props.snapshot).toBe(mixed);
    expect(surface.props.snapshot.items).toHaveLength(3);
    expect(surface.props.snapshot.summary.totalCount).toBe(3);
    expect(surface.props.canCreatePenalty).toBe(false);
    expect(navigation.props.sectionCounts).toEqual({ Штрафы: 3 });
    expect(
      renderer.root.findAll(
        (node) =>
          typeof node.props.className === 'string' &&
          node.props.className.split(' ').includes('list-panel'),
      ),
    ).toHaveLength(0);
    renderer.unmount();
  });

  it('preserves applied penalty filters in the five-second poll and post-create refresh', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%A8%D1%82%D1%80%D0%B0%D1%84%D1%8B',
    );
    const initial = penaltySnapshot('initial', 'issued');
    const filtered = penaltySnapshot('filtered', 'cancelled');
    const periodic = penaltySnapshot('periodic', 'cancelled');
    const afterCreate = penaltySnapshot('after-create', 'cancelled');
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(
        productionSnapshot([], undefined, {
          capabilities: ['penalty:read', 'penalty:create'],
          penaltySnapshot: initial,
        }),
      )
      .mockResolvedValue(
        productionSnapshot([], undefined, {
          capabilities: ['penalty:read', 'penalty:create'],
          penaltySnapshot: periodic,
          penaltyFilters: { status: 'cancelled' },
        }),
      );
    mocks.fetchPenaltySnapshot.mockResolvedValueOnce(filtered).mockResolvedValueOnce(afterCreate);
    mocks.createProductionOperatorPenalty.mockResolvedValue({
      ...afterCreate.items[0],
      penaltyId: 'created',
    });
    const renderer = await renderApp();

    await act(async () => {
      await renderer.root
        .findByType(PenaltyManagementSurface)
        .props.onFiltersChange({ status: 'cancelled' });
    });
    expect(renderer.root.findByType(PenaltyManagementSurface).props.filters).toEqual({
      status: 'cancelled',
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(mocks.loadLiveRoleSnapshot).toHaveBeenLastCalledWith(
      'production',
      expect.objectContaining({ penaltyFilters: { status: 'cancelled' } }),
    );
    expect(renderer.root.findByType(PenaltyManagementSurface).props.snapshot).toBe(periodic);

    await act(async () => {
      await renderer.root.findByType(PenaltyManagementSurface).props.onCreate({
        employeeId: 'operator-1',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        amountLabel: '10 ₽',
        reason: 'Брак',
        scopeObjectId: 'Заказ A-101 целиком',
        productionOrderId: 'production-order-1',
        author: 'Зав. производства',
      });
    });

    expect(mocks.fetchPenaltySnapshot).toHaveBeenNthCalledWith(
      2,
      { status: 'cancelled' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(renderer.root.findByType(PenaltyManagementSurface).props.filters).toEqual({
      status: 'cancelled',
    });
    expect(renderer.root.findByType(PenaltyManagementSurface).props.snapshot).toBe(afterCreate);
    renderer.unmount();
  });

  it('does not report a committed penalty as rejected when its follow-up refresh fails', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%A8%D1%82%D1%80%D0%B0%D1%84%D1%8B',
    );
    const initial = penaltySnapshot('initial', 'issued');
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, {
        capabilities: ['penalty:read', 'penalty:create'],
        penaltySnapshot: initial,
      }),
    );
    mocks.createProductionOperatorPenalty.mockResolvedValue({
      ...initial.items[0],
      penaltyId: 'created',
    });
    mocks.fetchPenaltySnapshot.mockRejectedValue(new Error('Refresh unavailable'));
    const renderer = await renderApp();

    await expect(
      renderer.root.findByType(PenaltyManagementSurface).props.onCreate({
        employeeId: 'operator-1',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        amountLabel: '10 ₽',
        reason: 'Брак',
        scopeObjectId: 'Заказ A-101 целиком',
        productionOrderId: 'production-order-1',
        author: 'Зав. производства',
      }),
    ).resolves.toBe(true);

    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: 'created',
        actionId: 'penalty:create',
        tone: 'warning',
        title: 'Штраф назначен',
        detail: 'Штраф сохранён, но список не обновился. Повторите обновление данных.',
      }),
    );
    expect(mocks.showActionToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Штраф не назначен' }),
    );
    renderer.unmount();
  });

  it('keeps the rendered pair atomic and queues post-create refresh behind a pending filter', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%A8%D1%82%D1%80%D0%B0%D1%84%D1%8B',
    );
    const initial = penaltySnapshot('initial', 'issued');
    const filtered = penaltySnapshot('filtered', 'cancelled');
    const afterCreate = penaltySnapshot('after-create', 'cancelled');
    const requests: Array<{
      filters: PenaltySnapshotFilters;
      signal: AbortSignal;
      result: ReturnType<typeof deferred<PenaltySnapshotRuntime>>;
    }> = [];
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, {
        capabilities: ['penalty:read', 'penalty:create'],
        penaltySnapshot: initial,
      }),
    );
    mocks.fetchPenaltySnapshot.mockImplementation(
      (filters: PenaltySnapshotFilters, options: { signal: AbortSignal }) => {
        const result = deferred<PenaltySnapshotRuntime>();
        requests.push({ filters, signal: options.signal, result });
        return result.promise;
      },
    );
    mocks.createProductionOperatorPenalty.mockResolvedValue({
      ...afterCreate.items[0],
      penaltyId: 'created',
    });
    const renderer = await renderApp();

    let filterRequest!: Promise<boolean>;
    act(() => {
      filterRequest = renderer.root
        .findByType(PenaltyManagementSurface)
        .props.onFiltersChange({ status: 'cancelled' });
    });
    expect(renderer.root.findByType(PenaltyManagementSurface).props.snapshot).toBe(initial);
    expect(renderer.root.findByType(PenaltyManagementSurface).props.filters).toEqual({});

    let createRequest!: Promise<boolean>;
    await act(async () => {
      createRequest = renderer.root.findByType(PenaltyManagementSurface).props.onCreate({
        employeeId: 'operator-1',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        amountLabel: '10 ₽',
        reason: 'Брак',
        scopeObjectId: 'Заказ A-101 целиком',
        productionOrderId: 'production-order-1',
        author: 'Зав. производства',
      });
      await Promise.resolve();
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.signal.aborted).toBe(false);

    await act(async () => {
      requests[0]?.result.resolve(filtered);
      await expect(filterRequest).resolves.toBe(true);
      await Promise.resolve();
    });
    expect(requests[1]?.filters).toEqual({ status: 'cancelled' });
    expect(renderer.root.findByType(PenaltyManagementSurface).props).toMatchObject({
      snapshot: filtered,
      filters: { status: 'cancelled' },
    });

    await act(async () => {
      requests[1]?.result.resolve(afterCreate);
      await expect(createRequest).resolves.toBe(true);
    });
    expect(renderer.root.findByType(PenaltyManagementSurface).props).toMatchObject({
      snapshot: afterCreate,
      filters: { status: 'cancelled' },
    });
    renderer.unmount();
  });

  it('routes the director Problems tab to the shared read-only surface', async () => {
    installBrowser(
      'http://localhost/?role=director&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(directorSnapshot([selectedProblem]));

    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    expect(surface.props).toMatchObject({
      mode: 'director',
      problems: [expect.objectContaining({ id: selectedProblem.id })],
    });
    expect(surface.props.selectedProblemId).toBeUndefined();
    expect(surface.props.onResolveDefect).toBeUndefined();
    expect(surface.props.onResolveBreakdown).toBeUndefined();
    expect(surface.props.onResolveGeneral).toBeUndefined();
    expect(renderer.root.findAllByType(DirectorWorkbench)).toHaveLength(0);
    renderer.unmount();
  });

  it('shows the shared demo problems when the director contour is not live', async () => {
    mocks.liveContours.delete('director');
    installBrowser(
      'http://localhost/?role=director&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );

    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    expect(mocks.loadLiveRoleSnapshot).not.toHaveBeenCalled();
    expect(surface.props.mode).toBe('director');
    expect(surface.props.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'open', defectWeightSource: 'operator_scale' }),
      ]),
    );
    renderer.unmount();
  });

  it('clears a disappeared URL-selected problem atomically and does not restore it on reload', async () => {
    const browser = installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B&problem=problem-1&roll=ROLL-1&object=legacy-order&view=compact',
    );
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(productionSnapshot([selectedProblem]))
      .mockResolvedValueOnce(productionSnapshot([]));

    const renderer = await renderApp();
    expect(renderer.root.findByType(ProductionProblemsSurface).props.selectedProblemId).toBe(
      selectedProblem.id,
    );
    const replaceStateCallsBeforePoll = browser.replaceState.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(renderer.root.findByType(ProductionProblemsSurface).props.selectedProblemId).toBeNull();
    expect(browser.replaceState).toHaveBeenCalledTimes(replaceStateCallsBeforePoll + 1);
    expect(new URL(browser.href()).searchParams.get('problem')).toBeNull();
    expect(new URL(browser.href()).searchParams.get('roll')).toBeNull();
    expect(new URL(browser.href()).searchParams.get('object')).toBe('legacy-order');
    expect(new URL(browser.href()).searchParams.get('view')).toBe('compact');
    expect(productionProblemSelectionFromSearch(browser.search())).toBeNull();

    renderer.unmount();
    mocks.loadLiveRoleSnapshot.mockResolvedValueOnce(productionSnapshot([selectedProblem]));
    const reloaded = await renderApp();

    expect(reloaded.root.findByType(ProductionProblemsSurface).props.selectedProblemId).toBeNull();
    reloaded.unmount();
  });

  it('clears the exact problem URL when a mutation reload no longer returns it', async () => {
    const browser = installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B&problem=problem-1&roll=ROLL-1&object=legacy-order&view=compact',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([selectedProblem]));
    mocks.resolveProductionProblem.mockResolvedValue({
      ...selectedProblem,
      status: 'resolved',
      resolvedAt: '2026-07-23T09:00:00.000Z',
    });
    mocks.fetchProductionProblems.mockResolvedValue([]);
    mocks.fetchProductionLiveOrdersWithStatus.mockResolvedValue({
      orders: [],
      commercialActionsState: 'ready',
    });

    const renderer = await renderApp();
    const replaceStateCallsBeforeReload = browser.replaceState.mock.calls.length;
    const problemTrigger = renderer.root
      .findAllByType('button')
      .find((candidate) => candidate.props['data-problem-id'] === selectedProblem.id);
    act(() => problemTrigger?.props.onClick({ currentTarget: null }));

    await act(async () => {
      button(renderer.root, 'Решить')?.props.onClick();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
    });

    expect(mocks.resolveProductionProblem).toHaveBeenCalledWith(selectedProblem.id, {
      resolution: 'close',
      note: 'Фактическая проблема устранена зав. производства.',
    });
    expect(mocks.fetchProductionProblems).toHaveBeenCalledOnce();
    expect(renderer.root.findByType(ProductionProblemsSurface).props.selectedProblemId).toBeNull();
    expect(browser.replaceState).toHaveBeenCalledTimes(replaceStateCallsBeforeReload + 1);
    expect(new URL(browser.href()).searchParams.get('problem')).toBeNull();
    expect(new URL(browser.href()).searchParams.get('roll')).toBeNull();
    expect(new URL(browser.href()).searchParams.get('object')).toBe('legacy-order');
    expect(new URL(browser.href()).searchParams.get('view')).toBe('compact');
    expect(productionProblemSelectionFromSearch(browser.search())).toBeNull();
    renderer.unmount();
  });

  it('wires general close to the live API with busy, reload and success toast', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );
    const closeRequest = deferred<ServerProductionProblem>();
    const resolvedProblem = {
      ...generalProblem,
      status: 'resolved' as const,
      recovery: 'Сырьё доставлено, выпуск продолжен',
      resolvedAt: '2026-07-27T09:00:00.000Z',
    };
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([generalProblem]));
    mocks.resolveProductionProblem.mockReturnValue(closeRequest.promise);
    mocks.fetchProductionProblems.mockResolvedValue([resolvedProblem]);
    mocks.fetchProductionLiveOrdersWithStatus.mockResolvedValue({
      orders: [],
      commercialActionsState: 'ready',
    });
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    expect(surface.props.onResolveGeneral).toEqual(expect.any(Function));
    let resolution!: Promise<void>;
    act(() => {
      resolution = surface.props.onResolveGeneral(
        generalProblem.id,
        'Сырьё доставлено, выпуск продолжен',
      );
    });

    expect(renderer.root.findByType(ProductionProblemsSurface).props.busy).toBe(true);
    expect(mocks.resolveProductionProblem).toHaveBeenCalledWith(generalProblem.id, {
      resolution: 'close',
      note: 'Сырьё доставлено, выпуск продолжен',
    });

    closeRequest.resolve(resolvedProblem);
    await act(async () => {
      await resolution;
      await Promise.resolve();
    });

    expect(mocks.fetchProductionProblems).toHaveBeenCalledOnce();
    expect(mocks.fetchProductionLiveOrdersWithStatus).toHaveBeenCalledOnce();
    expect(renderer.root.findByType(ProductionProblemsSurface).props.busy).toBe(false);
    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: generalProblem.id,
        actionId: 'production-resolve-general',
        tone: 'success',
        title: 'Проблема закрыта',
      }),
    );
    renderer.unmount();
  });

  it('keeps a committed general close successful when the follow-up refresh fails', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([generalProblem]));
    mocks.resolveProductionProblem.mockResolvedValue({
      ...generalProblem,
      status: 'resolved',
      recovery: 'Проблема устранена',
      resolvedAt: '2026-07-27T09:00:00.000Z',
    });
    mocks.fetchProductionProblems.mockRejectedValue(new Error('Refresh unavailable'));
    mocks.fetchProductionLiveOrdersWithStatus.mockResolvedValue({
      orders: [],
      commercialActionsState: 'ready',
    });
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    await expect(
      surface.props.onResolveGeneral(generalProblem.id, 'Проблема устранена'),
    ).resolves.toBeUndefined();

    expect(renderer.root.findByType(ProductionProblemsSurface).props.busy).toBe(false);
    expect(mocks.fetchProductionProblems).toHaveBeenCalledOnce();
    expect(mocks.fetchProductionLiveOrdersWithStatus).toHaveBeenCalledOnce();
    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: generalProblem.id,
        actionId: 'production-resolve-general',
        tone: 'warning',
        title: 'Проблема закрыта',
        detail: 'Решение записано, но экран не обновился. Обновите данные повторно.',
      }),
    );
    expect(mocks.showActionToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Проблема не закрыта' }),
    );
    renderer.unmount();
  });

  it('keeps a committed mutation successful when only supplemental production actions fail', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([generalProblem]));
    mocks.resolveProductionProblem.mockResolvedValue({
      ...generalProblem,
      status: 'resolved',
      recovery: 'Проблема устранена',
      resolvedAt: '2026-07-27T09:00:00.000Z',
    });
    mocks.fetchProductionProblems.mockResolvedValue([]);
    mocks.fetchProductionLiveOrdersWithStatus.mockResolvedValue({
      orders: [],
      commercialActionsState: 'error',
    });
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    await expect(
      surface.props.onResolveGeneral(generalProblem.id, 'Проблема устранена'),
    ).resolves.toBeUndefined();

    expect(mocks.fetchProductionLiveOrdersWithStatus).toHaveBeenCalledOnce();
    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: generalProblem.id,
        actionId: 'production-resolve-general',
        tone: 'success',
        title: 'Проблема закрыта',
      }),
    );
    expect(mocks.showActionToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Проблема не закрыта' }),
    );
    renderer.unmount();
  });

  it('reports a committed queue reorder honestly when the canonical refresh fails', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%92%D1%81%D0%B5%20%D1%80%D1%83%D0%BB%D0%BE%D0%BD%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, { orders: productionWorkObjects }),
    );
    mocks.fetchProductionLiveOrdersWithStatus.mockRejectedValue(
      new Error('Список временно недоступен'),
    );
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionOrdersHubSurface);
    const rollId = productionWorkObjects[0].productionRollDispatchItems?.[0]?.id;
    expect(rollId).toBeDefined();

    await act(async () => {
      surface.props.onMoveRollQueue(rollId, 'down');
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });

    expect(mocks.reorderProductionRolls).toHaveBeenCalledOnce();
    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: rollId,
        actionId: 'production-reorder-rolls',
        tone: 'warning',
        title: 'Очередь изменена',
      }),
    );
    expect(mocks.showActionToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Очередь не изменена' }),
    );
    renderer.unmount();
  });

  it('single-flights a mounted double approval click into one production POST', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BD%D0%B0%D1%80%D1%8F%D0%B4%D1%8B',
    );
    const order = productionWorkObjects[0];
    const approval = deferred<(typeof productionWorkObjects)[number]>();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    mocks.loadLiveRoleSnapshot.mockResolvedValue(
      productionSnapshot([], undefined, { orders: [order] }),
    );
    mocks.approveProductionOrder.mockImplementation(async (orderId: string) => {
      await fetch(`/api/production/orders/${encodeURIComponent(orderId)}/approve`, {
        method: 'POST',
      });
      return approval.promise;
    });

    const renderer = await renderApp();
    const approve = button(renderer.root, 'Согласовать заказ-наряд');
    expect(approve).toBeDefined();

    act(() => {
      approve?.props.onClick({ stopPropagation: vi.fn() });
      approve?.props.onClick({ stopPropagation: vi.fn() });
    });

    expect(mocks.approveProductionOrder).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/production/orders/${encodeURIComponent(order.id)}/approve`,
      { method: 'POST' },
    );

    await act(async () => {
      approval.resolve(order);
      await approval.promise;
      await Promise.resolve();
    });
    renderer.unmount();
  });

  it('keeps the general close error observable and clears busy without reloading', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9F%D1%80%D0%BE%D0%B1%D0%BB%D0%B5%D0%BC%D1%8B',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(productionSnapshot([generalProblem]));
    mocks.resolveProductionProblem.mockRejectedValue(new Error('Backend unavailable'));
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionProblemsSurface);

    await expect(
      surface.props.onResolveGeneral(generalProblem.id, 'Проблема устранена'),
    ).rejects.toThrow('Backend unavailable');

    expect(renderer.root.findByType(ProductionProblemsSurface).props.busy).toBe(false);
    expect(mocks.fetchProductionProblems).not.toHaveBeenCalled();
    expect(mocks.fetchProductionLiveOrdersWithStatus).not.toHaveBeenCalled();
    expect(mocks.showActionToast).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'production',
        objectId: generalProblem.id,
        actionId: 'production-resolve-general',
        tone: 'critical',
        title: 'Проблема не закрыта',
        detail: 'Backend unavailable',
      }),
    );
    renderer.unmount();
  });

  it('returns the committed machine-change outcome and rejects a duplicate while keeping busy cleanup', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9E%D0%BF%D0%B5%D1%80%D0%B0%D1%82%D0%BE%D1%80%D1%8B%20%2F%20%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B0',
    );
    const request = deferred<unknown>();
    mocks.loadLiveRoleSnapshot.mockResolvedValue(planningSnapshot());
    mocks.requestIntentionalMachineChange.mockReturnValue(request.promise);
    mocks.fetchProductionShifts.mockResolvedValue([planningShift]);
    mocks.fetchProductionPosts.mockResolvedValue(planningPosts);
    mocks.fetchProductionOperatorOptions.mockResolvedValue(planningOperators);
    mocks.fetchProductionOperatorMachines.mockResolvedValue(planningSnapshot().operatorMachineView);
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionMachinePlanningSurface);

    let committed!: Promise<boolean>;
    let duplicate!: Promise<boolean>;
    act(() => {
      committed = surface.props.onIntentionalMachineChange(
        'assignment-1',
        'post-2',
        'Изменился план выпуска',
      );
      duplicate = surface.props.onIntentionalMachineChange(
        'assignment-1',
        'post-2',
        'Изменился план выпуска',
      );
    });

    await expect(duplicate).resolves.toBe(false);
    expect(renderer.root.findByType(ProductionMachinePlanningSurface).props.busy).toBe(true);
    expect(mocks.requestIntentionalMachineChange).toHaveBeenCalledOnce();
    expect(mocks.requestIntentionalMachineChange).toHaveBeenCalledWith('assignment-1', {
      postId: 'post-2',
      reason: 'Изменился план выпуска',
      operationKey: expect.any(String),
    });

    request.resolve({ id: 'change-1' });
    await act(async () => {
      await expect(committed).resolves.toBe(true);
    });

    expect(renderer.root.findByType(ProductionMachinePlanningSurface).props.busy).toBe(false);
    expect(mocks.showActionToast).toHaveBeenCalledWith({
      role: 'production',
      objectId: 'assignment-1',
      actionId: 'production-machine-change',
      tone: 'success',
      title: 'Смена станка запущена',
      detail: 'Оператору показан устойчивый сценарий завершения Big-Bag и перехода.',
    });
    renderer.unmount();
  });

  it('returns true for a committed machine change when refresh fails and preserves the warning copy', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9E%D0%BF%D0%B5%D1%80%D0%B0%D1%82%D0%BE%D1%80%D1%8B%20%2F%20%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B0',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(planningSnapshot());
    mocks.requestIntentionalMachineChange.mockResolvedValue({ id: 'change-1' });
    mocks.fetchProductionShifts.mockRejectedValue(new Error('Refresh unavailable'));
    mocks.fetchProductionPosts.mockResolvedValue(planningPosts);
    mocks.fetchProductionOperatorOptions.mockResolvedValue(planningOperators);
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionMachinePlanningSurface);

    await expect(
      surface.props.onIntentionalMachineChange('assignment-1', 'post-2', 'Изменился план выпуска'),
    ).resolves.toBe(true);

    expect(renderer.root.findByType(ProductionMachinePlanningSurface).props.busy).toBe(false);
    expect(mocks.showActionToast).toHaveBeenCalledWith({
      role: 'production',
      objectId: 'assignment-1',
      actionId: 'production-machine-change',
      tone: 'warning',
      title: 'Смена станка запущена',
      detail: 'Команда записана, но экран не обновился. Обновите данные повторно.',
    });
    renderer.unmount();
  });

  it('returns false for a rejected machine change and preserves the critical toast wording', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%9E%D0%BF%D0%B5%D1%80%D0%B0%D1%82%D0%BE%D1%80%D1%8B%20%2F%20%D0%B7%D0%B0%D0%B3%D1%80%D1%83%D0%B7%D0%BA%D0%B0',
    );
    mocks.loadLiveRoleSnapshot.mockResolvedValue(planningSnapshot());
    mocks.requestIntentionalMachineChange.mockRejectedValue(new Error('Backend unavailable'));
    const renderer = await renderApp();
    const surface = renderer.root.findByType(ProductionMachinePlanningSurface);

    await expect(
      surface.props.onIntentionalMachineChange('assignment-1', 'post-2', 'Изменился план выпуска'),
    ).resolves.toBe(false);

    expect(renderer.root.findByType(ProductionMachinePlanningSurface).props.busy).toBe(false);
    expect(mocks.fetchProductionShifts).not.toHaveBeenCalled();
    expect(mocks.showActionToast).toHaveBeenCalledWith({
      role: 'production',
      objectId: 'assignment-1',
      actionId: 'production-machine-change',
      tone: 'critical',
      title: 'Смена станка не запущена',
      detail: 'Backend unavailable',
    });
    renderer.unmount();
  });

  it('preserves loaded inbox history, unread total, and cursor after a transient poll error', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BD%D0%B0%D1%80%D1%8F%D0%B4%D1%8B',
    );
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(
        productionSnapshot([], inboxPage(['event-new', 'event-old'], 'cursor-history', 17)),
      )
      .mockRejectedValueOnce(new Error('temporary offline'));

    const renderer = await renderApp();
    act(() => {
      renderer.root.findByType(ProductHeader).props.onOpenPanel('notifications');
    });

    expect(renderer.root.findByType(NotificationCenter).props).toMatchObject({
      unreadCount: 17,
      hasMore: true,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    const inbox = renderer.root.findByType(NotificationCenter);
    expect(inbox.props.notifications.map((item: NotificationItem) => item.id)).toEqual([
      'event-new',
      'event-old',
    ]);
    expect(inbox.props.unreadCount).toBe(17);
    expect(inbox.props.hasMore).toBe(true);
    renderer.unmount();
  });

  it('rejects a late load-more response after a newer poll commits its inbox frontier', async () => {
    installBrowser(
      'http://localhost/?role=production&section=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7-%D0%BD%D0%B0%D1%80%D1%8F%D0%B4%D1%8B',
    );
    const lateOlderPage = deferred<RoleInboxPage>();
    let lateSignal: AbortSignal | undefined;
    mocks.loadLiveRoleSnapshot
      .mockResolvedValueOnce(
        productionSnapshot([], inboxPage(['event-initial'], 'cursor-initial', 5)),
      )
      .mockResolvedValueOnce(productionSnapshot([], inboxPage(['event-fresh'], 'cursor-fresh', 1)));
    mocks.fetchRoleInbox
      .mockImplementationOnce((_role, options: { signal?: AbortSignal }) => {
        lateSignal = options.signal;
        return lateOlderPage.promise;
      })
      .mockResolvedValueOnce(inboxPage([], null, 1));

    const renderer = await renderApp();
    act(() => {
      renderer.root.findByType(ProductHeader).props.onOpenPanel('notifications');
    });
    act(() => {
      renderer.root.findByType(NotificationCenter).props.onLoadMore();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(lateSignal?.aborted).toBe(true);

    await act(async () => {
      lateOlderPage.resolve(inboxPage(['event-stale-older'], 'cursor-stale', 99));
      await Promise.resolve();
      await Promise.resolve();
    });

    const refreshedInbox = renderer.root.findByType(NotificationCenter);
    expect(refreshedInbox.props.notifications.map((item: NotificationItem) => item.id)).toEqual([
      'event-fresh',
      'event-initial',
    ]);
    expect(refreshedInbox.props.unreadCount).toBe(1);
    expect(refreshedInbox.props.hasMore).toBe(true);

    act(() => {
      refreshedInbox.props.onLoadMore();
    });
    expect(mocks.fetchRoleInbox).toHaveBeenLastCalledWith(
      'production',
      expect.objectContaining({ cursor: 'cursor-fresh' }),
    );
    renderer.unmount();
  });
});
