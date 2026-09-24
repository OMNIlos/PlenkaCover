import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, saveSession } from './authStorage';
import { workObjects } from '../domain/demoData';
import { getListItems } from '../domain/selectors';
import {
  fetchWarehouseCoverChecks,
  fetchWarehouseCoverCheckQueue,
  fetchWarehouseFreeRolls,
  proposeWarehouseCover,
  warehouseCoverageApi,
  type ServerWarehouseCoverCheckItem,
} from './warehouse';
import {
  normalizeWarehouseCoverage,
  normalizeWarehouseCoverageDecisionTask,
  normalizeWarehouseCoverageRecheckItem,
  normalizeWarehouseCoverageWithCase,
} from '../domain/warehouseCoverage';

const coverCheck: ServerWarehouseCoverCheckItem = {
  caseId: 'case-1',
  orderId: 'order-1',
  orderNumber: 'A-1001',
  customerAlias: 'Клиент 12',
  state: 'open',
  requestedAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:05:00.000Z',
  positions: [
    {
      id: 'position-1',
      rollCount: 2,
      filmType: 'Рукав',
      actualThickness: '80 мкм',
      accountingThickness: '78 мкм',
      rawMaterialId: 'rm-pvd',
      spoolType: 'Шпуля 76 мм',
      birka: 'ГОСТ',
      plannedWeightKg: 41.2,
      warehouseCoverStatus: 'not_checked',
    },
  ],
};

describe('warehouse cover API boundary', () => {
  beforeEach(() => {
    clearSession();
    saveSession({
      version: 1,
      token: 'warehouse-token',
      role: 'warehouse',
      serverRole: 'warehouse',
      userId: 'warehouse-user',
      displayName: 'Склад',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
  });

  afterEach(() => {
    clearSession();
    vi.unstubAllGlobals();
  });

  it('maps the paged safe task contract and preserves the opaque next cursor', async () => {
    const unsafeServerItem = {
      ...coverCheck,
      legalName: 'ООО Секрет',
      inn: '7700000000',
      financeOrder: { amountValue: 9_000_000 },
      rawPayload: 'must-not-leak',
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ items: [unsafeServerItem], nextCursor: 'cursor:opaque+1' }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchWarehouseCoverChecks({ cursor: 'cursor:old+1', limit: 25 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/cover-checks?limit=25&cursor=cursor%3Aold%2B1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(page.nextCursor).toBe('cursor:opaque+1');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        id: 'WH-COVER-order-1',
        title: 'Проверка покрытия A-1001',
        filterTags: ['Запасы / резерв', 'Требуют действия', 'Проверить покрытие'],
        warehouseCoverTask: expect.objectContaining({
          caseId: 'case-1',
          orderId: 'order-1',
          customerAlias: 'Клиент 12',
          positions: [expect.objectContaining({ id: 'position-1', rollCount: 2 })],
        }),
      }),
    );
    expect(page.items[0].filterTags).not.toContain('Приемка');
    expect(
      getListItems('warehouse', 'Все', 'Запасы / резерв', {
        ...workObjects,
        warehouse: page.items,
      }).map((item) => item.id),
    ).toEqual(['WH-COVER-order-1']);
    expect(
      getListItems('warehouse', 'Все', 'Приемка', {
        ...workObjects,
        warehouse: page.items,
      }),
    ).toEqual([]);
    expect(JSON.stringify(page.items[0])).not.toMatch(
      /ООО Секрет|7700000000|amountValue|must-not-leak|rawPayload/,
    );
  });

  it('rejects a repeating cursor instead of silently returning a partial queue', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      items: [coverCheck], nextCursor: 'repeating-cursor',
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWarehouseCoverCheckQueue()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads only free rolls from the safe facts contract without stale snapshot fallback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'roll-1',
            rollCode: 'STK-001',
            warehouseStatus: 'received',
            facts: {
              filmType: 'Рукав',
              actualThickness: null,
              birka: null,
              spoolType: 'Шпуля 76 мм',
              plannedWeightKg: null,
              rawSourceField: 'must-not-leak-from-facts',
            },
            positionSnapshot: {
              filmType: 'УСТАРЕВШИЙ СНИМОК',
              actualThickness: '999 мкм',
              birka: 'НЕ ИСПОЛЬЗОВАТЬ',
              spoolType: 'Старый тип',
              plannedWeightKg: 999,
            },
            rawPayload: 'must-not-leak',
            externalId: '1C-secret',
          },
        ]),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rolls = await fetchWarehouseFreeRolls();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/warehouse/rolls?ownership=free',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(rolls).toEqual([
      {
        id: 'roll-1',
        rollCode: 'STK-001',
        warehouseStatus: 'received',
        facts: {
          filmType: 'Рукав',
          actualThickness: null,
          birka: null,
          spoolType: 'Шпуля 76 мм',
          plannedWeightKg: null,
        },
      },
    ]);
    expect(JSON.stringify(rolls)).not.toMatch(
      /positionSnapshot|УСТАРЕВШИЙ|rawSourceField|must-not-leak|externalId|1C-secret/,
    );
  });

  it('posts exact roll ids and an optional comment, including an empty production-only choice', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ id: 'proposal-1' }), { status: 200 })),
      );
    vi.stubGlobal('fetch', fetchMock);

    await proposeWarehouseCover('order / 1', {
      positionId: 'position-1',
      rollIds: ['roll-1', 'roll-2'],
      comment: 'Проверено складом',
    });
    await proposeWarehouseCover('order / 1', {
      positionId: 'position-2',
      rollIds: [],
    });

    const [firstPath, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstPath).toBe('/api/warehouse/orders/order%20%2F%201/cover-proposals');
    expect(JSON.parse(firstInit.body as string)).toEqual({
      positionId: 'position-1',
      rollIds: ['roll-1', 'roll-2'],
      comment: 'Проверено складом',
    });
    expect(JSON.parse(secondInit.body as string)).toEqual({
      positionId: 'position-2',
      rollIds: [],
    });
  });
});

