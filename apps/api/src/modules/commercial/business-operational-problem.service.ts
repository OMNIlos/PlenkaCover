import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BusinessOperationalProblem, BusinessOperationalProblemPage } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isDeviceBackedWeightEvidence } from '../../common/weight-capture/device-backed-evidence';

type ProblemFilter = 'open' | 'resolved' | 'all';
type ProblemKind = BusinessOperationalProblem['kind'];
type ProblemCursor = {
  createdAt: string;
  kind: ProblemKind;
  id: string;
};

type OverweightReference = {
  warehouseOperationId: string;
  rollCode: string;
};

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 1000;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROBLEM_FILTERS = new Set<ProblemFilter>(['open', 'resolved', 'all']);
const PROBLEM_KINDS = new Set<ProblemKind>([
  'weight_deviation',
  'general',
  'raw_material_shortage',
  'defect',
  'machine_breakdown',
]);
const PRODUCTION_PROBLEM_KINDS = [
  'general',
  'raw_material_shortage',
  'defect',
  'machine_breakdown',
] as const;
const PRODUCTION_PROBLEM_KIND_SET = new Set<string>(PRODUCTION_PROBLEM_KINDS);
const PRODUCTION_PROBLEM_LABELS: Record<(typeof PRODUCTION_PROBLEM_KINDS)[number], string> = {
  general: 'Общая проблема',
  raw_material_shortage: 'Нехватка сырья',
  defect: 'Брак рулона',
  machine_breakdown: 'Поломка станка',
};
const OVERWEIGHT_EVENT_TYPE = 'audit:warehouse_roll_reserved_overweight';

const PRODUCTION_PROBLEM_SELECT = {
  id: true,
  orderId: true,
  type: true,
  status: true,
  reason: true,
  createdAt: true,
  rollId: true,
  order: { select: { orderNumber: true } },
  post: { select: { name: true, code: true } },
  defectRecord: {
    select: {
      line: {
        select: {
          rollDispatchItem: {
            select: {
              post: { select: { name: true, code: true } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductionProblemSelect;

const OVERWEIGHT_EVENT_SELECT = {
  id: true,
  objectId: true,
  detail: true,
  createdAt: true,
} satisfies Prisma.DomainEventSelect;

const BUSINESS_WEIGHT_SELECT = {
  id: true,
  warehouseOperationId: true,
  kind: true,
  deviceId: true,
  deviceStatus: true,
  stable: true,
  toleranceOk: true,
  grossKg: true,
  spoolKg: true,
  netKg: true,
  postId: true,
  postSessionId: true,
  operationId: true,
  operation: {
    select: {
      id: true,
      action: true,
      status: true,
      deviceId: true,
      postId: true,
      postSessionId: true,
      resultRef: true,
    },
  },
  warehouseOperation: {
    select: {
      id: true,
      kind: true,
      status: true,
      taskId: true,
      rollCode: true,
      deviceId: true,
      postId: true,
      safeResult: true,
    },
  },
  line: {
    select: {
      planKg: true,
      rollDispatchItem: {
        select: {
          rollCode: true,
          productionOrder: {
            select: {
              commercialOrder: { select: { id: true, orderNumber: true } },
            },
          },
          post: { select: { name: true, code: true } },
        },
      },
    },
  },
} satisfies Prisma.WeightCaptureSelect;

type ProductionProblemRow = Prisma.ProductionProblemGetPayload<{
  select: typeof PRODUCTION_PROBLEM_SELECT;
}>;
type OverweightEventRow = Prisma.DomainEventGetPayload<{
  select: typeof OVERWEIGHT_EVENT_SELECT;
}>;
type BusinessWeightRow = Prisma.WeightCaptureGetPayload<{
  select: typeof BUSINESS_WEIGHT_SELECT;
}>;

function normalizedText(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function normalizedPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function formatKg(value: number): string {
  return Number(value.toFixed(3)).toString().replace('.', ',');
}

function displayPost(post: { name: string; code: string } | null): string | null {
  return normalizedText(post?.name) ?? normalizedText(post?.code);
}

function problemFilter(value?: ProblemFilter): ProblemFilter {
  const resolved = value ?? 'open';
  if (!PROBLEM_FILTERS.has(resolved)) {
    throw new BadRequestException('Invalid business operational problem filter.');
  }
  return resolved;
}

function pageLimit(value?: number): number {
  const resolved = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_PAGE_LIMIT) {
    throw new BadRequestException('Invalid business operational problem page limit.');
  }
  return resolved;
}

function decodeCursor(value?: string): ProblemCursor | null {
  if (value === undefined) return null;
  try {
    if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(value)) {
      throw new Error('invalid cursor encoding');
    }
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('noncanonical cursor');

    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('invalid cursor payload');
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 3 ||
      typeof candidate.createdAt !== 'string' ||
      !ISO_DATE_TIME_PATTERN.test(candidate.createdAt) ||
      typeof candidate.kind !== 'string' ||
      !PROBLEM_KINDS.has(candidate.kind as ProblemKind) ||
      typeof candidate.id !== 'string' ||
      candidate.id.length === 0 ||
      candidate.id.length > 191 ||
      candidate.id.trim() !== candidate.id
    ) {
      throw new Error('invalid cursor fields');
    }
    const createdAt = new Date(candidate.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== candidate.createdAt) {
      throw new Error('invalid cursor date');
    }
    return {
      createdAt: candidate.createdAt,
      kind: candidate.kind as ProblemKind,
      id: candidate.id,
    };
  } catch {
    throw new BadRequestException('Invalid business operational problem cursor.');
  }
}

function encodeCursor(item: BusinessOperationalProblem): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: item.createdAt,
      kind: item.kind,
      id: item.id,
    } satisfies ProblemCursor),
    'utf8',
  ).toString('base64url');
}

function productionCursorWhere(
  cursor: ProblemCursor | null,
): Pick<Prisma.ProductionProblemWhereInput, 'OR'> | object {
  if (!cursor) return {};
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { createdAt, type: { lt: cursor.kind } },
      { createdAt, type: cursor.kind, id: { lt: cursor.id } },
    ],
  };
}

