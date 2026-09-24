import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Role,
  RoleInboxCtaKind,
  RoleInboxItem,
  RoleInboxOrderInfo,
  RoleInboxPage,
} from '@plenka/contracts';
import type { Actor } from '../auth/actor';
import { PrismaService } from '../prisma/prisma.service';
import { eventTypesFor, presentationFor, type RoleInboxPresentation } from './role-inbox.registry';

type RoleInboxQuery = { cursor?: string; limit?: number };
type Cursor = { createdAt: string; id: string };

type InboxEvent = {
  id: string;
  type: string;
  objectId: string | null;
  detail: Prisma.JsonValue | null;
  createdAt: Date;
  notificationReceipts: Array<{ readAt: Date }>;
};

type SafeOrder = { id: string; orderNumber: string };

type SafeFinanceOrder = {
  id: string;
  commercialOrderId: string;
  commercialOrder: SafeOrder;
};

type SafeProductionOrder = {
  id: string;
  commercialOrderId: string;
  commercialOrder: SafeOrder;
};

type SafeWarehouseTask = {
  id: string;
  orderId: string | null;
  positionId: string | null;
  proposalId: string | null;
  rows: Array<{ rollCode: string; fromOrderId: string | null }>;
};

type SafeResolutionCase = {
  id: string;
  orderId: string;
  problemId: string | null;
  type: string;
  status: string;
  ownerRole: Role;
  affectedPositionIds: Prisma.JsonValue;
  affectedRollIds: Prisma.JsonValue;
  order: SafeOrder;
};

type SafeDispatchItem = {
  id: string;
  rollCode: string;
  productionOrderId: string;
  orderLineId: string | null;
  assignedOperatorId: string | null;
  productionOrder: {
    commercialOrder: SafeOrder;
  };
};

type SafeProductionProblem = {
  id: string;
  orderId: string | null;
  positionId: string | null;
  rollId: string | null;
};

type SafeOperationalIncident = {
  id: string;
};

type ResolvedObjects = {
  orders: SafeOrder[];
  financeOrders: SafeFinanceOrder[];
  productionOrders: SafeProductionOrder[];
  warehouseTasks: SafeWarehouseTask[];
  resolutionCases: SafeResolutionCase[];
  dispatchItems: SafeDispatchItem[];
  productionProblems: SafeProductionProblem[];
  operationalIncidents: SafeOperationalIncident[];
};

type EventResolution = {
  order: SafeOrder;
  financeOrder: SafeFinanceOrder | null;
  productionOrder: SafeProductionOrder | null;
  warehouseTask: SafeWarehouseTask | null;
  resolutionCase: SafeResolutionCase | null;
  dispatchItem: SafeDispatchItem | null;
  taskId: string | null;
  positionId: string | null;
  rollId: string | null;
  targetId: string;
};

type OperatorRoute = { rollIds: ReadonlySet<string> | null };

const SAFE_DETAIL_ID_FIELDS = [
  'orderId',
  'commercialOrderId',
  'financeOrderId',
  'productionOrderId',
  'warehouseTaskId',
  'taskId',
  'resolutionCaseId',
  'caseId',
  'problemId',
  'positionId',
  'rollId',
  'rollCode',
  'proposalId',
] as const;

const SAFE_DETAIL_ID_ARRAY_FIELDS = [
  'orderIds',
  'positionIds',
  'rollIds',
  'rollCodes',
  'taskIds',
] as const;

const WAREHOUSE_TASK_EVENT_TYPES = new Set([
  'audit:warehouse_delivery_task_created',
  'audit:warehouse_roll_received',
  'audit:warehouse_roll_shipped',
  'audit:deferred_payment_due_scheduled',
]);

const TARGETED_OPERATOR_EVENT_TYPES = new Set(['audit:task_assigned', 'audit:task_reassigned']);

const PENALTY_EVENT_TYPE = 'notification:penalty_created';
const PRODUCTION_PROBLEM_EVENT_TYPES = new Set([
  'problem:operator_reported',
  'notification:production_problem_received',
  'problem:production_defect_reported',
  'problem:operator_defect_reported',
  'problem:warehouse_defect_reported',
]);
const ADMIN_INCIDENT_EVENT_TYPES = new Set(['admin.incident.opened', 'admin.incident.reopened']);
const RECIPIENT_AWARE_EVENT_TYPES = new Set([
  'notification:commercial_correction_applied',
  'notification:commercial_order_amended',
  'notification:commercial_order_cancelled',
  'notification:commercial_order_reactivated',
  'notification:production_order_fully_handed_over',
  'notification:operator_machine_change_requested',
  'notification:operator_machine_change_ready',
  'notification:operator_machine_change_completed',
]);
const RELATED_ALERT_EVENT_TYPES = new Set([
  ...RECIPIENT_AWARE_EVENT_TYPES,
  'problem:operator_defect_reported',
  'problem:production_defect_reported',
  'problem:warehouse_defect_reported',
  'problem:machine_breakdown_reported',
  'problem:shift_balance_mismatch',
  'audit:director_finance_override_applied',
  'audit:director_production_override_applied',
  'audit:director_warehouse_override_applied',
  'audit:inventory_manual_correction',
  'audit:replacement_roll_created',
  'audit:defect_resolved_rework',
  'audit:defect_resolved_writeoff',
  'audit:operator_physical_operation_recovered',
  'audit:warehouse_physical_operation_recovered',
]);
const PERSONAL_OPERATOR_EVENT_TYPES = new Set([
  ...RECIPIENT_AWARE_EVENT_TYPES,
  'problem:operator_defect_reported',
  'problem:production_defect_reported',
  'problem:warehouse_defect_reported',
  'audit:replacement_roll_created',
  'audit:defect_resolved_rework',
  'audit:defect_resolved_writeoff',
  'audit:operator_physical_operation_recovered',
]);

