import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, saveSession } from './authStorage';
import {
  approveProductionTechnicalCover,
  approveProductionOrder,
  assignProductionOperatorMachine,
  assignProductionRoll,
  batchUpdateProductionRolls,
  cancelProductionAssignment,
  cancelProductionMachineChange,
  fetchProductionArchive,
  fetchProductionLiveOrders,
  fetchProductionLiveOrdersWithStatus,
  fetchProductionOrders,
  mergeProductionOrdersWithCommercialActions,
  normalizeProductionWarehouseCoverage,
  PRODUCTION_COMMERCIAL_ACTION_PAGE_LIMIT,
  resolveProductionProblem,
  selectProductionPlanningShift,
  type ServerProductionOrder,
} from './production';
import type { WorkObject } from '../domain/types';
import type { CommercialOrderSummaryContract } from '../features/commercial/contracts';

const serverOrder: ServerProductionOrder = {
  id: 'po-1',
  commercialOrderId: 'co-1',
  indicator: 'needs_production',
  approvalState: 'pending',
  assignedOwnerId: null,
  blockers: [],
  canApprove: true,
  approvalProblems: [],
  defectRollCount: 1,
  verifiedDefectKg: 1.25,
  returnedSpoolCount: 1,
  createdAt: '2026-07-10T08:00:00.000Z',
  updatedAt: '2026-07-10T08:05:00.000Z',
  commercialOrder: {
    id: 'co-1',
    orderNumber: 'A-501',
    creatorRole: 'commercial',
    counterpartyId: 'cp-1',
    requestType: 'client_order',
    productionIndicator: 'needs_production',
    warehouseCoverStatus: 'needs_production',
    paymentStatus: 'partial',
    shipmentStatus: 'not_shipped',
    warehouseCoverageWorkflowVersion: 1,
    commercialConfirmationPolicy: 'required',
    createdAt: '2026-07-10T07:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
    externalId: null,
    sourceVersion: null,
    counterparty: {
      id: 'cp-1',
      displayName: 'УралПак',
      legalName: null,
      inn: null,
      billingSource: 'manual_platform',
      syncStatus: 'ready',
    },
    stockBatchCode: null,
  },
  dispatchItems: [
    {
      id: 'roll-row-1',
      rollCode: 'A-501-roll-1',
      productionOrderId: 'po-1',
      orderLineId: 'line-1',
      positionSequence: 1,
      rawMaterialId: null,
      recipeVersion: null,
      filmType: 'Рукав',
      plannedWeightKg: 41.2,
      plannedLengthM: 500,
      widthMm: 1700,
      characteristicsSnapshot: {
        actualThickness: '78 мкм',
        accountingThickness: '80 мкм',
        widthMm: 1700,
      },
      assignedOperatorId: 'op-1',
      assignedOperator: { id: 'op-1', displayName: 'Сергей Волков' },
      plannedShiftId: 'shift-1',
      machineId: 'POST-1',
      workplaceId: null,
      postId: 'post-1',
      post: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1', status: 'active' },
      queueRank: 12,
      priority: 50,
      status: 'new',
      bulkGroupId: null,
      replacesDispatchItemId: null,
      completedAt: null,
      operatorLine: null,
      createdAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:05:00.000Z',
    },
  ],
};

function archiveDispatchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'roll-row-1',
    rollCode: 'A-501-roll-1',
    productionOrderId: 'po-1',
    orderLineId: 'line-1',
    positionSequence: 1,
    rawMaterialId: null,
    recipeVersion: null,
    filmType: 'Рукав',
    plannedWeightKg: 41.2,
    plannedLengthM: 500,
    characteristicsSnapshot: {
      actualThickness: '78 мкм',
      accountingThickness: '80 мкм',
      widthMm: 1700,
    },
    assignedOperatorId: 'op-1',
    assignedOperator: { id: 'op-1', displayName: 'Сергей Волков' },
    machineId: 'POST-1',
    workplaceId: null,
    postId: 'post-1',
    post: { id: 'post-1', code: 'POST-1', name: 'Экструдер 1', status: 'active' },
    plannedShiftId: 'shift-1',
    queueRank: 12,
    priority: 50,
    status: 'done',
    bulkGroupId: null,
    replacesDispatchItemId: null,
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T11:30:00.000Z',
    completedAt: '2026-07-10T11:30:00.000Z',
    productionOrder: {
      id: 'po-1',
      approvalState: 'approved',
      commercialOrder: {
        id: 'co-1',
        orderNumber: 'A-501',
        counterparty: { id: 'cp-1', displayName: 'УралПак' },
      },
    },
    ...overrides,
  };
}

