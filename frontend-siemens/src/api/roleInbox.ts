import type { NotificationItem, Role, Severity } from '../domain/types';
import { penaltyWorkListId } from '../domain/runtime/penaltyView';
import {
  normalizeWarehouseCoverage,
  type WarehouseCoverageView,
} from '../domain/warehouseCoverage';
import { apiGet, apiPut } from './client';

export type RoleInboxRole = Role;
export type ServerRoleInboxRole = Exclude<Role, 'production'> | 'production_lead';

export type RoleInboxCtaKind =
  | 'commercial_order'
  | 'finance_order'
  | 'production_order'
  | 'operator_roll'
  | 'warehouse_cover'
  | 'warehouse_intake'
  | 'director_decision'
  | 'penalty'
  | 'production_problem'
  | 'operator_queue'
  | 'admin_incident';

export type ServerRoleInboxItem = {
  id: string;
  eventType: string;
  recipientRole: ServerRoleInboxRole;
  nextOwnerRole: ServerRoleInboxRole;
  severity: Severity;
  title: string;
  body: string;
  createdAt: string;
  unread: boolean;
  orderId: string | null;
  orderNumber: string | null;
  orderInfo?: {
    orderNumber: string;
    rollCount: number;
    rollCodes: string[];
    omittedRollCount: number;
  } | null;
  financeOrderId?: string | null;
  caseId?: string | null;
  taskId: string | null;
  positionId: string | null;
  rollId: string | null;
  cta: { kind: RoleInboxCtaKind; targetId: string; section: string };
};

export type ServerRoleInboxPage = {
  items: ServerRoleInboxItem[];
  nextCursor: string | null;
  unreadCount: number;
};

export type RoleInboxPage = {
  items: NotificationItem[];
  nextCursor: string | null;
  unreadCount: number;
};

export type FetchRoleInboxOptions = {
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export const ROLE_INBOX_ROUTES = {
  commercial: '/api/commercial/notifications',
  finance: '/api/finance/notifications',
  production: '/api/production/notifications',
  operator: '/api/operator/notifications',
  warehouse: '/api/warehouse/notifications',
  director: '/api/director/notifications',
  admin: '/api/admin/notifications',
} satisfies Record<RoleInboxRole, string>;

const SERVER_ROLE_BY_FRONTEND_ROLE = {
  commercial: 'commercial',
  finance: 'finance',
  production: 'production_lead',
  operator: 'operator',
  warehouse: 'warehouse',
  director: 'director',
  admin: 'admin',
} satisfies Record<RoleInboxRole, ServerRoleInboxRole>;

const FRONTEND_ROLE_BY_SERVER_ROLE = {
  commercial: 'commercial',
  finance: 'finance',
  production_lead: 'production',
  operator: 'operator',
  warehouse: 'warehouse',
  director: 'director',
  admin: 'admin',
} satisfies Record<ServerRoleInboxRole, RoleInboxRole>;

const ROLE_INBOX_ROLES = new Set<RoleInboxRole>([
  'commercial',
  'production',
  'finance',
  'director',
  'operator',
  'warehouse',
  'admin',
]);

type NavigationResolver = (item: ServerRoleInboxItem) => string | null;

function withPrefix(prefix: string, id: string) {
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

function warehouseCoverObjectId(item: ServerRoleInboxItem) {
  switch (item.recipientRole) {
    case 'warehouse':
      return item.caseId ?? item.cta.targetId;
    case 'commercial':
    case 'production_lead':
      return item.cta.targetId;
    default:
      return null;
  }
}

const OBJECT_ID_BY_CTA_KIND = {
  commercial_order: (item) => item.cta.targetId,
  finance_order: (item) => item.financeOrderId ?? item.cta.targetId,
  production_order: (item) => item.cta.targetId,
  operator_roll: (item) => item.cta.targetId,
  warehouse_cover: warehouseCoverObjectId,
  warehouse_intake: (item) => withPrefix('intake-', item.cta.targetId),
  director_decision: (item) => item.cta.targetId,
  penalty: (item) => penaltyWorkListId(item.cta.targetId),
  production_problem: (item) => item.cta.targetId,
  operator_queue: () => null,
  admin_incident: (item) => item.cta.targetId,
} satisfies Record<RoleInboxCtaKind, NavigationResolver>;

export function isRoleInboxRole(role: unknown): role is RoleInboxRole {
  return typeof role === 'string' && ROLE_INBOX_ROLES.has(role as RoleInboxRole);
}

export type SafeCoverageRole = 'commercial' | 'production' | 'operator' | 'director';

export function normalizeRoleCoverage(
  _role: SafeCoverageRole,
  input: unknown,
): WarehouseCoverageView {
  return normalizeWarehouseCoverage(input);
}

export function roleInboxUrl(role: RoleInboxRole) {
  return ROLE_INBOX_ROUTES[role];
}

function normalizeOrderInfo(value: unknown): NotificationItem['orderInfo'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const orderNumber = typeof source.orderNumber === 'string' ? source.orderNumber.trim() : '';
  const rollCount = source.rollCount;
  const omittedRollCount = source.omittedRollCount;
  if (
    !orderNumber ||
    orderNumber.length > 120 ||
    typeof rollCount !== 'number' ||
    !Number.isSafeInteger(rollCount) ||
    rollCount < 1 ||
    typeof omittedRollCount !== 'number' ||
    !Number.isSafeInteger(omittedRollCount) ||
    omittedRollCount < 0 ||
    !Array.isArray(source.rollCodes) ||
    source.rollCodes.length > 20
  ) {
    return undefined;
  }
  const rollCodes = source.rollCodes.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const code = value.trim();
    return code && code.length <= 128 ? [code] : [];
  });
  if (
    rollCodes.length !== source.rollCodes.length ||
    new Set(rollCodes).size !== rollCodes.length ||
    rollCodes.length + omittedRollCount !== rollCount
  ) {
    return undefined;
  }
  return {
    orderNumber,
    rollCount,
    rollCodes,
    omittedRollCount,
  };
}

