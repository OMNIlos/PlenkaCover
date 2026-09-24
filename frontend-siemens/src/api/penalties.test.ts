import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDirectorPenalty,
  createProductionOperatorPenalty,
  fetchDirectorPenalties,
  fetchPenaltySnapshot,
  fetchOperatorPenalties,
  serverPenaltySnapshotItemToRuntime,
  serverPenaltyToRuntime,
} from './penalties';

function response(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

afterEach(() => vi.unstubAllGlobals());

describe('penalties live adapter', () => {
  it('loads one server snapshot and preserves its item/summary parity and unknown employee', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        items: [
          {
            id: 'pen-orphan',
            employeeId: 'missing-employee',
            displayName: null,
            targetRole: 'production_lead',
            amountKopecks: 150025,
            reason: 'Нарушение регламента',
            sourceObjectId: null,
            sourceProductionOrderId: null,
            sourceOrderNumber: null,
            sourceRollCode: null,
            authorRole: 'director',
            status: 'issued',
            createdAt: '2026-08-08T08:00:00.000Z',
          },
        ],
        summary: {
          totalCount: 1,
          totalAmountKopecks: 150025,
          topReason: 'нарушение регламента',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchPenaltySnapshot({
        targetRole: 'production_lead',
        status: 'issued',
        employeeId: 'missing-employee',
      }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({
          penaltyId: 'pen-orphan',
          employeeId: 'missing-employee',
          employeeName: 'Сотрудник не найден',
          amountLabel: '1 500,25 ₽',
          status: 'issued',
        }),
      ],
      summary: {
        totalCount: 1,
        totalAmountKopecks: 150025,
        topReason: 'нарушение регламента',
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/penalties/snapshot?targetRole=production_lead&status=issued&employeeId=missing-employee',
    );
  });

  it.each([
    ['issued', 'issued'],
    ['disputed', 'disputed'],
    ['cancelled', 'cancelled'],
  ] as const)('preserves persisted %s for exhaustive Russian presentation', (status, expected) => {
    expect(
      serverPenaltySnapshotItemToRuntime({
        id: `pen-${status}`,
        employeeId: 'operator-1',
        displayName: 'Илья Ковалёв',
        targetRole: 'operator',
        amountKopecks: 1000,
        reason: 'Причина',
        sourceObjectId: null,
        sourceProductionOrderId: null,
        sourceOrderNumber: null,
        sourceRollCode: null,
        authorRole: 'director',
        status,
        createdAt: '2026-08-08T08:00:00.000Z',
      }).status,
    ).toBe(expected);
  });

  it('maps only the rows returned by the private operator endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response([
          {
            id: 'pen-2',
            employeeId: 'operator-2',
            employee: { id: 'operator-2', displayName: 'Илья Ковалёв' },
            targetRole: 'operator',
            amount: 1500,
            reason: 'Нарушение регламента',
            sourceObjectId: 'A-501-roll-1',
            sourceProductionOrderId: 'po-501',
            sourceOrderNumber: 'A-501',
            sourceRollCode: 'A-501-roll-1',
            authorRole: 'production_lead',
            status: 'issued',
            createdAt: '2026-07-10T08:15:00.000Z',
          },
        ]),
      ),
    );

    const penalties = await fetchOperatorPenalties();

    expect(penalties).toEqual([
      expect.objectContaining({
        penaltyId: 'pen-2',
        employeeId: 'operator-2',
        employeeName: 'Илья Ковалёв',
        amountLabel: '1 500 ₽',
        scopeObjectId: 'Заказ A-501 · рулон A-501-roll-1',
        status: 'issued',
      }),
    ]);
  });

  it('labels a whole-order penalty without exposing the production order hash', () => {
    const serverPenalty = {
      id: 'pen-order',
      employeeId: 'operator-2',
      employee: { id: 'operator-2', displayName: 'Илья Ковалёв' },
      targetRole: 'operator',
      amount: 700,
      reason: 'Нарушение по заказу',
      sourceObjectId: 'cmc8v2gm20001a414i3f04x9z',
      sourceProductionOrderId: 'cmc8v2gm20001a414i3f04x9z',
      sourceOrderNumber: 'A-501',
      sourceRollCode: null,
      authorRole: 'production_lead',
      status: 'issued',
      createdAt: '2026-07-10T08:15:00.000Z',
    } as const;
    const penalty = serverPenaltyToRuntime(serverPenalty);

    expect(penalty.scopeObjectId).toBe('Заказ A-501 целиком');
    expect(penalty.scopeObjectId).not.toContain('cmc8v2gm20001a414i3f04x9z');
  });

  it('posts a production penalty to the dedicated operator-only endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response(
        {
          id: 'pen-3',
          employeeId: 'operator-3',
          employee: { id: 'operator-3', displayName: 'Максим Лебедев' },
          targetRole: 'operator',
          amount: 2000,
          reason: 'Брак',
          sourceObjectId: 'A-501-roll-2',
          sourceProductionOrderId: 'po-501',
          sourceOrderNumber: 'A-501',
          sourceRollCode: 'A-501-roll-2',
          authorRole: 'production_lead',
          status: 'issued',
          createdAt: '2026-07-10T09:00:00.000Z',
        },
        201,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      operatorId: 'operator-3',
      productionOrderId: 'po-501',
      rollCode: 'A-501-roll-2',
      amount: 2000,
      reason: 'Брак',
    };
    await createProductionOperatorPenalty(input);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/production/penalties');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      operatorId: 'operator-3',
      productionOrderId: 'po-501',
      rollCode: 'A-501-roll-2',
      amount: 2000,
      reason: 'Брак',
    });
  });

  it('loads and creates director penalties through durable backend routes', async () => {
    const row = {
      id: 'pen-director-1',
      employeeId: 'operator-3',
      employee: { id: 'operator-3', displayName: 'Максим Лебедев' },
      targetRole: 'operator',
      amount: 2000,
      reason: 'Нарушение регламента',
      sourceObjectId: 'A-501-roll-2',
      authorRole: 'director',
      status: 'issued',
      createdAt: '2026-07-10T09:00:00.000Z',
    } as const;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              ...row,
              displayName: 'Максим Лебедев',
              amountKopecks: 200000,
              sourceProductionOrderId: null,
              sourceOrderNumber: null,
              sourceRollCode: null,
            },
          ],
          summary: {
            totalCount: 1,
            totalAmountKopecks: 200000,
            topReason: 'нарушение регламента',
          },
        }),
      )
      .mockResolvedValueOnce(response(row, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchDirectorPenalties()).resolves.toEqual([
      expect.objectContaining({ penaltyId: 'pen-director-1', employeeName: 'Максим Лебедев' }),
    ]);
    await createDirectorPenalty({
      targetRole: 'operator',
      amount: 2000,
      reason: 'Нарушение регламента',
      employeeId: 'operator-3',
      sourceObjectId: 'A-501-roll-2',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/penalties/snapshot');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/director/penalties');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      targetRole: 'operator',
      amount: 2000,
      reason: 'Нарушение регламента',
      employeeId: 'operator-3',
      sourceObjectId: 'A-501-roll-2',
    });
  });
});