function eventCursorWhere(
  cursor: ProblemCursor | null,
): Pick<Prisma.DomainEventWhereInput, 'OR'> | object {
  if (!cursor) return {};
  const createdAt = new Date(cursor.createdAt);
  if ('weight_deviation' > cursor.kind) {
    return { OR: [{ createdAt: { lt: createdAt } }] };
  }
  if ('weight_deviation' < cursor.kind) {
    return { OR: [{ createdAt: { lt: createdAt } }, { createdAt }] };
  }
  return {
    OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursor.id } }],
  };
}

function overweightReference(detail: Prisma.JsonValue | null): OverweightReference | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const warehouseOperationId = normalizedText(detail.warehouseOperationId, 191);
  const rollCode = normalizedText(detail.rollCode, 191);
  return warehouseOperationId && rollCode ? { warehouseOperationId, rollCode } : null;
}

function isValidatedBusinessWeight(
  event: OverweightEventRow,
  reference: OverweightReference,
  capture: BusinessWeightRow | undefined,
): capture is BusinessWeightRow {
  const eventRollCode = normalizedText(event.objectId, 191);
  const dispatch = capture?.line.rollDispatchItem;
  return (
    eventRollCode === reference.rollCode &&
    capture?.warehouseOperationId === reference.warehouseOperationId &&
    capture.kind === 'control' &&
    capture.toleranceOk === false &&
    isDeviceBackedWeightEvidence(capture, {
      source: 'warehouse',
      expectedRollCode: reference.rollCode,
    }) &&
    dispatch?.rollCode === reference.rollCode &&
    normalizedPositiveNumber(capture.line.planKg) !== null
  );
}

function projectProductionProblem(row: ProductionProblemRow): BusinessOperationalProblem {
  const kind = row.type as (typeof PRODUCTION_PROBLEM_KINDS)[number];
  const defectPost = row.defectRecord?.line.rollDispatchItem.post ?? null;
  return {
    id: row.id,
    orderId: normalizedText(row.orderId, 191),
    kind,
    status: row.status === 'resolved' ? 'resolved' : 'open',
    label: PRODUCTION_PROBLEM_LABELS[kind],
    createdAt: row.createdAt.toISOString(),
    orderNumber: normalizedText(row.order?.orderNumber),
    rollCode: normalizedText(row.rollId, 191),
    machineName: displayPost(row.post) ?? displayPost(defectPost),
    reason: normalizedText(row.reason, 1000),
  };
}

