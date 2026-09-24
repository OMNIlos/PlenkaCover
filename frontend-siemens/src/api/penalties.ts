import { apiGet, apiPost, type ApiRequestOptions } from './client';
import type { PenaltyRuntime } from '../domain/runtime';

export type ServerPenalty = {
  id: string;
  employeeId: string | null;
  employee?: { id: string; displayName: string } | null;
  targetRole: 'operator' | 'production_lead';
  amount: number;
  reason: string;
  sourceObjectId: string | null;
  sourceProductionOrderId?: string | null;
  sourceOrderNumber?: string | null;
  sourceRollCode?: string | null;
  authorRole: string;
  status: string;
  createdAt: string;
};

export type PenaltySnapshotFilters = {
  targetRole?: 'operator' | 'production_lead';
  status?: 'issued' | 'disputed' | 'cancelled';
  employeeId?: string;
};

export type ServerPenaltySnapshotItem = {
  id: string;
  employeeId: string | null;
  displayName: string | null;
  targetRole: 'operator' | 'production_lead';
  amountKopecks: number;
  reason: string;
  sourceObjectId: string | null;
  sourceProductionOrderId: string | null;
  sourceOrderNumber: string | null;
  sourceRollCode: string | null;
  authorRole: string;
  status: 'issued' | 'disputed' | 'cancelled';
  createdAt: string;
};

export type PenaltySnapshotRuntime = {
  items: PenaltyRuntime[];
  summary: {
    totalCount: number;
    totalAmountKopecks: number;
    topReason: string | null;
  };
};

type ServerPenaltySnapshot = Omit<PenaltySnapshotRuntime, 'items'> & {
  items: ServerPenaltySnapshotItem[];
};

function authorLabel(role: string) {
  if (role === 'production_lead') return 'Зав. производства';
  if (role === 'director') return 'Директор';
  return role;
}

function penaltyScopeLabel(penalty: ServerPenalty) {
  if (!penalty.sourceOrderNumber) return penalty.sourceObjectId ?? 'без связанного объекта';
  return penalty.sourceRollCode
    ? `Заказ ${penalty.sourceOrderNumber} · рулон ${penalty.sourceRollCode}`
    : `Заказ ${penalty.sourceOrderNumber} целиком`;
}

export function serverPenaltyToRuntime(penalty: ServerPenalty): PenaltyRuntime {
  const employeeName =
    penalty.employee?.displayName ??
    (penalty.targetRole === 'operator' ? 'Оператор' : 'Зав. производства');
  const author = authorLabel(penalty.authorRole);
  return {
    penaltyId: penalty.id,
    employeeId: penalty.employeeId ?? '',
    employeeName,
    employeeRole: penalty.targetRole === 'operator' ? 'Оператор' : 'Зав. производства',
    targetRole: penalty.targetRole,
    scopeObjectId: penaltyScopeLabel(penalty),
    reason: penalty.reason,
    amountLabel: `${new Intl.NumberFormat('ru-RU').format(penalty.amount)} ₽`,
    author,
    status:
      penalty.status === 'cancelled'
        ? 'cancelled'
        : penalty.status === 'disputed'
          ? 'disputed'
          : 'issued',
    createdAt: penalty.createdAt,
    history: [
      {
        id: `${penalty.id}-created`,
        time: penalty.createdAt,
        actorLabel: author,
        actionLabel: 'audit:penalty_created',
        detail: `${penalty.reason}. Объект: ${penaltyScopeLabel(penalty)}. Сумма: ${new Intl.NumberFormat('ru-RU').format(penalty.amount)} ₽.`,
      },
      {
        id: `${penalty.id}-notified`,
        time: penalty.createdAt,
        actorLabel: author,
        actionLabel: 'notification:penalty_created',
        detail: `Уведомление направлено: ${employeeName}.`,
      },
    ],
  };
}

function snapshotScopeLabel(penalty: ServerPenaltySnapshotItem) {
  if (!penalty.sourceOrderNumber) return penalty.sourceObjectId ?? 'без связанного объекта';
  return penalty.sourceRollCode
    ? `Заказ ${penalty.sourceOrderNumber} · рулон ${penalty.sourceRollCode}`
    : `Заказ ${penalty.sourceOrderNumber} целиком`;
}

export function serverPenaltySnapshotItemToRuntime(
  penalty: ServerPenaltySnapshotItem,
): PenaltyRuntime {
  const employeeName = penalty.displayName ?? 'Сотрудник не найден';
  const author = authorLabel(penalty.authorRole);
  const amount = penalty.amountKopecks / 100;
  const amountLabel = `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(amount)} ₽`;
  const scopeObjectId = snapshotScopeLabel(penalty);
  return {
    penaltyId: penalty.id,
    employeeId: penalty.employeeId ?? '',
    employeeName,
    employeeRole: penalty.targetRole === 'operator' ? 'Оператор' : 'Зав. производства',
    targetRole: penalty.targetRole,
    scopeObjectId,
    reason: penalty.reason,
    amountLabel,
    author,
    status: penalty.status,
    createdAt: penalty.createdAt,
    history: [
      {
        id: `${penalty.id}-created`,
        time: penalty.createdAt,
        actorLabel: author,
        actionLabel: 'audit:penalty_created',
        detail: `${penalty.reason}. Объект: ${scopeObjectId}. Сумма: ${amountLabel}.`,
      },
      {
        id: `${penalty.id}-notified`,
        time: penalty.createdAt,
        actorLabel: author,
        actionLabel: 'notification:penalty_created',
        detail: `Уведомление направлено: ${employeeName}.`,
      },
    ],
  };
}

export function fetchPenaltySnapshot(
  filters: PenaltySnapshotFilters = {},
  options?: ApiRequestOptions,
): Promise<PenaltySnapshotRuntime> {
  const query = new URLSearchParams();
  if (filters.targetRole) query.set('targetRole', filters.targetRole);
  if (filters.status) query.set('status', filters.status);
  if (filters.employeeId) query.set('employeeId', filters.employeeId);
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiGet<ServerPenaltySnapshot>(`/api/penalties/snapshot${suffix}`, options).then((snapshot) => ({
    items: snapshot.items.map(serverPenaltySnapshotItemToRuntime),
    summary: snapshot.summary,
  }));
}

export function fetchProductionPenalties(): Promise<PenaltyRuntime[]> {
  return fetchPenaltySnapshot().then((snapshot) => snapshot.items);
}

export function fetchOperatorPenalties(options?: ApiRequestOptions): Promise<PenaltyRuntime[]> {
  return apiGet<ServerPenalty[]>('/api/operator/penalties', options).then((rows) =>
    rows.map(serverPenaltyToRuntime),
  );
}

export function fetchDirectorPenalties(): Promise<PenaltyRuntime[]> {
  return fetchPenaltySnapshot().then((snapshot) => snapshot.items);
}

export function createDirectorPenalty(input: {
  targetRole: 'operator' | 'production_lead';
  amount: number;
  reason: string;
  employeeId?: string;
  sourceObjectId?: string;
}): Promise<PenaltyRuntime> {
  return apiPost<ServerPenalty>('/api/director/penalties', input).then(serverPenaltyToRuntime);
}

export function createProductionOperatorPenalty(input: {
  operatorId: string;
  productionOrderId: string;
  rollCode?: string;
  amount: number;
  reason: string;
  sourceObjectId?: string;
}): Promise<PenaltyRuntime> {
  return apiPost<ServerPenalty>('/api/production/penalties', input).then(serverPenaltyToRuntime);
}
