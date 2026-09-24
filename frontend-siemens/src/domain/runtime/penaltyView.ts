import type { Role, WorkListItem } from '../types';
import type { PenaltyRuntime } from './types';

const PENALTY_LIST_PREFIX = 'OP-';

export function penaltyWorkListId(penaltyId: string): string {
  return penaltyId.startsWith(PENALTY_LIST_PREFIX)
    ? penaltyId
    : `${PENALTY_LIST_PREFIX}${penaltyId}`;
}

export function penaltyIdFromWorkListId(workListId: string): string {
  return workListId.startsWith(PENALTY_LIST_PREFIX)
    ? workListId.slice(PENALTY_LIST_PREFIX.length)
    : workListId;
}

export function penaltyStatusLabel(status: PenaltyRuntime['status']) {
  const labels = {
    created: 'Назначен',
    issued: 'Назначен',
    notified: 'Уведомлен',
    disputed: 'На проверке',
    cancelled: 'Отменен',
  } satisfies Record<PenaltyRuntime['status'], string>;
  return labels[status];
}

function hasHistoryAction(penalty: PenaltyRuntime, actionLabel: string) {
  return penalty.history.some((event) => event.actionLabel === actionLabel);
}

export function penaltyHistoryActionLabel(actionLabel: string) {
  const labels: Record<string, string> = {
    'audit:penalty_created': 'Штраф назначен',
    'audit:penalty_updated': 'Штраф изменен',
    'notification:penalty_created': 'Уведомление отправлено',
    'notification:penalty_sent': 'Уведомление отправлено',
  };
  return labels[actionLabel] ?? actionLabel;
}

function hasIncompletePenaltyTrail(penalty: PenaltyRuntime) {
  if (penalty.status === 'cancelled') return false;
  const hasNotification = penalty.history.some((event) =>
    ['notification:penalty_created', 'notification:penalty_sent'].includes(event.actionLabel),
  );
  return !hasHistoryAction(penalty, 'audit:penalty_created') || !hasNotification;
}

export function penaltyListItems(penalties: PenaltyRuntime[], filter: string): WorkListItem[] {
  const items: WorkListItem[] = penalties.map((penalty) => {
    const incompleteTrail = hasIncompletePenaltyTrail(penalty);
    const completed = penalty.status === 'cancelled';
    return {
      id: penaltyWorkListId(penalty.penaltyId),
      kind: 'operatorTask' as const,
      title: penalty.penaltyId,
      summary: penalty.reason,
      statusLabel: penaltyStatusLabel(penalty.status),
      severity: incompleteTrail ? ('warning' as const) : ('info' as const),
      nextOwner: penalty.employeeName,
      lastEventAt: penalty.updatedAt ?? penalty.createdAt,
      problemCount: incompleteTrail ? 1 : 0,
      roleFields: [
        { label: 'Причина', value: penalty.reason, scope: 'operator' as const },
        { label: 'Сумма штрафа', value: penalty.amountLabel, scope: 'operator' as const },
        { label: 'Объект', value: penalty.scopeObjectId, scope: 'operator' as const },
      ],
      filterTags: [
        'Штрафы',
        completed ? 'Завершены' : incompleteTrail ? 'Требуют действия' : 'Уведомлены',
      ],
      queueBucket: completed ? ('completed' as const) : ('active' as const),
      archiveReason: completed ? 'штраф отменен' : undefined,
      completedAt: completed ? (penalty.updatedAt ?? penalty.createdAt) : undefined,
      lastActionAt: penalty.updatedAt ?? penalty.createdAt,
    };
  });

  if (filter === 'Все') return items.filter((item) => item.queueBucket !== 'completed');
  if (filter === 'Архив' || filter === 'Завершены')
    return items.filter((item) => item.queueBucket === 'completed');
  return items.filter((item) => item.filterTags.includes(filter));
}

export function penaltyRecipientRole(employeeRole: string): Role {
  if (employeeRole === 'Оператор') return 'operator';
  return 'production';
}