export function mapRoleInboxItem(item: ServerRoleInboxItem): NotificationItem {
  const orderInfo =
    item.eventType === 'notification:production_order_fully_handed_over'
      ? normalizeOrderInfo(item.orderInfo)
      : undefined;
  const base: NotificationItem = {
    id: item.id,
    eventType: item.eventType,
    recipientRole: FRONTEND_ROLE_BY_SERVER_ROLE[item.recipientRole],
    severity: item.severity,
    title: item.title,
    body: item.body,
    ...(item.eventType === 'notification:production_order_fully_handed_over' && item.orderNumber
      ? { orderNumber: item.orderNumber }
      : {}),
    ...(orderInfo ? { orderInfo } : {}),
    createdAt: item.createdAt,
    readAt: item.unread ? undefined : item.createdAt,
    requiresAck: false,
    sound: item.severity !== 'info',
  };
  const resolver = item.cta ? OBJECT_ID_BY_CTA_KIND[item.cta.kind] : undefined;
  if (!resolver) return base;

  const objectId = resolver(item);
  const navigation: NotificationItem['navigation'] =
    item.cta.kind === 'production_problem'
      ? item.rollId
        ? {
            kind: 'production_problem',
            section: item.cta.section,
            problemId: item.cta.targetId,
            rollId: item.rollId,
            ...(item.orderId ? { orderId: item.orderId } : {}),
          }
        : undefined
      : item.cta.kind === 'operator_queue'
        ? {
            kind: 'operator_queue',
            section: item.cta.section,
          }
        : item.cta.kind === 'admin_incident'
          ? {
              kind: 'admin_incident',
              section: item.cta.section,
              incidentId: item.cta.targetId,
            }
          : objectId
            ? { section: item.cta.section, objectId }
            : undefined;
  return {
    ...base,
    ...(objectId ? { objectId } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

export async function fetchRoleInbox(
  role: RoleInboxRole,
  { cursor, limit = 20, signal }: FetchRoleInboxOptions = {},
): Promise<RoleInboxPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  const page = await apiGet<ServerRoleInboxPage>(`${roleInboxUrl(role)}?${query}`, { signal });
  const recipientRole = SERVER_ROLE_BY_FRONTEND_ROLE[role];
  const items = page.items
    .filter((item) => item.recipientRole === recipientRole)
    .map(mapRoleInboxItem);
  const unreadCount =
    Number.isInteger(page.unreadCount) && page.unreadCount >= 0
      ? page.unreadCount
      : items.filter((item) => !item.readAt).length;
  return {
    items,
    nextCursor: page.nextCursor,
    unreadCount,
  };
}

export function markRoleInboxRead(
  role: RoleInboxRole,
  eventId: string,
): Promise<{ ok: true; eventId: string }> {
  return apiPut<{ ok: true; eventId: string }>(
    `${roleInboxUrl(role)}/${encodeURIComponent(eventId)}/read`,
  );
}