const technicalCoverOrder = {
  id: 'co-cover-1',
  orderNumber: 'A-502',
  title: 'Техническая проверка покрытия',
  comment: null,
  commentVersion: 1,
  version: 3,
  bucket: 'incoming',
  requestType: 'client_order',
  stockBatchCode: null,
  counterparty: {
    id: 'cp-cover-1',
    displayName: 'Клиент Б',
    legalName: 'ООО СЕКРЕТНОЕ НАЗВАНИЕ',
    inn: 'SECRET-INN-7700',
  },
  positionCount: 2,
  requestedQty: 7,
  indicators: {
    production: 'needs_production',
    warehouseCover: 'partial_proposed',
    payment: 'unpaid',
    shipment: 'not_shipped',
  },
  commercialCompletion: {
    state: 'incomplete',
    requestedQty: 7,
    fulfilledQty: 0,
    blockingReasons: ['cover_unresolved'],
  },
  nextAction: {
    code: 'technical_approve_cover',
    ownerRole: 'production_lead',
    label: 'Подтвердить техническую пригодность',
    allowed: true,
  },
  actionPriority: 10,
  createdAt: '2026-07-10T07:00:00.000Z',
  updatedAt: '2026-07-10T08:00:00.000Z',
} satisfies CommercialOrderSummaryContract;

