import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  type RawTraceabilityContext,
  type RawTraceabilityFact,
} from './director-traceability.projection';
import { DirectorTraceabilityTimelineService } from './director-traceability-timeline.service';

const MAX_CONTEXT_LINKS = 100;
const MAX_FACT_ITEMS = 100;

const PALLET_VOID_REASON_LABELS: Readonly<Record<string, string>> = {
  wrong_composition: 'Неверный состав',
  print_problem: 'Проблема печати',
  other: 'Другая причина',
};

const toIso = (value: Date): string => value.toISOString();

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedStringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 256,
    )
    .slice(0, MAX_CONTEXT_LINKS);
}

function boundedBusinessText(value: unknown, maxLength = 240): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= maxLength ? text : null;
}

function boundedBusinessStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((item) => {
      const text = boundedBusinessText(item, 128);
      return text ? [text] : [];
    })
    .slice(0, MAX_CONTEXT_LINKS);
}

function numberLabel(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

function kgLabel(value: number): string {
  return `${numberLabel(value)} кг`;
}

function palletDateLabel(value: Date): string {
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(value);
}

function movementLocationLabel(value: string | null, direction: 'from' | 'to'): string {
  if (value === 'warehouse') return direction === 'from' ? 'Со склада' : 'На склад';
  if (value === 'production') {
    return direction === 'from' ? 'С производства' : 'На производство';
  }
  return direction === 'from' ? 'Начальная точка' : 'Местоположение зафиксировано';
}

@Injectable()
export class DirectorContainerTraceabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: DirectorTraceabilityTimelineService,
  ) {}

  async getBigBagContext(objectId: string): Promise<RawTraceabilityContext> {
    const bag = await this.prisma.bigBagUnit.findFirst({
      where: { OR: [{ id: objectId }, { code: objectId }] },
      select: {
        id: true,
        code: true,
        material: true,
        batchCode: true,
        status: true,
        registrationStatus: true,
        location: true,
        initialKg: true,
        currentKg: true,
        lastMeasuredKg: true,
        lastMeasuredAt: true,
        lastWarehouseMeasuredKg: true,
        lastWarehouseMeasuredAt: true,
        createdAt: true,
        movements: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            fromLocation: true,
            toLocation: true,
            operatorReportedKg: true,
            warehouseMeasuredKg: true,
            differenceKg: true,
            createdAt: true,
          },
        },
        shiftUsages: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            startKg: true,
            endKg: true,
            createdAt: true,
            closedAt: true,
            session: {
              select: {
                operator: { select: { displayName: true } },
                post: { select: { code: true, name: true } },
                shift: { select: { label: true } },
              },
            },
          },
        },
        printJobs: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!bag) throw this.notFound();

    const timeline = await this.timeline.get([
      bag.id,
      bag.code,
      ...bag.movements.map((movement) => movement.id),
      ...bag.shiftUsages.map((usage) => usage.id),
      ...bag.printJobs.map((job) => job.id),
    ]);
    const printStatus = bag.printJobs[0]?.status;
    const productionFacts: RawTraceabilityFact[] = [
      {
        kind: 'big_bag_material',
        value: bag.material,
        unit: null,
        recordedAt: toIso(bag.createdAt),
        source: 'platform',
      },
      ...(bag.batchCode
        ? [
            {
              kind: 'big_bag_batch',
              value: bag.batchCode,
              unit: null,
              recordedAt: toIso(bag.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(bag.initialKg !== null
        ? [
            {
              kind: 'big_bag_initial_weight',
              value: bag.initialKg,
              unit: 'kg',
              recordedAt: toIso(bag.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(bag.currentKg !== null
        ? [
            {
              kind: 'big_bag_current_weight',
              value: bag.currentKg,
              unit: 'kg',
              recordedAt: toIso(bag.lastMeasuredAt ?? bag.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(bag.lastMeasuredKg !== null && bag.lastMeasuredAt
        ? [
            {
              kind: 'big_bag_last_measurement_weight',
              value: bag.lastMeasuredKg,
              unit: 'kg',
              recordedAt: toIso(bag.lastMeasuredAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...bag.shiftUsages.map((usage) => {
        const session = usage.session;
        const shift = boundedBusinessText(session.shift?.label) ?? 'Смена';
        const operator = boundedBusinessText(session.operator.displayName) ?? 'Оператор';
        const postName = boundedBusinessText(session.post.name);
        const post = [session.post.code, postName].filter(Boolean).join(' — ');
        const weights = `${kgLabel(usage.startKg)} → ${
          usage.endKg === null ? 'используется' : kgLabel(usage.endKg)
        }`;
        return {
          kind: 'big_bag_shift_usage',
          value: [shift, operator, post, weights].filter(Boolean).join(' · '),
          unit: null,
          recordedAt: toIso(usage.closedAt ?? usage.createdAt),
          source: 'platform',
        } satisfies RawTraceabilityFact;
      }),
    ].slice(0, MAX_FACT_ITEMS);

    const warehouseFacts: RawTraceabilityFact[] = [
      ...(bag.lastWarehouseMeasuredKg !== null && bag.lastWarehouseMeasuredAt
        ? [
            {
              kind: 'big_bag_last_warehouse_weight',
              value: bag.lastWarehouseMeasuredKg,
              unit: 'kg',
              recordedAt: toIso(bag.lastWarehouseMeasuredAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...bag.movements.map((movement) => {
        const measurements = [
          movement.warehouseMeasuredKg === null
            ? null
            : `склад ${kgLabel(movement.warehouseMeasuredKg)}`,
          movement.operatorReportedKg === null
            ? null
            : `оператор ${kgLabel(movement.operatorReportedKg)}`,
          movement.differenceKg === null ? null : `расхождение ${kgLabel(movement.differenceKg)}`,
        ].filter((value): value is string => value !== null);
        return {
          kind: 'big_bag_movement',
          value: [
            `${movementLocationLabel(movement.fromLocation, 'from')} → ${movementLocationLabel(
              movement.toLocation,
              'to',
            )}`,
            ...measurements,
          ].join(' · '),
          unit: null,
          recordedAt: toIso(movement.createdAt),
          source: 'platform',
        } satisfies RawTraceabilityFact;
      }),
      ...bag.printJobs.map(
        (job): RawTraceabilityFact => ({
          kind: 'big_bag_print',
          value: job.status,
          unit: null,
          recordedAt: toIso(job.updatedAt),
          source: 'platform',
        }),
      ),
    ].slice(0, MAX_FACT_ITEMS);

    return {
      objectType: 'big_bag',
      objectId: bag.id,
      displayName: `Big-Bag ${bag.code}`,
      statuses: [
        { kind: 'big_bag', value: bag.status },
        { kind: 'registration', value: bag.registrationStatus },
        { kind: 'location', value: bag.location },
        ...(printStatus ? [{ kind: 'label', value: printStatus }] : []),
      ],
      links: [],
      timeline,
      problems: [],
      defects: [],
      productionFacts,
      warehouseFacts,
    };
  }

  async getPalletContext(objectId: string): Promise<RawTraceabilityContext> {
    const pallet = await this.prisma.palletListDocument.findFirst({
      where: {
        OR: [{ id: objectId }, { palletId: objectId }],
      },
      select: {
        id: true,
        palletId: true,
        rollIds: true,
        orderIds: true,
        format: true,
        fieldSetStatus: true,
        payload: true,
        voidedAt: true,
        voidReasonCode: true,
        voidNote: true,
        createdAt: true,
        warehousePallet: {
          select: {
            id: true,
            palletCode: true,
            status: true,
          },
        },
        printJobs: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: MAX_FACT_ITEMS,
          select: {
            id: true,
            status: true,
            createdAt: true,
            completedAt: true,
          },
        },
      },
    });
    if (!pallet) throw this.notFound();

    const rollIds = boundedStringIds(pallet.rollIds);
    const orderIds = boundedStringIds(pallet.orderIds);
    const [orders, warehouseRolls, dispatchRolls, timeline] = await Promise.all([
      orderIds.length > 0
        ? this.prisma.commercialOrder.findMany({
            where: { id: { in: orderIds } },
            orderBy: { id: 'asc' },
            take: MAX_CONTEXT_LINKS,
            select: {
              id: true,
              orderNumber: true,
              counterparty: { select: { displayName: true } },
            },
          })
        : [],
      rollIds.length > 0
        ? this.prisma.warehouseRoll.findMany({
            where: {
              OR: [{ id: { in: rollIds } }, { rollCode: { in: rollIds } }],
            },
            orderBy: { id: 'asc' },
            take: MAX_CONTEXT_LINKS,
            select: { id: true, rollCode: true },
          })
        : [],
      rollIds.length > 0
        ? this.prisma.rollDispatchItem.findMany({
            where: {
              OR: [{ id: { in: rollIds } }, { rollCode: { in: rollIds } }],
            },
            orderBy: { id: 'asc' },
            take: MAX_CONTEXT_LINKS,
            select: { id: true, rollCode: true },
          })
        : [],
      this.timeline.get([
        pallet.id,
        pallet.palletId,
        pallet.warehousePallet?.id ?? null,
        pallet.warehousePallet?.palletCode ?? null,
        ...pallet.printJobs.map((job) => job.id),
      ]),
    ]);

    const payloadLabel = record(record(pallet.payload).label);
    const orderById = new Map(orders.map((order) => [order.id, order]));
    const orderedOrders = orderIds.flatMap((id) => {
      const order = orderById.get(id);
      return order ? [order] : [];
    });
    const rollByIdentity = new Map<string, { id: string; rollCode: string }>();
    for (const roll of [...warehouseRolls, ...dispatchRolls]) {
      rollByIdentity.set(roll.id, roll);
      rollByIdentity.set(roll.rollCode, roll);
    }
    const orderedRolls = rollIds.flatMap((id) => {
      const roll = rollByIdentity.get(id);
      return roll ? [roll] : [];
    });
    const uniqueRolls = [...new Map(orderedRolls.map((roll) => [roll.rollCode, roll])).values()];
    const orderNumbers =
      orderedOrders.length > 0
        ? orderedOrders.map((order) => order.orderNumber)
        : boundedBusinessStrings(payloadLabel.orderNumbers);
    const customers =
      orderedOrders.length > 0
        ? orderedOrders.flatMap((order) => {
            const name = boundedBusinessText(order.counterparty?.displayName, 160);
            return name ? [name] : [];
          })
        : boundedBusinessStrings(payloadLabel.customerAliases);
    const rollCodes =
      uniqueRolls.length > 0
        ? uniqueRolls.map((roll) => roll.rollCode)
        : boundedBusinessStrings(payloadLabel.rollCodes);
    const labelRollCount =
      typeof payloadLabel.rollCount === 'number' && Number.isSafeInteger(payloadLabel.rollCount)
        ? payloadLabel.rollCount
        : null;
    const rollCount = rollCodes.length > 0 ? rollCodes.length : (labelRollCount ?? rollIds.length);
    const latestPrint = pallet.printJobs[0];
    const palletCode = pallet.warehousePallet?.palletCode ?? pallet.palletId;
    const voidReason =
      boundedBusinessText(pallet.voidNote) ??
      (pallet.voidReasonCode
        ? (PALLET_VOID_REASON_LABELS[pallet.voidReasonCode] ?? 'Причина зафиксирована')
        : null);

    const warehouseFacts: RawTraceabilityFact[] = [
      {
        kind: 'pallet_formed_at',
        value: palletDateLabel(pallet.createdAt),
        unit: null,
        recordedAt: toIso(pallet.createdAt),
        source: 'platform',
      },
      {
        kind: 'pallet_roll_count',
        value: rollCount,
        unit: null,
        recordedAt: toIso(pallet.createdAt),
        source: 'platform',
      },
      ...(orderNumbers.length > 0
        ? [
            {
              kind: 'pallet_orders',
              value: orderNumbers.join(', '),
              unit: null,
              recordedAt: toIso(pallet.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(customers.length > 0
        ? [
            {
              kind: 'pallet_customers',
              value: customers.join(', '),
              unit: null,
              recordedAt: toIso(pallet.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(rollCodes.length > 0
        ? [
            {
              kind: 'pallet_rolls',
              value: rollCodes.join(', '),
              unit: null,
              recordedAt: toIso(pallet.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(latestPrint
        ? [
            {
              kind: 'pallet_print',
              value: latestPrint.status,
              unit: null,
              recordedAt: toIso(latestPrint.completedAt ?? latestPrint.createdAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
      ...(voidReason && pallet.voidedAt
        ? [
            {
              kind: 'pallet_void_reason',
              value: voidReason,
              unit: null,
              recordedAt: toIso(pallet.voidedAt),
              source: 'platform',
            } satisfies RawTraceabilityFact,
          ]
        : []),
    ].slice(0, MAX_FACT_ITEMS);

    return {
      objectType: 'pallet',
      objectId: pallet.id,
      displayName: `Палетный лист ${palletCode}`,
      statuses: [
        { kind: 'document', value: pallet.voidedAt ? 'voided' : 'sealed' },
        ...(pallet.warehousePallet
          ? [{ kind: 'pallet', value: pallet.warehousePallet.status }]
          : []),
        { kind: 'document_fields', value: pallet.fieldSetStatus },
        { kind: 'format', value: pallet.format },
        ...(latestPrint ? [{ kind: 'print', value: latestPrint.status }] : []),
      ],
      links: [
        ...orderedOrders.map((order) => ({
          objectType: 'order' as const,
          objectId: order.id,
          displayName: [
            `Заказ ${order.orderNumber}`,
            boundedBusinessText(order.counterparty?.displayName, 160),
          ]
            .filter(Boolean)
            .join(' · '),
          relation: 'contains',
        })),
        ...uniqueRolls.map((roll) => ({
          objectType: 'roll' as const,
          objectId: roll.id,
          displayName: `Рулон ${roll.rollCode}`,
          relation: 'contains',
        })),
      ].slice(0, MAX_CONTEXT_LINKS),
      timeline,
      problems: [],
      defects: [],
      productionFacts: [],
      warehouseFacts,
    };
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: 'TRACEABILITY_NOT_FOUND',
      message: 'Traceability object was not found.',
    });
  }
}
