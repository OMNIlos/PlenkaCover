import { projectFinanceContextHistory } from './finance-context-history';

describe('finance contextual history projection', () => {
  it('maps related commercial and finance facts without exposing internal event data', () => {
    const result = projectFinanceContextHistory([
      {
        id: 'event-b',
        objectId: 'commercial-1',
        type: 'audit:commercial_order_comment_updated',
        actorRole: 'commercial',
        actorId: 'user-1',
        actorDisplayName: 'Олег Петров',
        createdAt: new Date('2026-08-10T12:30:00.000Z'),
        reason: 'Клиент уточнил условия',
        oldValue: { comment: 'Самовывоз' },
        newValue: { comment: 'Доставка' },
        detail: { requestFingerprint: 'must-not-leak', rawPayload: { secret: true } },
      },
      {
        id: 'event-a',
        objectId: 'finance-1',
        type: 'audit:payment_status_updated',
        actorRole: 'finance',
        actorId: 'user-2',
        actorDisplayName: null,
        createdAt: new Date('2026-08-10T12:30:00.000Z'),
        reason: null,
        oldValue: { paymentStatus: 'unpaid' },
        newValue: { paymentStatus: 'partial' },
        detail: null,
      },
    ]);

    expect(result.map((entry) => entry.id)).toEqual(['event-b', 'event-a']);
    expect(result[0]).toEqual({
      id: 'event-b',
      occurredAt: '2026-08-10T12:30:00.000Z',
      actor: 'Олег Петров',
      actorRole: 'Коммерция',
      action: 'Комментарий коммерции изменён',
      field: 'Комментарий',
      previousValue: 'Самовывоз',
      currentValue: 'Доставка',
      reason: 'Клиент уточнил условия',
    });
    expect(JSON.stringify(result)).not.toMatch(/audit:|requestFingerprint|rawPayload|secret/);
  });

  it('fails closed for unknown or malformed events', () => {
    expect(
      projectFinanceContextHistory([
        {
          id: 'event-unknown',
          objectId: 'finance-1',
          type: 'internal:snake_case_secret',
          actorRole: null,
          actorId: null,
          actorDisplayName: null,
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          reason: null,
          oldValue: { rawPayload: 'secret' },
          newValue: null,
          detail: { requestFingerprint: 'secret' },
        },
      ]),
    ).toEqual([
      {
        id: 'event-unknown',
        occurredAt: '2026-08-10T12:00:00.000Z',
        actor: 'Система',
        actorRole: 'Система',
        action: 'Неизвестное событие',
        field: null,
        previousValue: null,
        currentValue: null,
        reason: null,
      },
    ]);
  });

  it('shows only the business field that actually changed in a commercial position', () => {
    const [entry] = projectFinanceContextHistory([
      {
        id: 'event-width',
        objectId: 'commercial-1',
        type: 'audit:commercial_position_updated',
        actorRole: 'commercial',
        actorId: 'user-1',
        actorDisplayName: 'Олег Петров',
        createdAt: new Date('2026-08-10T12:30:00.000Z'),
        reason: 'Новая спецификация клиента',
        oldValue: { rollCount: 5, widthMm: 500, rawMaterialId: 'internal-before' },
        newValue: { rollCount: 5, widthMm: 600, rawMaterialId: 'internal-after' },
        detail: { positionId: 'internal-position' },
      },
    ]);

    expect(entry).toMatchObject({
      field: 'Ширина',
      previousValue: '500',
      currentValue: '600',
      reason: 'Новая спецификация клиента',
    });
    expect(JSON.stringify(entry)).not.toMatch(/rawMaterialId|internal-/);
  });
});