function okResponse(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

beforeEach(() => clearSession());
afterEach(() => vi.unstubAllGlobals());

describe('production live API', () => {
  it('never forwards browser-supplied defect weight during resolution', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await resolveProductionProblem('defect / 1', {
      resolution: 'writeoff',
      note: 'Полотно восстановить нельзя',
      weightKg: 42.6,
    } as never);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/problems/defect%20%2F%201/resolve');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      resolution: 'writeoff',
      note: 'Полотно восстановить нельзя',
    });
  });

  it('forwards an audited close resolution for a general production problem', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await resolveProductionProblem('general / 1', {
      resolution: 'close',
      note: 'Сырьё доставлено, выпуск продолжен',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/problems/general%20%2F%201/resolve');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
      resolution: 'close',
      note: 'Сырьё доставлено, выпуск продолжен',
    });
  });

  it('loads production-safe commercial actions from incoming and in-work buckets', async () => {
    saveSession({
      version: 1,
      token: 'production-token',
      role: 'production',
      serverRole: 'production_lead',
      userId: 'production-user',
      displayName: 'Зав. производства',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') return Promise.resolve(okResponse([]));
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [technicalCoverOrder], nextCursor: null }));
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchProductionLiveOrders();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'co-cover-1',
      actions: [expect.objectContaining({ id: 'production-technical-approve-cover:co-cover-1' })],
    });
    for (const bucket of ['incoming', 'in_work']) {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/commercial/orders?bucket=${bucket}&mode=action_required&limit=100`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({ Authorization: 'Bearer production-token' }),
        }),
      );
    }
  });

  it('traverses both commercial action queues, encodes cursors, and deduplicates orders', async () => {
    const secondOrder = {
      ...technicalCoverOrder,
      id: 'co-cover-2',
      orderNumber: 'A-503',
    };
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      const responses: Record<string, unknown> = {
        '/api/production/orders': [],
        '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100': {
          items: [technicalCoverOrder],
          nextCursor: 'incoming+2',
        },
        '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100&cursor=incoming%2B2':
          {
            items: [secondOrder],
            nextCursor: null,
          },
        '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100': {
          items: [technicalCoverOrder],
          nextCursor: 'in/work:2',
        },
        '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100&cursor=in%2Fwork%3A2':
          {
            items: [],
            nextCursor: null,
          },
      };
      if (!(path in responses)) throw new Error(`Unexpected path: ${path}`);
      return Promise.resolve(okResponse(responses[path]));
    });
    vi.stubGlobal('fetch', fetchMock);

    const rows = await fetchProductionLiveOrders();

    expect(rows.map((row) => row.id)).toEqual(['co-cover-1', 'co-cover-2']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('fails closed when a commercial action cursor cycles', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') return Promise.resolve(okResponse([]));
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: 'loop' }));
      }
      if (
        path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100&cursor=loop'
      ) {
        return Promise.resolve(okResponse({ items: [], nextCursor: 'loop' }));
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionLiveOrders()).rejects.toThrow(
      'Зацикленная пагинация очереди коммерческих действий.',
    );
  });

  it('fails closed instead of silently truncating an unbounded commercial action queue', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') return Promise.resolve(okResponse([]));
      if (path.startsWith('/api/commercial/orders?bucket=incoming&')) {
        const cursor = new URL(`http://test${path}`).searchParams.get('cursor');
        const page = cursor === null ? 1 : Number(cursor.replace('page-', ''));
        return Promise.resolve(okResponse({ items: [], nextCursor: `page-${page + 1}` }));
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionLiveOrders()).rejects.toThrow(
      'Превышен лимит страниц очереди коммерческих действий.',
    );
    expect(
      fetchMock.mock.calls.filter(([path]) => String(path).includes('bucket=incoming')).length,
    ).toBe(PRODUCTION_COMMERCIAL_ACTION_PAGE_LIMIT);
  });

  it('does not silently turn a failed commercial action queue into an empty list', async () => {
    saveSession({
      version: 1,
      token: 'production-token',
      role: 'production',
      serverRole: 'production_lead',
      userId: 'production-user',
      displayName: 'Зав. производства',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') {
        return Promise.resolve(okResponse([serverOrder]));
      }
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ message: 'Invalid persisted productionIndicator' }),
        });
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionLiveOrders()).rejects.toMatchObject({
      status: 500,
      message: 'Invalid persisted productionIndicator',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps canonical production rows while reporting an unavailable commercial action queue', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') return Promise.resolve(okResponse([serverOrder]));
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: async () => ({ message: 'Commercial action queue unavailable' }),
        });
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchProductionLiveOrdersWithStatus({ signal: controller.signal }),
    ).resolves.toEqual({
      orders: [
        expect.objectContaining({
          id: serverOrder.id,
          commercialOrder: expect.objectContaining({ id: serverOrder.commercialOrder.id }),
        }),
      ],
      commercialActionsState: 'error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ signal: controller.signal }));
    }
  });

  it('keeps canonical production rows while rejecting a malformed commercial action item', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') return Promise.resolve(okResponse([serverOrder]));
      if (path === '/api/commercial/orders?bucket=incoming&mode=action_required&limit=100') {
        return Promise.resolve(
          okResponse({
            items: [{ ...technicalCoverOrder, positionCount: -1 }],
            nextCursor: null,
          }),
        );
      }
      if (path === '/api/commercial/orders?bucket=in_work&mode=action_required&limit=100') {
        return Promise.resolve(okResponse({ items: [], nextCursor: null }));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionLiveOrdersWithStatus()).resolves.toEqual({
      orders: [expect.objectContaining({ id: serverOrder.id })],
      commercialActionsState: 'error',
    });
  });

  it('sequentially approves every current commercial-approved technical proposal without creating production', async () => {
    const eligible = {
      id: 'proposal / 1',
      version: 4,
      commercialApproved: true,
      technicalApproved: false,
      stale: false,
    };
    const secondEligible = { ...eligible, id: 'proposal-2', version: 7 };
    const detail = {
      positions: [
        {
          id: 'position / 1',
          coverProposals: [
            eligible,
            { ...eligible, id: 'stale', stale: true },
            { ...eligible, id: 'not-commercial-approved', commercialApproved: false },
            { ...eligible, id: 'already-technical', technicalApproved: true },
          ],
        },
        { id: 'position-2', coverProposals: [secondEligible] },
      ],
    };
    let resolveFirstApproval!: (response: ReturnType<typeof okResponse>) => void;
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/commercial/orders/order%20%2F%201') {
        return Promise.resolve(okResponse(detail));
      }
      if (path.includes('/proposal%20%2F%201/technical-approval')) {
        return new Promise((resolve) => {
          resolveFirstApproval = resolve;
        });
      }
      if (path.includes('/proposal-2/technical-approval')) {
        return Promise.resolve(okResponse(secondEligible));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = approveProductionTechnicalCover('order / 1');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('proposal-2'))).toBe(false);

    resolveFirstApproval(okResponse(eligible));
    await expect(resultPromise).resolves.toEqual({
      orderId: 'order / 1',
      approvedProposalIds: ['proposal / 1', 'proposal-2'],
    });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/commercial/orders/order%20%2F%201',
      '/api/commercial/orders/order%20%2F%201/positions/position%20%2F%201/warehouse-cover/proposal%20%2F%201/technical-approval',
      '/api/commercial/orders/order%20%2F%201/positions/position-2/warehouse-cover/proposal-2/technical-approval',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual({
      expectedVersion: 4,
    });
    expect(JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string)).toEqual({
      expectedVersion: 7,
    });
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/production/orders'))).toBe(
      false,
    );
  });

  it('reports confirmed, uncertain and unattempted proposals after a partial approval failure', async () => {
    const proposal = (id: string, version: number) => ({
      id,
      version,
      commercialApproved: true,
      technicalApproved: false,
      stale: false,
    });
    const detail = {
      positions: [
        { id: 'position-1', coverProposals: [proposal('proposal-1', 1)] },
        { id: 'position-2', coverProposals: [proposal('proposal-2', 2)] },
        { id: 'position-3', coverProposals: [proposal('proposal-3', 3)] },
      ],
    };
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/commercial/orders/order-partial')
        return Promise.resolve(okResponse(detail));
      if (path.includes('/proposal-1/technical-approval')) {
        return Promise.resolve(okResponse({ id: 'proposal-1' }));
      }
      if (path.includes('/proposal-2/technical-approval')) {
        return Promise.reject(new TypeError('network interrupted'));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await approveProductionTechnicalCover('order-partial').catch(
      (error: unknown) => error,
    );

    expect(outcome).toMatchObject({
      name: 'ProductionTechnicalCoverReconciliationError',
      orderId: 'order-partial',
      approvedProposalIds: ['proposal-1'],
      uncertainProposalId: 'proposal-2',
      unattemptedProposalIds: ['proposal-3'],
    });
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes('proposal-3'))).toBe(false);
  });

  it('merges a role-safe pre-production technical-cover row keyed by commercial order id', () => {
    const [row] = mergeProductionOrdersWithCommercialActions([], [technicalCoverOrder]);

    expect(row).toMatchObject({
      id: 'co-cover-1',
      kind: 'productionOrder',
      title: 'Готовность к выпуску A-502',
      statusLabel: 'Требует решения',
      nextOwner: 'Зав. производства',
      filterTags: expect.arrayContaining(['Заказ-наряды', 'Требуют действия']),
      actions: [
        expect.objectContaining({
          id: 'production-technical-approve-cover:co-cover-1',
          label: 'Подтвердить техническую пригодность',
          enabled: true,
        }),
      ],
    });
    expect(row?.facts).toContainEqual({
      label: 'Контрагент',
      value: 'Клиент Б',
      scope: 'production',
    });
    expect(JSON.stringify(row)).not.toContain('ООО СЕКРЕТНОЕ НАЗВАНИЕ');
    expect(JSON.stringify(row)).not.toContain('SECRET-INN-7700');
    expect(mergeProductionOrdersWithCommercialActions([], [])).toEqual([]);
  });

  it('does not add a pre-production row when the real production order already owns it', () => {
    const realProductionOrder = {
      id: 'po-cover-1',
      kind: 'productionOrder',
      commercialOrder: { id: technicalCoverOrder.id },
    } as WorkObject;

    expect(
      mergeProductionOrdersWithCommercialActions(
        [realProductionOrder],
        [technicalCoverOrder, technicalCoverOrder],
      ),
    ).toEqual([realProductionOrder]);
  });

  it('maps canonical queue and real operator/post labels without a manual publish action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([serverOrder])));

    const [result] = await fetchProductionOrders();
    const roll = result.productionRollDispatchItems?.[0];

    expect(result.statusLabel).toBe('Назначение не завершено');
    expect(result.facts).toEqual(
      expect.arrayContaining([
        { label: 'Брак', value: '1 рул. · 1.25 кг', scope: 'production' },
        { label: 'Шпули возвращены', value: '1 шт.', scope: 'production' },
      ]),
    );
    expect(result.actions.some((action) => action.id.startsWith('production-approve-order:'))).toBe(
      false,
    );
    expect(roll).toEqual(
      expect.objectContaining({
        queueRank: 12,
        operatorId: 'op-1',
        operatorLabel: 'Сергей Волков',
        machineId: 'POST-1',
        machineLabel: 'Экструдер 1',
        shiftId: 'shift-1',
        priority: 'срочно',
        meterageMeters: 500,
        plannedLengthM: 500,
        widthMm: 1700,
        actualThickness: '78 мкм',
        accountingThickness: '80 мкм',
        status: 'queued',
        publicationState: 'draft',
      }),
    );
  });

  it.each(['PRODUCTION_ORDER_RESPONSE_TOO_LARGE', 'PRODUCTION_ORDER_CATALOG_TOO_LARGE'])('retries %s through the bounded approval buckets', async (code) => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/production/orders') {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({
            code,
            message: 'Слишком много фактов заказа для безопасной выдачи.',
          }),
        });
      }
      if (path === '/api/production/orders?bucket=needs_approval') {
        return Promise.resolve(okResponse([serverOrder]));
      }
      if (path === '/api/production/orders?bucket=approved') {
        return Promise.resolve(okResponse([]));
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchProductionOrders()).resolves.toHaveLength(1);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/production/orders',
      '/api/production/orders?bucket=needs_approval',
      '/api/production/orders?bucket=approved',
    ]);
  });

  it('maps the canonical V2 route summary without protected roll details', async () => {
    const coverage = {
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 5,
      generation: 4,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'commercial',
      availableActions: [],
      requiredRollCount: 3,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-25T08:00:00.000Z',
      stale: false,
      financeRolls: [{ rollCode: 'SECRET-ROLL' }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            commercialOrder: {
              ...serverOrder.commercialOrder,
              warehouseCoverageWorkflowVersion: 2,
            },
            coverage,
            productionQty: 3,
            sourceGeneration: 4,
          },
        ]),
      ),
    );

    const [result] = await fetchProductionOrders();

    expect(result).toMatchObject({
      warehouseCoverageWorkflowVersion: 2,
      productionQty: 3,
      sourceGeneration: 4,
      productionOrderId: 'po-1',
      coverage: {
        state: 'production_required',
        generation: 4,
      },
    });
    expect(JSON.stringify(result.coverage)).not.toContain('SECRET-ROLL');
  });

  it('rejects an incomplete V2 production route instead of inventing a quantity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            commercialOrder: {
              ...serverOrder.commercialOrder,
              warehouseCoverageWorkflowVersion: 2,
            },
            coverage: {
              workflowVersion: 2,
              state: 'unknown',
              stateVersion: 5,
              generation: 4,
              availability: 'unknown',
              reasonCodes: ['roll_facts_incomplete'],
              nextOwner: 'warehouse',
              availableActions: [],
              requiredRollCount: 3,
              matchedRollCount: 0,
              uncertainRollCount: 3,
              calculatedAt: '2026-07-25T08:00:00.000Z',
              stale: false,
            },
            sourceGeneration: null,
          },
        ]),
      ),
    );

    await expect(fetchProductionOrders()).rejects.toThrow(
      'Некорректный ответ производственных заказов.',
    );
  });

  it.each([
    ['missing approval state', { ...serverOrder, approvalState: undefined }],
    ['unknown production indicator', { ...serverOrder, indicator: 'new_backend_state' }],
    [
      'negative dispatch priority',
      {
        ...serverOrder,
        dispatchItems: [{ ...serverOrder.dispatchItems[0], priority: -1 }],
      },
    ],
    [
      'malformed counterparty projection',
      {
        ...serverOrder,
        commercialOrder: {
          ...serverOrder.commercialOrder,
          counterparty: { ...serverOrder.commercialOrder.counterparty, displayName: 42 },
        },
      },
    ],
  ])('rejects a malformed production-order 2xx row: %s', async (_label, row) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([row])));

    await expect(fetchProductionOrders()).rejects.toThrow(
      'Некорректный ответ производственных заказов.',
    );
  });

  it('rejects missing canonical quality counts instead of fabricating zero facts', async () => {
    const {
      defectRollCount: _defect,
      verifiedDefectKg: _kg,
      returnedSpoolCount: _spools,
      ...row
    } = serverOrder;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([row])));

    await expect(fetchProductionOrders()).rejects.toThrow(
      'Некорректный ответ производственных заказов.',
    );
  });

  it('preserves a nullable planned roll weight as unavailable instead of projecting zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            dispatchItems: [{ ...serverOrder.dispatchItems[0], plannedWeightKg: null }],
          },
        ]),
      ),
    );

    const [result] = await fetchProductionOrders();
    const roll = result.productionRollDispatchItems?.[0];

    expect(roll?.plannedNetKg).toBeUndefined();
    expect(roll?.status).toBe('blocked');
    expect(roll?.blocker).toContain('плановый вес');
    expect(result.rollGroups?.[0]?.plannedNetKg).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('0 кг');
  });

  it('rejects a zero planned roll weight instead of projecting it as a business fact', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            dispatchItems: [{ ...serverOrder.dispatchItems[0], plannedWeightKg: 0 }],
          },
        ]),
      ),
    );

    await expect(fetchProductionOrders()).rejects.toThrow(
      'Некорректный ответ производственных заказов.',
    );
  });

  it('maps approved production as in production, not ready for invoice', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse([{ ...serverOrder, approvalState: 'approved', indicator: 'in_production' }]),
        ),
    );

    const [result] = await fetchProductionOrders();

    expect(result.statusLabel).toBe('В производстве');
    expect(result.nextOwner).toBe('Операторы');
    expect(result.filterTags).not.toContain('Готовы к счету');
    expect(result.productionRollDispatchItems?.[0]?.publicationState).toBe('published');
  });

  it('maps the same two received roll identities to the accepted terminal production state', async () => {
    const received = (id: string, rollCode: string) => ({
      ...serverOrder.dispatchItems[0],
      id,
      rollCode,
      status: 'done' as const,
      completedAt: '2026-07-10T11:30:00.000Z',
      operatorLine: { netKg: 40.9, step: 'warehouse', warehouseState: 'received' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            approvalState: 'approved',
            dispatchItems: [
              received('roll-row-1', 'A-501-roll-1'),
              received('roll-row-2', 'A-501-roll-2'),
            ],
          },
        ]),
      ),
    );

    const [result] = await fetchProductionOrders();

    expect(result.statusLabel).toBe('Принят складом');
    expect(result.productionRollDispatchItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'roll-row-1',
          rollId: 'A-501-roll-1',
          status: 'warehouse_accepted',
          actualNetKg: 40.9,
          completedAt: '2026-07-10T11:30:00.000Z',
        }),
        expect.objectContaining({
          id: 'roll-row-2',
          rollId: 'A-501-roll-2',
          status: 'warehouse_accepted',
        }),
      ]),
    );
    expect(new Set(result.productionRollDispatchItems?.map((item) => item.id)).size).toBe(2);
    expect(result.filterTags).not.toContain('Готовы к счету');
  });

  it.each([
    ['sent', 'warehouse_handed_off', 'Передан на склад'],
    ['delivered', 'warehouse_delivered', 'Выдан со склада'],
    ['future_state', 'warehouse_pending', 'Ждет склад'],
  ])(
    'maps canonical warehouse state %s without inventing a newer lifecycle',
    async (warehouseState, expectedRollStatus, expectedOrderStatus) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          okResponse([
            {
              ...serverOrder,
              approvalState: 'approved',
              dispatchItems: [
                {
                  ...serverOrder.dispatchItems[0],
                  status: 'done',
                  completedAt: '2026-07-10T11:30:00.000Z',
                  operatorLine: { netKg: 40.9, step: 'warehouse', warehouseState },
                },
              ],
            },
          ]),
        ),
      );

      const [result] = await fetchProductionOrders();

      expect(result.productionRollDispatchItems?.[0]?.status).toBe(expectedRollStatus);
      expect(result.statusLabel).toBe(expectedOrderStatus);
    },
  );

  it('assignProductionRoll posts only the operator to the escaped roll route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse(serverOrder.dispatchItems[0]));
    vi.stubGlobal('fetch', fetchMock);

    await assignProductionRoll('A/501 roll', { operatorId: 'op-1' });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/production/roll-dispatch/A%2F501%20roll/assign',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ operatorId: 'op-1' });
  });

  it('approveProductionOrder posts the selected order and maps the approved response', async () => {
    const approvedOrder = {
      ...serverOrder,
      id: 'po / 1',
      approvalState: 'approved' as const,
      indicator: 'in_production',
      dispatchItems: serverOrder.dispatchItems.map((item) => ({
        ...item,
        productionOrderId: 'po / 1',
      })),
    };
    const fetchMock = vi.fn().mockResolvedValue(okResponse(approvedOrder));
    vi.stubGlobal('fetch', fetchMock);

    const result = await approveProductionOrder('po / 1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/orders/po%20%2F%201/approve');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('POST');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/production/orders/po%20%2F%201');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe('GET');
    expect(result).toMatchObject({ statusLabel: 'В производстве', nextOwner: 'Операторы' });
  });

  it('treats malformed approval 2xx plus failed detail reconciliation as uncertain', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ id: 'po / 1', approvalState: 'approved' }))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ message: 'detail temporarily unavailable' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(approveProductionOrder('po / 1')).rejects.toMatchObject({
      name: 'ProductionApprovalReconciliationError',
      orderId: 'po / 1',
      committed: false,
    });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/production/orders/po%20%2F%201/approve',
      '/api/production/orders/po%20%2F%201',
    ]);
  });

  it('reports a committed approval honestly when the exact detail refresh fails', async () => {
    const approvedOrder = { ...serverOrder, approvalState: 'approved', indicator: 'in_production' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse(approvedOrder))
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ message: 'detail temporarily unavailable' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(approveProductionOrder('po-1')).rejects.toMatchObject({
      name: 'ProductionApprovalReconciliationError',
      orderId: 'po-1',
      committed: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('batchUpdateProductionRolls sends only supplied selected changes', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ updated: 1 }));
    vi.stubGlobal('fetch', fetchMock);

    await batchUpdateProductionRolls([{ rollId: 'roll-1', operatorId: 'op-1', priority: 100 }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/roll-dispatch/batch-update');
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      changes: [{ rollId: 'roll-1', operatorId: 'op-1', priority: 100 }],
    });
  });

  it('prefers the current open shift over a future planned shift', () => {
    const shifts = [
      {
        id: 'future-shift',
        label: 'Будущая смена',
        plannedStartAt: '2030-01-02T08:00:00.000Z',
        plannedEndAt: '2030-01-02T20:00:00.000Z',
        status: 'planned' as const,
      },
      {
        id: 'open-shift',
        label: 'Текущая смена',
        plannedStartAt: '2030-01-01T08:00:00.000Z',
        plannedEndAt: '2030-01-01T20:00:00.000Z',
        status: 'open' as const,
      },
    ];

    expect(
      selectProductionPlanningShift(shifts, undefined, new Date('2030-01-01T12:00:00Z'))?.id,
    ).toBe('open-shift');
    expect(
      selectProductionPlanningShift(shifts, 'future-shift', new Date('2030-01-01T12:00:00Z'))?.id,
    ).toBe('future-shift');
  });

  it('selects the first server-ordered planned shift without browser-time actionability', () => {
    const shifts = [
      {
        id: 'first-planned',
        label: 'Индивидуальная смена',
        plannedStartAt: null,
        plannedEndAt: null,
        status: 'planned' as const,
      },
      {
        id: 'dated-planned',
        label: 'Legacy',
        plannedStartAt: '2030-01-02T08:00:00.000Z',
        plannedEndAt: '2030-01-02T20:00:00.000Z',
        status: 'planned' as const,
      },
    ];

    expect(selectProductionPlanningShift(shifts, undefined, new Date(0))?.id).toBe('first-planned');
    expect(
      selectProductionPlanningShift(shifts, undefined, new Date('2099-01-01T00:00:00Z'))?.id,
    ).toBe('first-planned');
  });

  it('assignProductionOperatorMachine uses PUT on the shift operator resource', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: 'assignment-1' }));
    vi.stubGlobal('fetch', fetchMock);

    await assignProductionOperatorMachine('shift/1', 'operator 1', 'post-1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/production/shifts/shift%2F1/operators/operator%201/machine',
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe('PUT');
  });

  it('translates technical blocker reasons into Russian for orders and rolls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            blockers: ['operator is not assigned; machine is not assigned'],
            canApprove: false,
            approvalProblems: [
              {
                rollId: 'A-501-roll-1',
                reasons: ['shift is not assigned', 'unknown backend text'],
              },
            ],
          },
        ]),
      ),
    );

    const [result] = await fetchProductionOrders();

    expect(result.problems.map((problem) => problem.reason)).toEqual(
      expect.arrayContaining([
        'не назначен оператор; не назначен станок',
        'не назначена смена; unknown backend text',
      ]),
    );
    expect(result.actions.some((action) => action.id.startsWith('production-approve-order:'))).toBe(
      false,
    );
  });

  it('maps a quarantined roll weight to a visible production recovery without losing the order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            approvalState: 'approved',
            indicator: 'in_production',
            canApprove: false,
            approvalProblems: [
              {
                rollId: 'A-501-roll-1',
                reasons: ['roll weight is invalid'],
              },
            ],
            dispatchItems: [
              {
                ...serverOrder.dispatchItems[0],
                status: 'deferred',
                operatorLine: {
                  netKg: null,
                  step: 'deferred',
                  warehouseState: 'not_ready',
                },
              },
            ],
          },
        ]),
      ),
    );

    const [result] = await fetchProductionOrders();

    expect(result.title).toBe('Заказ-наряд A-501');
    expect(result.productionRollDispatchItems?.[0]?.actualNetKg).toBeUndefined();
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        title: 'Не готов A-501-roll-1',
        reason: 'некорректный вес рулона',
        recovery: 'Остановить передачу рулона и провести контролируемую сверку веса',
      }),
    );
  });

  it('still rejects a raw negative roll weight instead of weakening the fail-closed contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse([
          {
            ...serverOrder,
            dispatchItems: [
              {
                ...serverOrder.dispatchItems[0],
                operatorLine: {
                  netKg: -0.55,
                  step: 'deferred',
                  warehouseState: 'not_ready',
                },
              },
            ],
          },
        ]),
      ),
    );

    await expect(fetchProductionOrders()).rejects.toThrow(
      'Некорректный ответ производственных заказов.',
    );
  });

  it('fetchProductionArchive queries scope=archive with the period and maps order context', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(okResponse([archiveDispatchRow()]));
    vi.stubGlobal('fetch', fetchMock);

    const rolls = await fetchProductionArchive('2026-07-01', '2026-07-14', {
      signal: controller.signal,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/production/roll-dispatch?scope=archive&dateFrom=2026-07-01&dateTo=2026-07-14',
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(rolls[0]).toEqual(
      expect.objectContaining({
        rollId: 'A-501-roll-1',
        orderNumber: 'A-501',
        customerAlias: 'УралПак',
        status: 'warehouse_pending',
        completedAt: '2026-07-10T11:30:00.000Z',
        operatorLabel: 'Сергей Волков',
      }),
    );
    expect(rolls[0]?.actualNetKg).toBeUndefined();
  });

  it('preserves a missing archive planned weight without fabricating zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse([archiveDispatchRow({ plannedWeightKg: null })])),
    );

    const rolls = await fetchProductionArchive('2026-07-01', '2026-07-14');

    expect(rolls[0]?.plannedNetKg).toBeUndefined();
    expect(JSON.stringify(rolls)).not.toContain('0 кг');
  });

  it('rejects a zero archive planned weight instead of rendering a false plan', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse([archiveDispatchRow({ plannedWeightKg: 0 })])),
    );

    await expect(fetchProductionArchive('2026-07-01', '2026-07-14')).rejects.toThrow(
      'Некорректный ответ архива производства.',
    );
  });

  it.each([null, 'not-a-date'])(
    'rejects an archive row without a canonical completion timestamp: %s',
    async (completedAt) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(okResponse([archiveDispatchRow({ completedAt })])),
      );

      await expect(fetchProductionArchive('2026-07-01', '2026-07-14')).rejects.toThrow(
        'Некорректный ответ архива производства',
      );
    },
  );

  it.each([
    [
      'missing approval',
      () => {
        const row = archiveDispatchRow();
        delete (row.productionOrder as Record<string, unknown>).approvalState;
        return row;
      },
    ],
    [
      'missing order number',
      () => {
        const row = archiveDispatchRow();
        delete (row.productionOrder as { commercialOrder: Record<string, unknown> }).commercialOrder
          .orderNumber;
        return row;
      },
    ],
    [
      'wrong counterparty',
      () =>
        archiveDispatchRow({
          productionOrder: {
            id: 'po-1',
            approvalState: 'approved',
            commercialOrder: {
              id: 'co-1',
              orderNumber: 'A-501',
              counterparty: { id: 'cp-1', displayName: 42 },
            },
          },
        }),
    ],
    ['non-archive status', () => archiveDispatchRow({ status: 'assigned' })],
  ])('rejects a malformed archive 2xx row: %s', async (_label, row) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse([row()])));

    await expect(fetchProductionArchive('2026-07-01', '2026-07-14')).rejects.toThrow(
      'Некорректный ответ архива производства',
    );
  });
});

