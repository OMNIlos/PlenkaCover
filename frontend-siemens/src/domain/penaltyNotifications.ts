import type { NotificationItem } from './types';
import type { PenaltyRuntime } from './runtime';
import { penaltyWorkListId } from './runtime/penaltyView';

const productionLeadNamePrefix = /^зав\.\s+производства(?:\s*[:·–—-]\s*|\s+|$)/u;

function normalizedProductionLeadAlias(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(productionLeadNamePrefix, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function penaltiesVisibleToProduction(
  penalties: PenaltyRuntime[],
  identity: { userId: string; displayName: string },
): PenaltyRuntime[] {
  const viewerAlias = normalizedProductionLeadAlias(identity.displayName);

  return penalties.filter((penalty) => {
    if (penalty.targetRole === 'operator') return true;
    if (penalty.targetRole !== 'production_lead') return false;
    if (identity.userId && penalty.employeeId === identity.userId) return true;
    if (!viewerAlias) return false;

    return normalizedProductionLeadAlias(penalty.employeeName) === viewerAlias;
  });
}

export function penaltyNotificationFromRuntime(penalty: PenaltyRuntime): NotificationItem {
  const objectId = penaltyWorkListId(penalty.penaltyId);
  return {
    id: `notification-penalty-${penalty.penaltyId}`,
    eventType: 'notification:penalty_created',
    recipientRole: penalty.targetRole === 'production_lead' ? 'production' : 'operator',
    recipientUserId: penalty.employeeId,
    severity: 'warning',
    title: 'Штраф назначен',
    body: `Причина: ${penalty.reason}. Объект: ${penalty.scopeObjectId}. Сумма: ${penalty.amountLabel}.`,
    objectId,
    navigation: { section: 'Штрафы', objectId },
    createdAt: penalty.createdAt,
    requiresAck: false,
    sound: true,
  };
}

export function mergeLivePenaltyNotifications(
  current: NotificationItem[],
  penalties: PenaltyRuntime[],
): NotificationItem[] {
  const incoming = penalties.map(penaltyNotificationFromRuntime);
  const incomingIds = new Set(incoming.map((notification) => notification.id));
  const retained = current.filter(
    (notification) =>
      notification.eventType !== 'notification:penalty_created' || incomingIds.has(notification.id),
  );
  const retainedIds = new Set(retained.map((notification) => notification.id));
  return [...incoming.filter((notification) => !retainedIds.has(notification.id)), ...retained];
}