const COMMERCIAL_AMENDMENT_FIELD_LABELS: ReadonlyMap<string, string> = new Map([
  ['rollCount', 'количество рулонов'],
  ['filmType', 'тип плёнки'],
  ['actualThickness', 'фактическая толщина'],
  ['accountingThickness', 'учётная толщина'],
  ['widthMm', 'ширина'],
  ['plannedLengthM', 'плановая длина'],
  ['rawMaterialId', 'материал'],
  ['baseRawMaterialDefinitionId', 'базовый материал'],
  ['recipeDefinitionVersionId', 'рецептура'],
  ['recipeParameters', 'параметры рецептуры'],
  ['spoolType', 'тип шпули'],
  ['birka', 'бирка'],
  ['manualBirka', 'текст бирки'],
  ['comment', 'комментарий'],
  ['plannedWeightKg', 'плановый вес'],
]);

const OPERATOR_PERSONAL_EVENT_TYPES = ['audit:task_assigned', 'audit:task_reassigned'] as const;
const COMPLETED_ORDER_ROLL_CODE_LIMIT = 20;

function decodeCursor(value?: string): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.id !== 'string' || !parsed.id || Number.isNaN(Date.parse(parsed.createdAt))) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function encodeCursor(event: Pick<InboxEvent, 'createdAt' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ createdAt: event.createdAt.toISOString(), id: event.id }),
  ).toString('base64url');
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Prisma.JsonObject | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  return value as Prisma.JsonObject;
}

