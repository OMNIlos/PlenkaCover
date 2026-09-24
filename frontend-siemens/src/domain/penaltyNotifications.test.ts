import { describe, expect, it } from 'vitest';

import { userSessions } from './fixtures/access';
import type { PenaltyRuntime } from './runtime';
import {
  mergeLivePenaltyNotifications,
  penaltyNotificationFromRuntime,
  penaltiesVisibleToProduction,
} from './penaltyNotifications';

describe('live penalty notification projection', () => {
  it('creates an informational operator notification without acknowledgement', () => {
    const penalty = {
      penaltyId: 'pen-501',
      employeeId: 'operator-2',
      employeeName: 'Илья Ковалёв',
      employeeRole: 'Оператор',
      targetRole: 'operator',
      scopeObjectId: 'Заказ A-501 · рулон A-501-roll-2',
      reason: 'Недовес рулона',
      amountLabel: '900 ₽',
      author: 'Зав. производства',
      status: 'notified',
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [],
    } satisfies PenaltyRuntime;

    expect(penaltyNotificationFromRuntime(penalty)).toEqual(
      expect.objectContaining({
        id: 'notification-penalty-pen-501',
        eventType: 'notification:penalty_created',
        recipientRole: 'operator',
        recipientUserId: 'operator-2',
        objectId: 'OP-pen-501',
        navigation: { section: 'Штрафы', objectId: 'OP-pen-501' },
        requiresAck: false,
        title: 'Штраф назначен',
        body: expect.stringContaining('Заказ A-501 · рулон A-501-roll-2'),
      }),
    );
  });

  it('routes a director penalty for a production lead to that personal penalty section', () => {
    const penalty = {
      penaltyId: 'pen-lead-1',
      employeeId: 'lead-2',
      employeeName: 'Артур Кольцов',
      employeeRole: 'Зав. производства',
      targetRole: 'production_lead',
      scopeObjectId: 'Заказ A-501 целиком',
      reason: 'Нарушение регламента',
      amountLabel: '2 000 ₽',
      author: 'Директор',
      status: 'notified',
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [],
    } satisfies PenaltyRuntime;

    expect(penaltyNotificationFromRuntime(penalty)).toMatchObject({
      recipientRole: 'production',
      recipientUserId: 'lead-2',
      objectId: 'OP-pen-lead-1',
      navigation: { section: 'Штрафы', objectId: 'OP-pen-lead-1' },
    });
  });

  it('shows a production lead their own penalties alongside operator-management penalties', () => {
    const base = {
      amountLabel: '2 000 ₽',
      author: 'Директор',
      status: 'notified' as const,
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [] as PenaltyRuntime['history'],
    };
    const penalties = [
      {
        ...base,
        penaltyId: 'pen-operator',
        employeeId: 'operator-2',
        employeeName: 'Илья Ковалёв',
        employeeRole: 'Оператор',
        targetRole: 'operator',
        scopeObjectId: 'Заказ A-501 · рулон 2',
        reason: 'Недовес рулона',
      },
      {
        ...base,
        penaltyId: 'pen-current-lead',
        employeeId: 'production-lead-a',
        employeeName: 'Зав. производства Артур',
        employeeRole: 'Зав. производства',
        targetRole: 'production_lead',
        scopeObjectId: 'Заказ A-501',
        reason: 'Нарушение регламента',
      },
      {
        ...base,
        penaltyId: 'pen-other-lead',
        employeeId: 'production-lead-b',
        employeeName: 'Зав. производства смены B',
        employeeRole: 'Зав. производства',
        targetRole: 'production_lead',
        scopeObjectId: 'Заказ A-502',
        reason: 'Чужой личный штраф',
      },
    ] satisfies PenaltyRuntime[];

    expect(
      penaltiesVisibleToProduction(penalties, {
        userId: userSessions.production.id,
        displayName: userSessions.production.name,
      }).map((penalty) => penalty.penaltyId),
    ).toEqual(['pen-operator', 'pen-current-lead']);
  });

  it('fails closed when another production lead shares a personal-name token', () => {
    const base = {
      amountLabel: '2 000 ₽',
      author: 'Директор',
      status: 'notified' as const,
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [] as PenaltyRuntime['history'],
      employeeRole: 'Зав. производства' as const,
      targetRole: 'production_lead' as const,
      scopeObjectId: 'Заказ A-501',
      reason: 'Личный штраф',
    };
    const penalties = [
      {
        ...base,
        penaltyId: 'pen-current-lead',
        employeeId: 'lead-current',
        employeeName: 'Зав. производства Артур Кольцов',
      },
      {
        ...base,
        penaltyId: 'pen-other-same-first-name',
        employeeId: 'lead-other-first-name',
        employeeName: 'Зав. производства Артур Иванов',
      },
      {
        ...base,
        penaltyId: 'pen-other-shared-surname-token',
        employeeId: 'lead-other-surname',
        employeeName: 'Зав. производства Сергей Кольцов',
      },
    ] satisfies PenaltyRuntime[];

    expect(
      penaltiesVisibleToProduction(penalties, {
        userId: 'lead-current',
        displayName: 'Артур Кольцов',
      }).map((penalty) => penalty.penaltyId),
    ).toEqual(['pen-current-lead']);
  });

  it('does not treat two missing employee ids as an identity match', () => {
    const penalty = {
      penaltyId: 'pen-missing-id',
      employeeId: '',
      employeeName: 'Зав. производства Мария',
      employeeRole: 'Зав. производства',
      targetRole: 'production_lead',
      scopeObjectId: 'Заказ A-503',
      reason: 'Личный штраф другого сотрудника',
      amountLabel: '2 000 ₽',
      author: 'Директор',
      status: 'notified',
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [],
    } satisfies PenaltyRuntime;

    expect(
      penaltiesVisibleToProduction([penalty], {
        userId: '',
        displayName: 'Артур',
      }),
    ).toEqual([]);
  });

  it('replaces the demo penalty notice while preserving unrelated notifications', () => {
    const penalty = {
      penaltyId: 'pen-501',
      employeeId: 'operator-2',
      employeeName: 'Илья Ковалёв',
      employeeRole: 'Оператор',
      targetRole: 'operator',
      scopeObjectId: 'Заказ A-501 целиком',
      reason: 'Нарушение по заказу',
      amountLabel: '700 ₽',
      author: 'Зав. производства',
      status: 'notified',
      createdAt: '2026-07-10T12:00:00.000Z',
      history: [],
    } satisfies PenaltyRuntime;
    const unrelated = {
      id: 'payment-notification',
      recipientRole: 'finance',
      severity: 'warning',
      title: 'Оплата сегодня',
      body: 'Нужно действие.',
      createdAt: '11:00',
      requiresAck: true,
      sound: true,
    } as const;
    const demoPenalty = {
      ...unrelated,
      id: 'n-operator-penalty',
      recipientRole: 'operator',
      eventType: 'notification:penalty_created',
    } as const;

    expect(mergeLivePenaltyNotifications([demoPenalty, unrelated], [penalty])).toEqual([
      expect.objectContaining({ id: 'notification-penalty-pen-501' }),
      unrelated,
    ]);
  });
});