function projectOverweightEvent(
  event: OverweightEventRow,
  captures: ReadonlyMap<string, BusinessWeightRow>,
): BusinessOperationalProblem {
  const reference = overweightReference(event.detail);
  const capture = reference ? captures.get(reference.warehouseOperationId) : undefined;
  const validated =
    reference && isValidatedBusinessWeight(event, reference, capture) ? capture : null;
  const netKg = validated ? normalizedPositiveNumber(validated.netKg) : null;
  const planKg = validated ? normalizedPositiveNumber(validated.line.planKg) : null;
  const dispatch = validated?.line.rollDispatchItem;
  const label =
    netKg !== null && planKg !== null
      ? `Перевес рулона: ${formatKg(netKg)} кг при плане ${formatKg(planKg)} кг`
      : 'Перевес рулона';

  return {
    id: event.id,
    orderId: normalizedText(dispatch?.productionOrder.commercialOrder.id, 191),
    kind: 'weight_deviation',
    status: 'resolved',
    label,
    createdAt: event.createdAt.toISOString(),
    orderNumber: normalizedText(dispatch?.productionOrder.commercialOrder.orderNumber),
    rollCode:
      normalizedText(dispatch?.rollCode, 191) ??
      normalizedText(event.objectId, 191) ??
      reference?.rollCode ??
      null,
    machineName: displayPost(dispatch?.post ?? null),
    reason: 'Контрольный вес превысил допустимое отклонение.',
  };
}

function compareProblems(
  left: BusinessOperationalProblem,
  right: BusinessOperationalProblem,
): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.kind.localeCompare(left.kind) ||
    right.id.localeCompare(left.id)
  );
}

@Injectable()
export class BusinessOperationalProblemService {
  constructor(private readonly prisma: PrismaService) {}

  async getProblem(problemId: string): Promise<BusinessOperationalProblem> {
    const row = await this.prisma.productionProblem.findUnique({
      where: { id: problemId },
      select: PRODUCTION_PROBLEM_SELECT,
    });
    if (!row || !PRODUCTION_PROBLEM_KIND_SET.has(row.type)) {
      throw new NotFoundException(`Production problem ${problemId} not found`);
    }
    return projectProductionProblem(row);
  }

  async listProblems(query: {
    filter?: ProblemFilter;
    cursor?: string;
    limit?: number;
  }): Promise<BusinessOperationalProblemPage> {
    const filter = problemFilter(query.filter);
    const cursor = decodeCursor(query.cursor);
    const limit = pageLimit(query.limit);
    const statusWhere =
      filter === 'open'
        ? { status: { not: 'resolved' } }
        : filter === 'resolved'
          ? { status: 'resolved' }
          : {};

    const [productionRows, overweightEvents] = await Promise.all([
      this.prisma.productionProblem.findMany({
        where: {
          type: { in: [...PRODUCTION_PROBLEM_KINDS] },
          ...statusWhere,
          ...productionCursorWhere(cursor),
        },
        select: PRODUCTION_PROBLEM_SELECT,
        orderBy: [{ createdAt: 'desc' }, { type: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      }),
      filter === 'open'
        ? Promise.resolve([])
        : this.prisma.domainEvent.findMany({
            where: {
              type: OVERWEIGHT_EVENT_TYPE,
              ...eventCursorWhere(cursor),
            },
            select: OVERWEIGHT_EVENT_SELECT,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
          }),
    ]);

    const references = overweightEvents
      .map((event) => overweightReference(event.detail))
      .filter((reference): reference is OverweightReference => reference !== null);
    const operationIds = [
      ...new Set(references.map(({ warehouseOperationId }) => warehouseOperationId)),
    ];
    const weightRows =
      operationIds.length === 0
        ? []
        : await this.prisma.weightCapture.findMany({
            where: {
              warehouseOperationId: { in: operationIds },
              kind: 'control',
              deviceId: { not: null },
              deviceStatus: 'ready',
              stable: true,
              toleranceOk: false,
              grossKg: { gt: 0 },
              spoolKg: { gte: 0 },
              netKg: { not: null },
              warehouseOperation: {
                kind: 'control_weight',
                status: 'succeeded',
              },
            },
            select: BUSINESS_WEIGHT_SELECT,
            take: limit + 1,
          });
    const captures = new Map(
      weightRows.flatMap((capture) =>
        capture.warehouseOperationId ? [[capture.warehouseOperationId, capture] as const] : [],
      ),
    );
    const merged = [
      ...productionRows.map(projectProductionProblem),
      ...overweightEvents.map((event) => projectOverweightEvent(event, captures)),
    ].sort(compareProblems);
    const hasNextPage = merged.length > limit;
    const selected = merged.slice(0, limit);
    const last = selected.at(-1);

    return {
      items: selected,
      nextCursor: hasNextPage && last ? encodeCursor(last) : null,
    };
  }
}