function serverCoverageProjection() {
  return {
    workflowVersion: 2,
    state: 'recheck_requested',
    stateVersion: 5,
    generation: 3,
    availability: 'unknown',
    reasonCodes: ['warehouse_recheck_pending'],
    nextOwner: 'warehouse',
    availableActions: ['resolve_recheck'],
    requiredRollCount: 2,
    matchedRollCount: 1,
    uncertainRollCount: 1,
    calculatedAt: '2026-07-24T10:00:00.000Z',
    stale: false,
  };
}

function serverRecheckItem() {
  return {
    caseId: 'case-real-id',
    coverageOrigin: 'finance_request',
    caseVersion: 2,
    stateVersion: 5,
    generation: 3,
    reasonCodes: ['roll_facts_incomplete'],
    members: [
      {
        membershipId: 'membership-real-id',
        rollCode: 'ROLL-001',
        sourceKind: 'uncertain_candidate',
        reasonCodes: ['roll_facts_incomplete'],
        currentFactVersion: null,
        ownerVerified: false,
        currentSpec: null,
      },
    ],
  };
}

function serverDecisionTask() {
  return {
    taskId: 'task-real-id',
    status: 'open',
    generation: 3,
    stateVersion: 5,
    updatedAt: '2026-07-24T10:00:00.000Z',
    rows: [
      {
        scanRowId: 'scan-row-real-id',
        rollCode: 'ROLL-001',
        scanStatus: 'expected',
      },
    ],
  };
}

describe('warehouse coverage v2 API boundary', () => {
  const resolveInput = {
    clientRequestId: '00000000-0000-4000-8000-000000000225',
    expectedCaseVersion: 2,
    expectedGeneration: 3,
    expectedStateVersion: 5,
    reason: 'Проверено по этикетке и контрольному весу',
    corrections: [],
  };
  const physicalExceptionInput = {
    clientRequestId: '00000000-0000-4000-8000-000000000226',
    expectedGeneration: 3,
    expectedStateVersion: 5,
    expectedTaskUpdatedAt: '2026-07-24T10:00:00.000Z',
    scanRowId: 'scan-row-real-id',
    kind: 'damaged' as const,
    reason: 'Повреждение подтверждено при сканировании',
  };

  it('wires every response through its dedicated strict normalizer and exact route', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([serverRecheckItem()]), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(serverDecisionTask()), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(serverCoverageProjection()), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...serverCoverageProjection(), caseId: 'case-real-id' }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(warehouseCoverageApi.listRechecks()).resolves.toEqual([
      normalizeWarehouseCoverageRecheckItem(serverRecheckItem()),
    ]);
    await expect(
      warehouseCoverageApi.readDecisionTask('task / real-id'),
    ).resolves.toEqual(normalizeWarehouseCoverageDecisionTask(serverDecisionTask()));
    await expect(
      warehouseCoverageApi.resolve('case / real-id', resolveInput),
    ).resolves.toEqual(normalizeWarehouseCoverage(serverCoverageProjection()));
    await expect(
      warehouseCoverageApi.reportPhysicalException(
        'task / real-id',
        physicalExceptionInput,
      ),
    ).resolves.toEqual(
      normalizeWarehouseCoverageWithCase({
        ...serverCoverageProjection(),
        caseId: 'case-real-id',
      }),
    );

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/warehouse/warehouse-coverage/rechecks',
      '/api/warehouse/tasks/task%20%2F%20real-id',
      '/api/warehouse/warehouse-coverage/rechecks/case%20%2F%20real-id/resolve',
      '/api/warehouse/tasks/task%20%2F%20real-id/coverage-physical-exception',
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/WH-COVER-/u);
  });

  it('rejects leaked recheck membership and decision-row provenance', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              ...serverRecheckItem(),
              members: [
                {
                  ...serverRecheckItem().members[0],
                  rollId: 'secret-roll-id',
                },
              ],
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...serverDecisionTask(),
            rows: [
              {
                ...serverDecisionTask().rows[0],
                coverageFactId: 'secret-fact-id',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(warehouseCoverageApi.listRechecks()).rejects.toThrow(
      /extra key.*rollId/u,
    );
    await expect(
      warehouseCoverageApi.readDecisionTask('task-real-id'),
    ).rejects.toThrow(/extra key.*coverageFactId/u);
  });
});
