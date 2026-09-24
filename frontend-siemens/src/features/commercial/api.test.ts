import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSession, saveSession } from '../../api/authStorage';
import { defaultIntakeDraft } from '../../domain/prototypeRuntime';
import {
  amendCommercialOrder,
  buildCommercialCreateOrderCommand,
  buildCommercialOrderQuery,
  cancelCommercialOrder,
  deleteCommercialOrder,
  fetchCommercialNotifications,
  fetchCommercialOrderPage,
  fetchCommercialProblems,
  handoffCommercialOrderToFinance,
  handoffCommercialOrderToProduction,
  mapCommercialNotification,
  markCommercialNotificationRead,
  updateCommercialFinanceNote,
  updateCommercialOrderComment,
  updateCommercialPosition,
  type CommercialOrderFilterInput,
} from './api';

afterEach(() => {
  clearSession();
  vi.unstubAllGlobals();
});

describe('commercial workspace API adapter', () => {
  it('sends amendments, cancellation and deletion to encoded endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ commandId: 'command-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const amendment = {
      kind: 'update_position' as const,
      operationKey: '00000000-0000-4000-8000-000000000211',
      expectedOrderVersion: 7,
      reason: 'Клиент уточнил размеры',
      positionId: 'position / 1',
      expectedPositionVersion: 4,
      changes: { widthMm: 1800, plannedLengthM: 600, manualBirka: 'Метка А' },
    };
    await amendCommercialOrder('order / 1', amendment);
    const cancellation = {
      operationKey: '00000000-0000-4000-8000-000000000212',
      expectedVersion: 8,
      reason: 'Клиент отменил заказ',
    };
    await cancelCommercialOrder('order / 1', cancellation);
    await deleteCommercialOrder('order / 1');

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/commercial/orders/order%20%2F%201/amendments',
      '/api/commercial/orders/order%20%2F%201/cancellations',
      '/api/commercial/orders/order%20%2F%201',
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual(
      amendment,
    );
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string)).toEqual(
      cancellation,
    );
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe('POST');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe('DELETE');
    expect((fetchMock.mock.calls[2]![1] as RequestInit).body).toBeUndefined();
  });

  it('projects a base raw-material definition without legacy material payloads', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            baseRawMaterialDefinitionId: 'base-primary',
            recipeDefinitionVersionId: '',
            rawMaterial: 'Первичное',
            rawMaterialId: 'legacy-must-not-leak',
          },
        ],
      },
      counterpartyId: 'cp-uralpak',
      clientRequestId: '00000000-0000-4000-8000-000000000201',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command.positions[0]).toMatchObject({
      baseRawMaterialDefinitionId: 'base-primary',
    });
    expect(command.positions[0]).not.toHaveProperty('recipeDefinitionVersionId');
    expect(command.positions[0]).not.toHaveProperty('rawMaterialId');
    expect(command.positions[0]).not.toHaveProperty('recipeParameters');
  });

  it('does not infer commercial delegation from the production-lead role', () => {
    const command = buildCommercialCreateOrderCommand({
      form: defaultIntakeDraft,
      counterpartyId: 'cp-uralpak',
      clientRequestId: '00000000-0000-4000-8000-000000000219',
      creatorRole: 'production_lead',
      mode: 'submit',
    });

    expect(command).not.toHaveProperty('onBehalfOfCommercial');
  });

  it('projects an immutable recipe version instead of a base material', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            baseRawMaterialDefinitionId: '',
            recipeDefinitionVersionId: 'recipe-green-v3',
            rawMaterial: 'Зелёная 30/70',
          },
        ],
      },
      counterpartyId: 'cp-uralpak',
      clientRequestId: '00000000-0000-4000-8000-000000000202',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command.positions[0]).toMatchObject({
      recipeDefinitionVersionId: 'recipe-green-v3',
    });
    expect(command.positions[0]).not.toHaveProperty('baseRawMaterialDefinitionId');
  });

  it('keeps roll dimensions and standard/manual labels as separate fields', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        positions: [
          {
            ...defaultIntakeDraft.positions[0],
            widthMm: '1700',
            plannedLengthM: '275',
            birka: 'ГОСТ',
            manualBirka: 'Маркировка А-17',
          },
        ],
      },
      counterpartyId: 'cp-uralpak',
      clientRequestId: '00000000-0000-4000-8000-000000000207',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command.positions[0]).toMatchObject({
      widthMm: 1700,
      plannedLengthM: 275,
      birka: 'ГОСТ',
      manualBirka: 'Маркировка А-17',
    });
  });

  it('passes the commercial finance note as untouched free text for a client order', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        commercialFinanceNote: '  1200 за 20 рулонов  ',
      },
      counterpartyId: 'cp-uralpak',
      clientRequestId: '00000000-0000-4000-8000-000000000203',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command).toMatchObject({
      requestType: 'client_order',
      commercialFinanceNote: '1200 за 20 рулонов',
    });
  });

  it('does not send a finance note for production on reserve', () => {
    const command = buildCommercialCreateOrderCommand({
      form: {
        ...defaultIntakeDraft,
        commercialFinanceNote: 'не должно попасть в заказ на запас',
      },
      requestType: 'stock_reserve',
      clientRequestId: '00000000-0000-4000-8000-000000000204',
      creatorRole: 'commercial',
      mode: 'submit',
    });

    expect(command).not.toHaveProperty('commercialFinanceNote');
  });

  it.each<[CommercialOrderFilterInput['section'], 'incoming' | 'drafts' | 'in_work' | 'completed']>(
    [
      ['Входящие заявки', 'incoming'],
      ['Черновики', 'drafts'],
      ['В работе', 'in_work'],
      ['Выполненные', 'completed'],
    ],
  )('maps section %s to the exhaustive server bucket %s', (section, bucket) => {
    expect(buildCommercialOrderQuery({ section, mode: 'Текущие' })).toEqual({
      bucket,
      mode: 'current',
      limit: 20,
    });
  });

  it('maps action-required mode and preserves inclusive calendar dates', () => {
    expect(
      buildCommercialOrderQuery({
        section: 'Выполненные',
        mode: 'Требуют действий',
        from: '2026-07-01',
        to: '2026-07-01',
      }),
    ).toEqual({
      bucket: 'completed',
      mode: 'action_required',
      from: '2026-07-01',
      to: '2026-07-01',
      limit: 20,
    });
  });

  it('requests a typed cursor page without adding demo data', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [], nextCursor: 'next-1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      fetchCommercialOrderPage({
        bucket: 'incoming',
        mode: 'current',
        from: '2026-07-01',
        to: '2026-07-31',
        cursor: 'cursor/1',
        limit: 10,
      }),
    ).resolves.toEqual({ items: [], nextCursor: 'next-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders?bucket=incoming&mode=current&from=2026-07-01&to=2026-07-31&cursor=cursor%2F1&limit=10',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('requests the commercial problem projection with an opaque cursor and abort signal', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [], nextCursor: null }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(
      fetchCommercialProblems(
        { filter: 'all', cursor: 'cursor/with+symbols', limit: 10 },
        controller.signal,
      ),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/problems?filter=all&limit=10&cursor=cursor%2Fwith%2Bsymbols',
      expect.objectContaining({ method: 'GET', signal: controller.signal }),
    );
  });

  it('hands an order to finance without inventing a zero amount and refetches typed detail', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ id: 'legacy-shape' }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'order-1', bucket: 'in_work' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(handoffCommercialOrderToFinance('order-1')).resolves.toMatchObject({
      id: 'order-1',
      bucket: 'in_work',
    });
    expect(fetchMock.mock.calls[0]).toEqual([
      '/api/commercial/orders/order-1/invoice-handoff',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/commercial/orders/order-1');
  });

  it('sends an explicit one-of recipe selector when editing a position', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'order-1', positions: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await updateCommercialPosition('order-1', 'position-1', {
      expectedVersion: 4,
      widthMm: 1700,
      plannedLengthM: 275,
      manualBirka: 'Маркировка А-17',
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-blue-v2',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders/order-1/positions/position-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 4,
          widthMm: 1700,
          plannedLengthM: 275,
          manualBirka: 'Маркировка А-17',
          baseRawMaterialDefinitionId: null,
          recipeDefinitionVersionId: 'recipe-blue-v2',
        }),
      }),
    );
  });

  it('updates the bounded finance note with optimistic version and operation key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'order-1',
        version: 5,
        commercialFinanceNote: '1200 за 20 рулонов',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await updateCommercialFinanceNote('order / 1', {
      expectedVersion: 4,
      operationKey: '00000000-0000-4000-8000-000000000205',
      commercialFinanceNote: '1200 за 20 рулонов',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders/order%20%2F%201/finance-note',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 4,
          operationKey: '00000000-0000-4000-8000-000000000205',
          commercialFinanceNote: '1200 за 20 рулонов',
        }),
      }),
    );
  });

  it('patches only the order comment version through the encoded endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ comment: 'Новый текст', commentVersion: 4 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      updateCommercialOrderComment('order / 1', {
        expectedVersion: 3,
        comment: 'Новый текст',
      }),
    ).resolves.toEqual({ comment: 'Новый текст', commentVersion: 4 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/orders/order%20%2F%201/comment',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedVersion: 3,
          comment: 'Новый текст',
        }),
      }),
    );
  });

  it('hands an eligible order to production only through the explicit commercial command', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ id: 'production-order-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ id: 'order / 1', productionOrderId: 'production-order-1' }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(handoffCommercialOrderToProduction('order / 1')).resolves.toMatchObject({
      id: 'order / 1',
      productionOrderId: 'production-order-1',
    });
    expect(fetchMock.mock.calls).toEqual([
      [
        '/api/commercial/orders/order%20%2F%201/send-to-production',
        expect.objectContaining({ method: 'POST', body: '{}' }),
      ],
      ['/api/commercial/orders/order%20%2F%201', expect.objectContaining({ method: 'GET' })],
    ]);
  });

  it('uses the shared safe Control page without weakening commercial Bearer auth', async () => {
    saveSession({
      version: 1,
      token: 'commercial-token',
      role: 'commercial',
      serverRole: 'commercial',
      userId: 'commercial-user',
      displayName: 'Коммерция',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: 'event-1',
            eventType: 'audit:warehouse_cover_proposed',
            recipientRole: 'commercial',
            nextOwnerRole: 'commercial',
            severity: 'warning',
            title: 'Склад предложил покрытие',
            body: 'Проверьте предложенный маршрут.',
            createdAt: '2026-07-15T10:00:00.000Z',
            unread: true,
            orderId: 'order-1',
            orderNumber: 'З-1',
            taskId: 'proposal-1',
            positionId: null,
            rollId: null,
            cta: { kind: 'warehouse_cover', targetId: 'order-1', section: 'В работе' },
          },
        ],
        nextCursor: 'next-1',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await fetchCommercialNotifications('cursor/1', 10);
    const notification = mapCommercialNotification(page.items[0]!);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/notifications?limit=10&cursor=cursor%2F1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer commercial-token' }),
      }),
    );
    expect(page.nextCursor).toBe('next-1');
    expect(notification).toMatchObject({
      id: 'event-1',
      recipientRole: 'commercial',
      severity: 'warning',
      objectId: 'order-1',
      navigation: { section: 'В работе', objectId: 'order-1' },
      requiresAck: false,
      sound: true,
    });
    expect(notification).not.toHaveProperty('orderNumber');
    expect(notification).not.toHaveProperty('taskId');
  });

  it('delegates commercial read receipts to the shared encoded endpoint', async () => {
    saveSession({
      version: 1,
      token: 'commercial-token',
      role: 'commercial',
      serverRole: 'commercial',
      userId: 'commercial-user',
      displayName: 'Коммерция',
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, eventId: 'event/1' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await markCommercialNotificationRead('event/1');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/commercial/notifications/event%2F1/read',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: 'Bearer commercial-token' }),
      }),
    );
  });
});