function jsonStrings(value: Prisma.JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function eventReferences(event: Pick<InboxEvent, 'objectId' | 'detail'>): string[] {
  const references = new Set<string>();
  if (event.objectId) references.add(event.objectId);
  const detail = jsonObject(event.detail);
  if (!detail) return [...references];

  for (const field of SAFE_DETAIL_ID_FIELDS) {
    const value = detail[field];
    if (typeof value === 'string' && value) references.add(value);
  }
  for (const field of SAFE_DETAIL_ID_ARRAY_FIELDS) {
    for (const value of jsonStrings(detail[field])) references.add(value);
  }
  return [...references];
}

function matches(references: ReadonlySet<string>, ...values: Array<string | null | undefined>) {
  return values.some((value) => Boolean(value && references.has(value)));
}

function detailString(event: InboxEvent, ...fields: string[]): string | null {
  const detail = jsonObject(event.detail);
  if (!detail) return null;
  for (const field of fields) {
    const value = detail[field];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

function detailNumber(event: InboxEvent, field: string): number | null {
  const value = jsonObject(event.detail)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function penaltyRoleLabel(role: string): string {
  return role === 'production_lead' ? 'зав. производства' : 'оператор';
}

function penaltyBody(event: InboxEvent, fallback: string): string {
  const targetRole = detailString(event, 'targetRole');
  const employeeName = detailString(event, 'employeeName');
  const reason = detailString(event, 'reason');
  const amount = detailNumber(event, 'amount');
  const orderNumber = detailString(event, 'orderNumber');
  const rollCode = detailString(event, 'rollCode');
  const sourceObjectId = detailString(event, 'sourceObjectId');
  const parts: string[] = [];

  if (employeeName && targetRole) {
    parts.push(sentence(`Получатель: ${employeeName} (${penaltyRoleLabel(targetRole)})`));
  }
  if (reason) parts.push(sentence(`Причина: ${reason}`));
  if (amount !== null) {
    parts.push(sentence(`Сумма: ${new Intl.NumberFormat('ru-RU').format(amount)} ₽`));
  }
  if (orderNumber) {
    parts.push(
      sentence(
        rollCode ? `Заказ ${orderNumber} · рулон ${rollCode}` : `Заказ ${orderNumber} целиком`,
      ),
    );
  } else if (sourceObjectId) {
    parts.push(sentence(`Объект: ${sourceObjectId}`));
  }

  return parts.length > 0 ? parts.join(' ') : fallback;
}

function detailStrings(event: InboxEvent, ...fields: string[]): string[] {
  const detail = jsonObject(event.detail);
  if (!detail) return [];
  return fields.flatMap((field) => jsonStrings(detail[field]));
}

function completedOrderInfo(
  event: InboxEvent,
  orderNumber: string | null,
): RoleInboxOrderInfo | null {
  if (event.type !== 'notification:production_order_fully_handed_over' || !orderNumber) {
    return null;
  }
  const rollCount = detailNumber(event, 'rollCount');
  if (rollCount === null || !Number.isSafeInteger(rollCount) || rollCount < 1) return null;
  const rawCodes = jsonObject(event.detail)?.rollIds;
  const rollCodes: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(rawCodes)) {
    for (const value of rawCodes) {
      if (rollCodes.length >= COMPLETED_ORDER_ROLL_CODE_LIMIT) break;
      if (typeof value !== 'string') continue;
      const code = value.trim();
      if (!code || code.length > 128 || seen.has(code)) continue;
      seen.add(code);
      rollCodes.push(code);
    }
  }
  return {
    orderNumber,
    rollCount,
    rollCodes,
    omittedRollCount: Math.max(0, rollCount - rollCodes.length),
  };
}

function commercialAmendmentFinanceBody(event: InboxEvent, fallback: string): string {
  const labels = new Set<string>();
  for (const field of detailStrings(event, 'changedFields')) {
    const label = COMMERCIAL_AMENDMENT_FIELD_LABELS.get(field);
    if (label) labels.add(label);
  }
  if (labels.size === 0) return fallback;
  return `Коммерция изменила параметры заявки: ${[...labels].join(', ')}. Проверьте актуальный финансовый маршрут.`;
}

function referencedRollIds(event: InboxEvent, includeObjectId = false): Set<string> {
  const rollIds = new Set(detailStrings(event, 'rollIds', 'rollCodes'));
  const rollId = detailString(event, 'rollId', 'rollCode');
  if (rollId) rollIds.add(rollId);
  if (includeObjectId && event.objectId) rollIds.add(event.objectId);
  return rollIds;
}

function isOperatorAssignmentRecipient(event: InboxEvent, actor: Actor): boolean {
  if (!event.objectId || !actor.userId || !TARGETED_OPERATOR_EVENT_TYPES.has(event.type)) {
    return false;
  }
  const operatorId = detailString(event, 'operatorId');
  if (event.type === 'audit:task_assigned') return operatorId === actor.userId;
  return operatorId === actor.userId || detailString(event, 'previousOperatorId') === actor.userId;
}

function isExplicitRecipient(event: InboxEvent, actor: Actor, recipientRole: Role): boolean {
  if (!detailStrings(event, 'recipientRoles').includes(recipientRole)) return false;
  if (recipientRole !== 'operator') return true;
  return Boolean(actor.userId && detailStrings(event, 'recipientUserIds').includes(actor.userId));
}

function deduplicateNotificationEvents(events: InboxEvent[]): {
  events: InboxEvent[];
  duplicateUnreadCount: number;
} {
  const seen = new Set<string>();
  const unique: InboxEvent[] = [];
  let duplicateUnreadCount = 0;

  for (const event of events) {
    const notificationKey = detailString(event, 'notificationKey');
    const identity = notificationKey ? `${event.type}\u0000${notificationKey}` : event.id;
    if (seen.has(identity)) {
      if (event.notificationReceipts.length === 0) duplicateUnreadCount += 1;
      continue;
    }
    seen.add(identity);
    unique.push(event);
  }

  return { events: unique, duplicateUnreadCount };
}

function groupOperatorAssignmentItems(items: RoleInboxItem[]): {
  items: RoleInboxItem[];
  collapsedUnreadCount: number;
} {
  const grouped: RoleInboxItem[] = [];
  const groupIndexes = new Map<string, number>();
  let collapsedUnreadCount = 0;

  for (const item of items) {
    if (
      item.recipientRole !== 'operator' ||
      !TARGETED_OPERATOR_EVENT_TYPES.has(item.eventType) ||
      !item.orderId
    ) {
      grouped.push(item);
      continue;
    }

    const key = `${item.eventType}\u0000${item.orderId}`;
    const existingIndex = groupIndexes.get(key);
    if (existingIndex === undefined) {
      groupIndexes.set(key, grouped.length);
      grouped.push(normalizeOperatorAssignmentItem(item));
      continue;
    }

    const existing = grouped[existingIndex]!;
    const eventIds = [...new Set([...existing.eventIds, ...item.eventIds])];
    grouped[existingIndex] = {
      ...existing,
      eventIds,
      body: `Назначено рулонов: ${eventIds.length}. Откройте заказ и проверьте очередь.`,
    };
    if (item.unread) collapsedUnreadCount += 1;
  }

  return { items: grouped, collapsedUnreadCount };
}

function normalizeOperatorAssignmentItem(item: RoleInboxItem): RoleInboxItem {
  const reassigned = item.eventType === 'audit:task_reassigned';
  return {
    ...item,
    title: reassigned ? 'Назначение заказа изменено' : 'Назначен заказ',
    body: reassigned
      ? 'Состав назначения по заказу изменён. Откройте заказ и проверьте очередь.'
      : 'Заказ назначен. Откройте заказ и проверьте очередь.',
    positionId: null,
    rollId: null,
    cta: {
      kind: 'operator_queue',
      targetId: item.orderId!,
      section: item.cta?.section ?? 'Рулоны и заказы',
    },
  };
}

function recipientWhere(actor: Actor, recipientRole: Role): Prisma.DomainEventWhereInput {
  const userId = actor.userId ?? '';
  const eventTypes = eventTypesFor(recipientRole);
  const scopedTypes: string[] = [];
  const scopedRoutes: Prisma.DomainEventWhereInput[] = [];

  if (recipientRole === 'operator') {
    scopedTypes.push(...OPERATOR_PERSONAL_EVENT_TYPES);
    scopedRoutes.push(
      {
        type: 'audit:task_assigned',
        objectId: { not: null },
        detail: { path: ['operatorId'], equals: userId },
      },
      {
        type: 'audit:task_reassigned',
        objectId: { not: null },
        OR: [
          { detail: { path: ['operatorId'], equals: userId } },
          { detail: { path: ['previousOperatorId'], equals: userId } },
        ],
      },
    );
  }

  if (eventTypes.includes(PENALTY_EVENT_TYPE)) {
    scopedTypes.push(PENALTY_EVENT_TYPE);
    scopedRoutes.push({
      type: PENALTY_EVENT_TYPE,
      objectId: { not: null },
      AND: [
        { detail: { path: ['targetRole'], equals: recipientRole } },
        { detail: { path: ['employeeId'], equals: userId } },
      ],
    });
  }

  const productionProblemEventTypes = eventTypes.filter(
    (eventType) =>
      PRODUCTION_PROBLEM_EVENT_TYPES.has(eventType) &&
      !(recipientRole === 'operator' && PERSONAL_OPERATOR_EVENT_TYPES.has(eventType)),
  );
  if (productionProblemEventTypes.length > 0) {
    scopedTypes.push(...productionProblemEventTypes);
    scopedRoutes.push(
      ...productionProblemEventTypes.map((eventType) => ({
        type: eventType,
        detail: { path: ['problemId'], not: Prisma.AnyNull },
      })),
    );
  }

  const adminIncidentEventTypes = eventTypes.filter((eventType) =>
    ADMIN_INCIDENT_EVENT_TYPES.has(eventType),
  );
  if (adminIncidentEventTypes.length > 0) {
    scopedTypes.push(...adminIncidentEventTypes);
    scopedRoutes.push(
      ...adminIncidentEventTypes.map((eventType) => ({
        type: eventType,
        objectId: { not: null },
      })),
    );
  }

  const recipientAwareEventTypes = eventTypes.filter((eventType) =>
    RECIPIENT_AWARE_EVENT_TYPES.has(eventType),
  );
  if (recipientAwareEventTypes.length > 0) {
    scopedTypes.push(...recipientAwareEventTypes);
    scopedRoutes.push(
      ...recipientAwareEventTypes.map((eventType) => ({
        type: eventType,
        AND: [
          {
            detail: {
              path: ['recipientRoles'],
              array_contains: recipientRole,
            },
          },
          ...(recipientRole === 'operator'
            ? [
                {
                  detail: {
                    path: ['recipientUserIds'],
                    array_contains: userId,
                  },
                },
              ]
            : []),
        ],
      })),
    );
  }

  if (recipientRole === 'operator') {
    const personalOperatorEventTypes = eventTypes.filter(
      (eventType) =>
        PERSONAL_OPERATOR_EVENT_TYPES.has(eventType) && !RECIPIENT_AWARE_EVENT_TYPES.has(eventType),
    );
    if (personalOperatorEventTypes.length > 0) {
      scopedTypes.push(...personalOperatorEventTypes);
      scopedRoutes.push(
        ...personalOperatorEventTypes.map((eventType) => ({
          type: eventType,
          AND: [
            {
              detail: {
                path: ['recipientRoles'],
                array_contains: recipientRole,
              },
            },
            {
              detail: {
                path: ['recipientUserIds'],
                array_contains: userId,
              },
            },
          ],
        })),
      );
    }
  }

  return {
    type: { in: eventTypes },
    ...(scopedRoutes.length > 0
      ? {
          AND: [
            {
              OR: [{ type: { notIn: scopedTypes } }, ...scopedRoutes],
            },
          ],
        }
      : {}),
  };
}

function firstJsonString(value: Prisma.JsonValue): string | null {
  return jsonStrings(value)[0] ?? null;
}

@Injectable()
export class RoleInboxProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  async list(actor: Actor, recipientRole: Role, query: RoleInboxQuery): Promise<RoleInboxPage> {
    const userId = this.authorize(actor, recipientRole);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const cursor = decodeCursor(query.cursor);
    const recipientScope = recipientWhere(actor, recipientRole);
    const resetCutoff = await this.latestPilotResetCutoff();
    const currentScope: Prisma.DomainEventWhereInput = resetCutoff
      ? { AND: [recipientScope, { createdAt: { gt: resetCutoff } }] }
      : recipientScope;
    const cursorScope: Prisma.DomainEventWhereInput | null = cursor
      ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
          ],
        }
      : null;
    const unreadScope: Prisma.DomainEventWhereInput = {
      notificationReceipts: { none: { userId } },
    };
    const [events, unreadCount]: [InboxEvent[], number] = await Promise.all([
      this.prisma.domainEvent.findMany({
        where: cursorScope
          ? { AND: [currentScope, cursorScope], ...unreadScope }
          : { ...currentScope, ...unreadScope },
        select: {
          id: true,
          type: true,
          objectId: true,
          detail: true,
          createdAt: true,
          notificationReceipts: {
            where: { userId },
            select: { readAt: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      this.prisma.domainEvent.count({
        where: {
          AND: [
            recipientScope,
            ...(resetCutoff ? [{ createdAt: { gt: resetCutoff } }] : []),
            { notificationReceipts: { none: { userId } } },
          ],
        },
      }),
    ]);
    const pageEvents = events
      .filter((event) => event.notificationReceipts.length === 0)
      .slice(0, limit);
    const deduplicated = deduplicateNotificationEvents(pageEvents);
    const resolved = await this.resolveObjects(deduplicated.events, actor);
    const projectedItems = deduplicated.events.flatMap((event): RoleInboxItem[] => {
      const item = this.toItem(event, actor, recipientRole, resolved);
      return item ? [item] : [];
    });
    const grouped = groupOperatorAssignmentItems(projectedItems);

    return {
      items: grouped.items,
      nextCursor:
        events.length > limit && pageEvents.length > 0
          ? encodeCursor(pageEvents[pageEvents.length - 1]!)
          : null,
      unreadCount: Math.max(
        0,
        unreadCount - deduplicated.duplicateUnreadCount - grouped.collapsedUnreadCount,
      ),
    };
  }

  async markRead(
    actor: Actor,
    recipientRole: Role,
    eventId: string,
  ): Promise<{ ok: true; eventId: string }> {
    const userId = this.authorize(actor, recipientRole);
    const recipientScope = recipientWhere(actor, recipientRole);
    const resetCutoff = await this.latestPilotResetCutoff();
    const event = await this.prisma.domainEvent.findFirst({
      where: {
        AND: [
          recipientScope,
          ...(resetCutoff ? [{ createdAt: { gt: resetCutoff } }] : []),
          { id: eventId },
        ],
      },
      select: {
        id: true,
        type: true,
        objectId: true,
        detail: true,
        createdAt: true,
        notificationReceipts: {
          where: { userId },
          select: { readAt: true },
        },
      },
    });
    if (!event) throw new NotFoundException(`Notification ${eventId} not found`);

    const resolved = await this.resolveObjects([event], actor);
    if (!this.toItem(event, actor, recipientRole, resolved)) {
      throw new NotFoundException(`Notification ${eventId} not found`);
    }

    let eventsToRead: InboxEvent[] = [event];
    const assignmentOrderId =
      recipientRole === 'operator' && TARGETED_OPERATOR_EVENT_TYPES.has(event.type)
        ? detailString(event, 'commercialOrderId')
        : null;
    if (assignmentOrderId) {
      const groupedEvents = await this.prisma.domainEvent.findMany({
        where: {
          AND: [
            recipientScope,
            ...(resetCutoff ? [{ createdAt: { gt: resetCutoff } }] : []),
            { type: event.type },
            {
              detail: {
                path: ['commercialOrderId'],
                equals: assignmentOrderId,
              },
            },
          ],
        },
        select: {
          id: true,
          type: true,
          objectId: true,
          detail: true,
          createdAt: true,
          notificationReceipts: {
            where: { userId },
            select: { readAt: true },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      eventsToRead = groupedEvents.filter((candidate) =>
        isOperatorAssignmentRecipient(candidate, actor),
      );
      if (eventsToRead.length === 0) eventsToRead = [event];
    }

    await Promise.all(
      eventsToRead.map((candidate) =>
        this.prisma.notificationReceipt.upsert({
          where: { userId_eventId: { userId, eventId: candidate.id } },
          create: { userId, eventId: candidate.id },
          update: {},
        }),
      ),
    );
    return { ok: true, eventId };
  }

  private async latestPilotResetCutoff(): Promise<Date | null> {
    const marker = await this.prisma.domainEvent.findFirst({
      where: { type: 'audit:pilot_demo_reset' },
      select: { createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return marker?.createdAt ?? null;
  }

  private authorize(actor: Actor, recipientRole: Role): string {
    if (!actor.userId) throw new UnauthorizedException('Authentication required.');
    if (actor.role !== recipientRole) {
      throw new ForbiddenException('Inbox recipient does not match the authenticated role.');
    }
    return actor.userId;
  }

  private async resolveObjects(events: InboxEvent[], actor: Actor): Promise<ResolvedObjects> {
    const references = new Set(events.flatMap(eventReferences));
    if (references.size === 0) {
      return {
        orders: [],
        financeOrders: [],
        productionOrders: [],
        warehouseTasks: [],
        resolutionCases: [],
        dispatchItems: [],
        productionProblems: [],
        operationalIncidents: [],
      };
    }
    const ids = [...references];
    const dispatchIds = [...new Set(events.flatMap(eventReferences))];
    const productionProblemIds = events
      .filter((event) => PRODUCTION_PROBLEM_EVENT_TYPES.has(event.type))
      .flatMap((event) => {
        const problemId = detailString(event, 'problemId');
        return problemId ? [problemId] : [];
      });
    const operationalIncidentIds = events
      .filter((event) => ADMIN_INCIDENT_EVENT_TYPES.has(event.type))
      .flatMap((event) => (event.objectId ? [event.objectId] : []));
    const [
      warehouseTasks,
      resolutionCases,
      dispatchItems,
      productionProblems,
      operationalIncidents,
    ]: [
      SafeWarehouseTask[],
      SafeResolutionCase[],
      SafeDispatchItem[],
      SafeProductionProblem[],
      SafeOperationalIncident[],
    ] = await Promise.all([
      this.prisma.warehouseAcceptanceTask.findMany({
        where: {
          OR: [{ id: { in: ids } }, { rows: { some: { rollCode: { in: ids } } } }],
        },
        select: {
          id: true,
          orderId: true,
          positionId: true,
          proposalId: true,
          rows: {
            select: { rollCode: true, fromOrderId: true },
            orderBy: { id: 'asc' },
          },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.orderResolutionCase.findMany({
        where: {
          OR: [{ id: { in: ids } }, { orderId: { in: ids } }, { problemId: { in: ids } }],
        },
        select: {
          id: true,
          orderId: true,
          problemId: true,
          type: true,
          status: true,
          ownerRole: true,
          affectedPositionIds: true,
          affectedRollIds: true,
          order: { select: { id: true, orderNumber: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      }),
      dispatchIds.length > 0
        ? this.prisma.rollDispatchItem.findMany({
            where: {
              ...(actor.role === 'operator' ? { assignedOperatorId: actor.userId } : {}),
              OR: [
                { id: { in: dispatchIds } },
                { rollCode: { in: dispatchIds } },
                { productionOrderId: { in: dispatchIds } },
                { orderLineId: { in: dispatchIds } },
                { productionOrder: { commercialOrderId: { in: dispatchIds } } },
              ],
            },
            select: {
              id: true,
              rollCode: true,
              productionOrderId: true,
              orderLineId: true,
              assignedOperatorId: true,
              productionOrder: {
                select: {
                  commercialOrder: { select: { id: true, orderNumber: true } },
                },
              },
            },
            orderBy: [{ queueRank: 'asc' }, { id: 'asc' }],
          })
        : Promise.resolve([]),
      productionProblemIds.length > 0
        ? this.prisma.productionProblem.findMany({
            where: { id: { in: productionProblemIds } },
            select: { id: true, orderId: true, positionId: true, rollId: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
      operationalIncidentIds.length > 0
        ? this.prisma.operationalIncident.findMany({
            where: { id: { in: operationalIncidentIds } },
            select: { id: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    for (const task of warehouseTasks) {
      if (task.orderId) references.add(task.orderId);
      for (const row of task.rows) {
        references.add(row.rollCode);
        if (row.fromOrderId) references.add(row.fromOrderId);
      }
    }
    for (const resolutionCase of resolutionCases) {
      references.add(resolutionCase.orderId);
      references.add(resolutionCase.order.id);
      references.add(resolutionCase.order.orderNumber);
    }
    for (const dispatchItem of dispatchItems) {
      references.add(dispatchItem.productionOrderId);
      references.add(dispatchItem.productionOrder.commercialOrder.id);
      references.add(dispatchItem.productionOrder.commercialOrder.orderNumber);
      if (dispatchItem.orderLineId) references.add(dispatchItem.orderLineId);
    }

    const expandedIds = [...references];
    const [orders, financeOrders, productionOrders]: [
      SafeOrder[],
      SafeFinanceOrder[],
      SafeProductionOrder[],
    ] = await Promise.all([
      this.prisma.commercialOrder.findMany({
        where: {
          OR: [{ id: { in: expandedIds } }, { orderNumber: { in: expandedIds } }],
        },
        select: { id: true, orderNumber: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.financeOrder.findMany({
        where: {
          OR: [
            { id: { in: expandedIds } },
            { commercialOrderId: { in: expandedIds } },
            { commercialOrder: { orderNumber: { in: expandedIds } } },
          ],
        },
        select: {
          id: true,
          commercialOrderId: true,
          commercialOrder: { select: { id: true, orderNumber: true } },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.productionOrder.findMany({
        where: {
          OR: [
            { id: { in: expandedIds } },
            { commercialOrderId: { in: expandedIds } },
            { commercialOrder: { orderNumber: { in: expandedIds } } },
          ],
        },
        select: {
          id: true,
          commercialOrderId: true,
          commercialOrder: { select: { id: true, orderNumber: true } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);

    return {
      orders,
      financeOrders,
      productionOrders,
      warehouseTasks,
      resolutionCases,
      dispatchItems,
      productionProblems,
      operationalIncidents,
    };
  }

  private toItem(
    event: InboxEvent,
    actor: Actor,
    recipientRole: Role,
    objects: ResolvedObjects,
  ): RoleInboxItem | null {
    const presentation = presentationFor(event.type, recipientRole);
    if (!presentation) return null;
    if (presentation.cta.kind === 'penalty') {
      return this.toPenaltyItem(event, actor, recipientRole, presentation);
    }
    if (presentation.cta.kind === 'production_problem') {
      return this.toProductionProblemItem(event, recipientRole, presentation, objects);
    }
    if (presentation.cta.kind === 'admin_incident') {
      return this.toAdminIncidentItem(event, recipientRole, presentation, objects);
    }
    if (RELATED_ALERT_EVENT_TYPES.has(event.type)) {
      return this.toRelatedRoleItem(event, actor, recipientRole, presentation, objects);
    }
    if (recipientRole === 'operator' && TARGETED_OPERATOR_EVENT_TYPES.has(event.type)) {
      return this.toOperatorAssignmentItem(event, actor, recipientRole, presentation, objects);
    }
    const resolution = this.resolveEvent(
      event,
      actor,
      recipientRole,
      presentation.cta.kind,
      objects,
    );
    if (!resolution) return null;

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title: presentation.title,
      body: presentation.body,
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: resolution.order.id,
      orderNumber: resolution.order.orderNumber,
      financeOrderId: resolution.financeOrder?.id ?? null,
      caseId: resolution.resolutionCase?.id ?? null,
      taskId: resolution.taskId,
      positionId: resolution.positionId,
      rollId: resolution.rollId,
      cta: {
        kind: presentation.cta.kind,
        targetId: resolution.targetId,
        section: presentation.cta.section,
      },
    };
  }

  private toRelatedRoleItem(
    event: InboxEvent,
    actor: Actor,
    recipientRole: Role,
    presentation: RoleInboxPresentation,
    objects: ResolvedObjects,
  ): RoleInboxItem | null {
    if (
      (RECIPIENT_AWARE_EVENT_TYPES.has(event.type) ||
        (recipientRole === 'operator' && PERSONAL_OPERATOR_EVENT_TYPES.has(event.type))) &&
      !isExplicitRecipient(event, actor, recipientRole)
    ) {
      return null;
    }
    const resolution = this.resolveEvent(
      event,
      actor,
      recipientRole,
      presentation.cta.kind,
      objects,
    );
    const references = new Set(eventReferences(event));
    const fallbackOrder =
      objects.orders.find((candidate) =>
        matches(references, candidate.id, candidate.orderNumber),
      ) ??
      objects.productionOrders.find((candidate) =>
        matches(
          references,
          candidate.id,
          candidate.commercialOrderId,
          candidate.commercialOrder.id,
          candidate.commercialOrder.orderNumber,
        ),
      )?.commercialOrder ??
      objects.dispatchItems.find((candidate) =>
        matches(
          references,
          candidate.id,
          candidate.rollCode,
          candidate.productionOrderId,
          candidate.orderLineId,
          candidate.productionOrder.commercialOrder.id,
          candidate.productionOrder.commercialOrder.orderNumber,
        ),
      )?.productionOrder.commercialOrder ??
      null;
    const immutableOrderId =
      detailString(event, 'orderId', 'commercialOrderId') ??
      (event.type === 'notification:commercial_correction_applied' ? event.objectId : null);
    const orderNumber =
      resolution?.order.orderNumber ??
      fallbackOrder?.orderNumber ??
      detailString(event, 'orderNumber');
    const orderInfo = completedOrderInfo(event, orderNumber);

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title:
        event.type === 'notification:production_order_fully_handed_over' && orderNumber
          ? `Заказ ${orderNumber} полностью передан на склад`
          : presentation.title,
      body:
        recipientRole === 'finance' && event.type === 'notification:commercial_order_amended'
          ? commercialAmendmentFinanceBody(event, presentation.body)
          : presentation.body,
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: resolution?.order.id ?? fallbackOrder?.id ?? immutableOrderId,
      orderNumber,
      ...(orderInfo ? { orderInfo } : {}),
      financeOrderId: resolution?.financeOrder?.id ?? null,
      caseId: resolution?.resolutionCase?.id ?? detailString(event, 'caseId', 'resolutionCaseId'),
      taskId:
        resolution?.taskId ?? detailString(event, 'taskId', 'problemId', 'operationId', 'changeId'),
      positionId: resolution?.positionId ?? detailString(event, 'positionId'),
      rollId:
        resolution?.rollId ??
        detailString(event, 'rollId', 'rollCode') ??
        detailStrings(event, 'rollIds', 'rollCodes')[0] ??
        null,
      cta: resolution
        ? {
            kind: presentation.cta.kind,
            targetId: resolution.targetId,
            section: presentation.cta.section,
          }
        : null,
    };
  }

  private toOperatorAssignmentItem(
    event: InboxEvent,
    actor: Actor,
    recipientRole: Role,
    presentation: RoleInboxPresentation,
    objects: ResolvedObjects,
  ): RoleInboxItem | null {
    if (!isOperatorAssignmentRecipient(event, actor)) return null;
    const references = new Set(eventReferences(event));
    const rollReferences = referencedRollIds(event);
    if (event.objectId) rollReferences.add(event.objectId);
    const dispatchItem = this.pickDispatchItem(
      rollReferences,
      objects.dispatchItems,
      actor,
      'operator_roll',
    );
    const productionOrder = this.pickProductionOrder(references, objects.productionOrders);
    const order =
      dispatchItem?.productionOrder.commercialOrder ??
      productionOrder?.commercialOrder ??
      objects.orders.find((candidate) =>
        matches(references, candidate.id, candidate.orderNumber),
      ) ??
      null;
    const immutableOrderId = detailString(event, 'commercialOrderId');
    const targetId =
      order?.id ?? immutableOrderId ?? detailString(event, 'productionOrderId') ?? event.id;

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title: presentation.title,
      body: presentation.body,
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: order?.id ?? immutableOrderId,
      orderNumber: order?.orderNumber ?? detailString(event, 'orderNumber'),
      financeOrderId: null,
      caseId: null,
      taskId: null,
      positionId: dispatchItem?.orderLineId ?? null,
      rollId: dispatchItem?.rollCode ?? null,
      cta: {
        kind: dispatchItem ? 'operator_roll' : 'operator_queue',
        targetId: dispatchItem?.rollCode ?? targetId,
        section: presentation.cta.section,
      },
    };
  }

  private toProductionProblemItem(
    event: InboxEvent,
    recipientRole: Role,
    presentation: RoleInboxPresentation,
    objects: ResolvedObjects,
  ): RoleInboxItem | null {
    const problemId = detailString(event, 'problemId');
    const problem = problemId
      ? objects.productionProblems.find((candidate) => candidate.id === problemId)
      : null;
    if (!problem) return null;
    const order = problem.orderId
      ? (objects.orders.find((candidate) => candidate.id === problem.orderId) ?? null)
      : null;

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title: presentation.title,
      body: presentation.body,
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: problem.orderId,
      orderNumber: order?.orderNumber ?? null,
      financeOrderId: null,
      caseId: null,
      taskId: problem.id,
      positionId: problem.positionId,
      rollId: problem.rollId,
      cta: {
        kind: 'production_problem',
        targetId: problem.id,
        section: presentation.cta.section,
      },
    };
  }

  private toAdminIncidentItem(
    event: InboxEvent,
    recipientRole: Role,
    presentation: RoleInboxPresentation,
    objects: ResolvedObjects,
  ): RoleInboxItem | null {
    const incident = event.objectId
      ? objects.operationalIncidents.find((candidate) => candidate.id === event.objectId)
      : null;
    if (!incident) return null;

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title: presentation.title,
      body: presentation.body,
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: null,
      orderNumber: null,
      financeOrderId: null,
      caseId: null,
      taskId: incident.id,
      positionId: null,
      rollId: null,
      cta: {
        kind: 'admin_incident',
        targetId: incident.id,
        section: presentation.cta.section,
      },
    };
  }

  private toPenaltyItem(
    event: InboxEvent,
    actor: Actor,
    recipientRole: Role,
    presentation: RoleInboxPresentation,
  ): RoleInboxItem | null {
    const targetRole = detailString(event, 'targetRole');
    const employeeId = detailString(event, 'employeeId');
    if (
      !event.objectId ||
      targetRole !== recipientRole ||
      !employeeId ||
      employeeId !== actor.userId
    ) {
      return null;
    }

    return {
      id: event.id,
      eventIds: [event.id],
      eventType: event.type,
      recipientRole,
      nextOwnerRole: presentation.nextOwnerRole,
      severity: presentation.severity,
      title: presentation.title,
      body: penaltyBody(event, presentation.body),
      createdAt: event.createdAt.toISOString(),
      unread: event.notificationReceipts.length === 0,
      orderId: null,
      orderNumber: detailString(event, 'orderNumber'),
      financeOrderId: null,
      caseId: null,
      taskId: null,
      positionId: null,
      rollId: detailString(event, 'rollCode'),
      cta: {
        kind: 'penalty',
        targetId: event.objectId,
        section: presentation.cta.section,
      },
    };
  }

  private resolveEvent(
    event: InboxEvent,
    actor: Actor,
    recipientRole: Role,
    ctaKind: RoleInboxCtaKind,
    objects: ResolvedObjects,
  ): EventResolution | null {
    const references = new Set(eventReferences(event));
    const operatorRoute =
      ctaKind === 'operator_roll' ? this.resolveOperatorRoute(event, actor) : null;
    if (ctaKind === 'operator_roll' && !operatorRoute) return null;
    const warehouseTask = this.pickWarehouseTask(event, ctaKind, objects.warehouseTasks);
    const resolutionCase = this.pickResolutionCase(
      event,
      recipientRole,
      ctaKind,
      objects.resolutionCases,
    );
    const dispatchItem = ['operator_roll', 'production_order', 'warehouse_intake'].includes(ctaKind)
      ? this.pickDispatchItem(
          operatorRoute?.rollIds ?? references,
          objects.dispatchItems,
          actor,
          ctaKind,
        )
      : null;
    const directOrder = objects.orders.find((candidate) =>
      matches(references, candidate.id, candidate.orderNumber),
    );
    const taskOrder = warehouseTask
      ? objects.orders.find(
          (candidate) =>
            matches(new Set([warehouseTask.orderId ?? '']), candidate.id, candidate.orderNumber) ||
            warehouseTask.rows.some(
              (row) =>
                row.fromOrderId === candidate.id || row.fromOrderId === candidate.orderNumber,
            ),
        )
      : null;
    const linkedOrder =
      dispatchItem?.productionOrder.commercialOrder ??
      resolutionCase?.order ??
      taskOrder ??
      directOrder ??
      null;
    const financeOrder =
      this.pickFinanceOrder(references, objects.financeOrders) ??
      objects.financeOrders.find((candidate) => candidate.commercialOrderId === linkedOrder?.id) ??
      null;
    const productionOrder =
      this.pickProductionOrder(references, objects.productionOrders) ??
      objects.productionOrders.find(
        (candidate) => candidate.commercialOrderId === linkedOrder?.id,
      ) ??
      null;
    const order =
      dispatchItem?.productionOrder.commercialOrder ??
      financeOrder?.commercialOrder ??
      productionOrder?.commercialOrder ??
      resolutionCase?.order ??
      taskOrder ??
      directOrder ??
      null;
    if (!order) return null;

    const targetId = this.targetId(
      ctaKind,
      recipientRole,
      order,
      financeOrder,
      productionOrder,
      warehouseTask,
      resolutionCase,
      dispatchItem,
    );
    if (!targetId) return null;

    const taskAggregateIsRelevant =
      ctaKind === 'warehouse_intake' || WAREHOUSE_TASK_EVENT_TYPES.has(event.type);
    const caseAggregateIsRelevant =
      ctaKind === 'warehouse_cover' || ctaKind === 'director_decision';
    const positionId =
      detailString(event, 'positionId') ??
      (taskAggregateIsRelevant ? warehouseTask?.positionId : null) ??
      (ctaKind === 'operator_roll' ||
      ctaKind === 'production_order' ||
      ctaKind === 'warehouse_intake'
        ? dispatchItem?.orderLineId
        : null) ??
      (caseAggregateIsRelevant && resolutionCase
        ? firstJsonString(resolutionCase.affectedPositionIds)
        : null);
    const rollId =
      detailString(event, 'rollId', 'rollCode') ??
      (ctaKind === 'operator_roll' ||
      ctaKind === 'production_order' ||
      ctaKind === 'warehouse_intake'
        ? dispatchItem?.rollCode
        : null) ??
      (taskAggregateIsRelevant ? warehouseTask?.rows[0]?.rollCode : null) ??
      (caseAggregateIsRelevant && resolutionCase
        ? firstJsonString(resolutionCase.affectedRollIds)
        : null);

    return {
      order,
      financeOrder,
      productionOrder,
      warehouseTask,
      resolutionCase,
      dispatchItem,
      taskId: warehouseTask?.id ?? resolutionCase?.id ?? null,
      positionId,
      rollId,
      targetId,
    };
  }

  private pickFinanceOrder(references: ReadonlySet<string>, rows: SafeFinanceOrder[]) {
    return (
      rows.find((row) => references.has(row.id)) ??
      rows.find((row) =>
        matches(
          references,
          row.commercialOrderId,
          row.commercialOrder.id,
          row.commercialOrder.orderNumber,
        ),
      ) ??
      null
    );
  }

  private pickProductionOrder(references: ReadonlySet<string>, rows: SafeProductionOrder[]) {
    return (
      rows.find((row) => references.has(row.id)) ??
      rows.find((row) =>
        matches(
          references,
          row.commercialOrderId,
          row.commercialOrder.id,
          row.commercialOrder.orderNumber,
        ),
      ) ??
      null
    );
  }

  private pickWarehouseTask(
    event: InboxEvent,
    ctaKind: RoleInboxCtaKind,
    rows: SafeWarehouseTask[],
  ) {
    if (ctaKind !== 'warehouse_intake' && !WAREHOUSE_TASK_EVENT_TYPES.has(event.type)) return null;

    const explicitTaskId = detailString(event, 'warehouseTaskId', 'taskId');
    if (explicitTaskId) return rows.find((row) => row.id === explicitTaskId) ?? null;

    if (WAREHOUSE_TASK_EVENT_TYPES.has(event.type)) {
      return rows.find((row) => row.id === event.objectId) ?? null;
    }
    const rollIds = referencedRollIds(event, event.type === 'audit:operator_roll_handed_over');
    if (rollIds.size === 0) return null;
    return rows.find((row) => row.rows.some((item) => rollIds.has(item.rollCode))) ?? null;
  }

  private resolveOperatorRoute(event: InboxEvent, actor: Actor): OperatorRoute | null {
    if (
      RECIPIENT_AWARE_EVENT_TYPES.has(event.type) ||
      PERSONAL_OPERATOR_EVENT_TYPES.has(event.type)
    ) {
      if (!isExplicitRecipient(event, actor, 'operator')) return null;
      const rollIds = referencedRollIds(event);
      return { rollIds: rollIds.size > 0 ? rollIds : null };
    }
    if (!TARGETED_OPERATOR_EVENT_TYPES.has(event.type)) return null;
    const operatorId = detailString(event, 'operatorId', 'assignedOperatorId');
    if (!operatorId || operatorId !== actor.userId) return null;

    const rollIds = referencedRollIds(event);
    if (rollIds.size === 0 && event.objectId) rollIds.add(event.objectId);
    return rollIds.size > 0 ? { rollIds } : null;
  }

  private pickResolutionCase(
    event: InboxEvent,
    recipientRole: Role,
    ctaKind: RoleInboxCtaKind,
    rows: SafeResolutionCase[],
  ) {
    const explicitCaseId = detailString(event, 'resolutionCaseId', 'caseId');
    if (explicitCaseId) {
      const resolutionCase = rows.find((row) => row.id === explicitCaseId) ?? null;
      if (!resolutionCase) return null;
      if (
        ctaKind === 'warehouse_cover' &&
        !['warehouse_cover_check', 'warehouse_coverage_recheck'].includes(resolutionCase.type)
      ) {
        return null;
      }
      if (ctaKind === 'finance_order' && resolutionCase.type !== 'warehouse_coverage_recheck') {
        return null;
      }
      return ['warehouse_cover', 'director_decision', 'finance_order'].includes(ctaKind)
        ? resolutionCase
        : null;
    }

    if (ctaKind !== 'warehouse_cover' && ctaKind !== 'director_decision') return null;

    const references = new Set(eventReferences(event));
    if (ctaKind === 'director_decision') {
      const problemId = detailString(event, 'problemId') ?? event.objectId;
      return rows.find((row) => row.problemId === problemId) ?? null;
    }
    if (recipientRole !== 'warehouse') return null;

    return (
      rows.find(
        (row) =>
          ['warehouse_cover_check', 'warehouse_coverage_recheck'].includes(row.type) &&
          row.status === 'open' &&
          row.ownerRole === 'warehouse' &&
          matches(references, row.orderId, row.order.id, row.order.orderNumber),
      ) ?? null
    );
  }

  private pickDispatchItem(
    references: ReadonlySet<string>,
    rows: SafeDispatchItem[],
    actor: Actor,
    ctaKind: RoleInboxCtaKind,
  ) {
    const candidates = rows.filter(
      (row) =>
        matches(
          references,
          row.id,
          row.rollCode,
          row.productionOrderId,
          row.orderLineId,
          row.productionOrder.commercialOrder.id,
          row.productionOrder.commercialOrder.orderNumber,
        ) &&
        (ctaKind !== 'operator_roll' || row.assignedOperatorId === actor.userId),
    );
    return (
      candidates.find((row) => references.has(row.id) || references.has(row.rollCode)) ??
      candidates[0] ??
      null
    );
  }

  private targetId(
    kind: RoleInboxCtaKind,
    recipientRole: Role,
    order: SafeOrder,
    financeOrder: SafeFinanceOrder | null,
    productionOrder: SafeProductionOrder | null,
    warehouseTask: SafeWarehouseTask | null,
    resolutionCase: SafeResolutionCase | null,
    dispatchItem: SafeDispatchItem | null,
  ): string | null {
    switch (kind) {
      case 'commercial_order':
        return order.id;
      case 'finance_order':
        return financeOrder?.id ?? null;
      case 'production_order':
        return productionOrder?.id ?? dispatchItem?.productionOrderId ?? null;
      case 'operator_roll':
        return dispatchItem?.rollCode ?? null;
      case 'warehouse_intake':
        return warehouseTask?.id ?? null;
      case 'warehouse_cover':
        return recipientRole === 'warehouse' ? (resolutionCase?.id ?? null) : order.id;
      case 'director_decision':
        return resolutionCase?.id ?? financeOrder?.id ?? productionOrder?.id ?? order.id;
      case 'penalty':
      case 'production_problem':
      case 'operator_queue':
      case 'admin_incident':
        return null;
    }
  }
}
