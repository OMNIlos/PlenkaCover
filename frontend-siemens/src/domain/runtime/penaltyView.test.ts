import { describe, expect, it } from 'vitest';
import type { PenaltyRuntime } from './types';
import {
  penaltyHistoryActionLabel,
  penaltyIdFromWorkListId,
  penaltyListItems,
  penaltyStatusLabel,
  penaltyWorkListId,
} from './penaltyView';

describe('penalty selection ids', () => {
  it('uses the same list id for inbox navigation and penalty queues', () => {
    expect(penaltyWorkListId('penalty-1')).toBe('OP-penalty-1');
    expect(penaltyWorkListId('OP-penalty-1')).toBe('OP-penalty-1');
    expect(penaltyIdFromWorkListId('OP-penalty-1')).toBe('penalty-1');
  });

  it('treats the durable notification event as a complete, readable penalty trail', () => {
    const penalty = {
      penaltyId: 'penalty-1',
      employeeId: 'operator-1',
      employeeName: 'Илья Ковалёв',
      employeeRole: 'Оператор',
      targetRole: 'operator',
      scopeObjectId: 'Заказ A-501 · рулон A-501-roll-2',
      reason: 'Недовес рулона',
      amountLabel: '900 ₽',
      author: 'Зав. производства',
      status: 'notified',
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [
        {
          id: 'audit-1',
          time: '2026-07-10T12:00:00.000Z',
          actorLabel: 'Зав. производства',
          actionLabel: 'audit:penalty_created',
          detail: 'Штраф назначен.',
        },
        {
          id: 'notification-1',
          time: '2026-07-10T12:00:00.000Z',
          actorLabel: 'Зав. производства',
          actionLabel: 'notification:penalty_created',
          detail: 'Уведомление отправлено.',
        },
      ],
    } satisfies PenaltyRuntime;

    expect(penaltyListItems([penalty], 'Все')[0]).toMatchObject({
      severity: 'info',
      problemCount: 0,
      filterTags: expect.arrayContaining(['Уведомлены']),
    });
    expect(penaltyHistoryActionLabel('notification:penalty_created')).toBe(
      'Уведомление отправлено',
    );
  });

  it.each([
    ['created', 'Назначен'],
    ['issued', 'Назначен'],
    ['notified', 'Уведомлен'],
    ['disputed', 'На проверке'],
    ['cancelled', 'Отменен'],
  ] as const)('maps %s to the exhaustive Russian status label', (status, label) => {
    expect(penaltyStatusLabel(status)).toBe(label);
  });
});
