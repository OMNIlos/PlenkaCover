import type { Role } from './roles';

export type RoleInboxSeverity = 'info' | 'warning' | 'critical';

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

export type RoleInboxEventRecipients = {
  /** Stable producer-owned key reused by an idempotent domain command. */
  notificationKey: string;
  recipientRoles: Role[];
  /** Explicit user targets for personal routes such as operator notifications. */
  recipientUserIds: string[];
};

export type RoleInboxOrderInfo = {
  orderNumber: string;
  /** Complete canonical leaf count from the immutable handover fact. */
  rollCount: number;
  /** Bounded safe preview; the projection currently exposes at most 20 codes. */
  rollCodes: string[];
  omittedRollCount: number;
};

export type RoleInboxItem = {
  id: string;
  /** Immutable event facts represented by this operational notification. */
  eventIds: string[];
  eventType: string;
  recipientRole: Role;
  nextOwnerRole: Role;
  severity: RoleInboxSeverity;
  title: string;
  body: string;
  createdAt: string;
  unread: boolean;
  orderId: string | null;
  orderNumber: string | null;
  orderInfo?: RoleInboxOrderInfo;
  financeOrderId: string | null;
  caseId: string | null;
  taskId: string | null;
  positionId: string | null;
  rollId: string | null;
  cta: { kind: RoleInboxCtaKind; targetId: string; section: string } | null;
};

export type RoleInboxPage = {
  items: RoleInboxItem[];
  nextCursor: string | null;
  unreadCount: number;
};