describe('production warehouse coverage v2 projection boundary', () => {
  it('keeps only the safe aggregate and drops exact roll, membership, and scan data', () => {
    const result = normalizeProductionWarehouseCoverage({
      workflowVersion: 2,
      state: 'production_required',
      stateVersion: 5,
      generation: 3,
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      nextOwner: 'commercial',
      availableActions: [],
      requiredRollCount: 2,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      calculatedAt: '2026-07-24T10:00:00.000Z',
      stale: false,
      financeRolls: [{ rollCode: 'SECRET-ROLL', positionId: 'secret-position' }],
      members: [{ membershipId: 'secret-membership' }],
      rows: [{ scanRowId: 'secret-scan-row' }],
    });

    expect(result).toMatchObject({
      workflowVersion: 2,
      state: 'production_required',
      requiredRollCount: 2,
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET-ROLL|financeRolls|membershipId|scanRowId/u);
  });
});
describe('individual shift and intentional machine-change commands', () => {
  it('cancels planned assignments and pending machine changes with exact command bodies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({ status: 'cancelled' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const assignmentCommand = {
      operationKey: '11111111-1111-4111-8111-111111111111',
      reason: 'Ошибочное назначение',
    };
    const changeCommand = {
      operationKey: '22222222-2222-4222-8222-222222222222',
      reason: 'Переход больше не нужен',
    };

    await cancelProductionAssignment('shift / 1', 'assignment / 1', assignmentCommand);
    await cancelProductionMachineChange('change / 1', changeCommand);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/production/shifts/shift%20%2F%201/assignments/assignment%20%2F%201/cancel',
      '/api/production/machine-changes/change%20%2F%201/cancel',
    ]);
    expect(
      fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body))),
    ).toEqual([assignmentCommand, changeCommand]);
    expect(fetchMock.mock.calls.every(([, init]) => (init as RequestInit).method === 'POST')).toBe(
      true,
    );
    fetchMock.mockRestore();
  });

  it('creates one atomic operator shift without planned timestamps', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          shift: {
            id: 'shift-1',
            label: 'Ночная линия',
            plannedStartAt: null,
            plannedEndAt: null,
            status: 'planned',
            operationKey: '11111111-1111-4111-8111-111111111111',
          },
          assignment: {
            id: 'assignment-1',
            shiftId: 'shift-1',
            operatorId: 'operator-1',
            postId: 'post-2',
            status: 'planned',
          },
          dispatchItemIds: ['dispatch-1'],
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const api = await import('./production');

    await api.createIndividualOperatorShift({
      operatorId: 'operator-1',
      postId: 'post-2',
      label: 'Ночная линия',
      operationKey: '11111111-1111-4111-8111-111111111111',
    });

    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/operator-shifts');
    expect(body).toEqual({
      operatorId: 'operator-1',
      postId: 'post-2',
      label: 'Ночная линия',
      operationKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(body).not.toHaveProperty('dispatchItemIds');
    expect(body).not.toHaveProperty('plannedStartAt');
    expect(body).not.toHaveProperty('plannedEndAt');
    fetchMock.mockRestore();
  });

  it('uses the persistent intentional machine-change endpoints', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'change-1',
            assignmentId: 'assignment-1',
            shiftId: 'shift-1',
            operatorId: 'operator-1',
            fromPostId: 'post-1',
            toPostId: 'post-2',
            fromPost: { id: 'post-1', code: 'POST-1', name: 'Станок 1' },
            toPost: { id: 'post-2', code: 'POST-2', name: 'Станок 2' },
            needsFinalWeight: true,
            pendingBigBags: [{ id: 'bag-1', code: 'BB-1' }],
            reason: 'Плановый переход',
            status: 'awaiting_final_weight',
            operationKey: '22222222-2222-4222-8222-222222222222',
            requestedAt: '2026-07-27T09:00:00.000Z',
            readyAt: null,
            completedAt: null,
            cancelledAt: null,
            updatedAt: '2026-07-27T09:00:00.000Z',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(null), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeId: 'change-1',
            status: 'awaiting_final_weight',
            remainingBigBags: [],
            completedAt: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    const productionApi = await import('./production');
    const operatorApi = await import('./operator');

    await productionApi.requestIntentionalMachineChange('assignment-1', {
      postId: 'post-2',
      reason: 'Плановый переход',
      operationKey: '22222222-2222-4222-8222-222222222222',
    });
    await operatorApi.fetchCurrentOperatorMachineChange();
    await operatorApi.finalizeOperatorMachineChange('change-1', { bigBagId: 'bag-1' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/production/operator-machines/assignment-1/machine-change',
      '/api/operator/machine-changes/current',
      '/api/operator/machine-changes/change-1/finalize',
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      bigBagId: 'bag-1',
    });
    fetchMock.mockRestore();
  });
});
