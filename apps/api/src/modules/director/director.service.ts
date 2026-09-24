import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEFECT_BAG_STATUSES,
  DEFECT_BAG_TYPES,
  PAYMENT_UPDATE_STATUSES,
  PRODUCTION_INDICATORS,
  type DefectBagStatus,
  type DefectBagType,
  type Role,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import type { FinanceOverrideDto, OverrideDto, ProductionOverrideDto } from './dto/override.dto';
import { DIRECTOR_PENALTY_TARGET_ROLES, type CreatePenaltyDto } from './dto/penalty.dto';
import type { ResolveDecisionDto } from './dto/decision.dto';
import {
  DIRECTOR_DECISION_SCOPES,
  DIRECTOR_DECISION_STATUSES,
  type DirectorDecisionQueryDto,
} from './dto/director-decision-query.dto';

export interface DirectorActor {
  userId: string | null;
  role: Role;
}

const MAX_DIRECTOR_LIST_ROWS = 200;
const MAX_DIRECTOR_FINANCE_SCHEDULES = 50;
const MAX_DIRECTOR_PRODUCTION_ROLLS = 2_000;
const MAX_DIRECTOR_DEFECT_BAGS = 100;

const DIRECTOR_DEFECT_BAG_SELECT = {
  id: true,
  code: true,
  status: true,
  defectType: true,
  weightKg: true,
  recordedDefectKg: true,
  differenceKg: true,
  weighedAt: true,
  postSession: {
    select: {
      operator: { select: { displayName: true } },
      post: { select: { code: true, name: true } },
      shift: { select: { label: true } },
    },
  },
  movements: {
    select: {
      kind: true,
      createdAt: true,
      actor: { select: { displayName: true } },
    },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
} as const satisfies Prisma.DefectBagSelect;

const DIRECTOR_COUNTERPARTY_SELECT = {
  displayName: true,
  legalName: true,
} as const satisfies Prisma.CounterpartySelect;

const DIRECTOR_FINANCE_SELECT = {
  id: true,
  invoiceStatus: true,
  paymentStatus: true,
  amountValue: true,
  amountLabel: true,
  commercialOrder: {
    select: {
      orderNumber: true,
      counterparty: { select: DIRECTOR_COUNTERPARTY_SELECT },
    },
  },
} as const satisfies Prisma.FinanceOrderSelect;

const DIRECTOR_FINANCE_DETAIL_SELECT = {
  ...DIRECTOR_FINANCE_SELECT,
  schedules: {
    select: { kind: true, status: true, dueDate: true, amount: true },
    orderBy: [{ dueDate: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }],
    take: MAX_DIRECTOR_FINANCE_SCHEDULES + 1,
  },
} as const satisfies Prisma.FinanceOrderSelect;

const DIRECTOR_PRODUCTION_SELECT = {
  id: true,
  indicator: true,
  approvalState: true,
  commercialOrder: {
    select: {
      orderNumber: true,
      counterparty: { select: DIRECTOR_COUNTERPARTY_SELECT },
    },
  },
  dispatchItems: {
    select: { id: true, rollCode: true, status: true },
    orderBy: [{ queueRank: 'asc' as const }, { createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
} as const satisfies Prisma.ProductionOrderSelect;

const DIRECTOR_PRODUCTION_LIST_SELECT = {
  id: true,
  indicator: true,
  approvalState: true,
  commercialOrder: {
    select: {
      orderNumber: true,
      counterparty: { select: DIRECTOR_COUNTERPARTY_SELECT },
    },
  },
  _count: { select: { dispatchItems: true } },
} as const satisfies Prisma.ProductionOrderSelect;

function directorProjectionTooLarge(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'DIRECTOR_PROJECTION_TOO_LARGE',
    message: 'Слишком много данных для безопасной директорской выдачи.',
  });
}

@Injectable()
export class DirectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getControl() {
    const [
      pendingDecisions,
      penaltyAgg,
      overdueOrders,
      scheduleAll,
      schedulePaid,
      scheduleOverdue,
      producedAgg,
      defectAgg,
      warehouseAcceptedRolls,
      defectBagGroups,
      defectBagRows,
    ] = await Promise.all([
      this.prisma.directorDecision.count({ where: { status: 'pending' } }),
      this.prisma.penalty.aggregate({ _count: { _all: true }, _sum: { amount: true } }),
      this.prisma.financeOrder.count({ where: { paymentStatus: 'overdue' } }),
      this.prisma.paymentSchedule.aggregate({ _sum: { amount: true } }),
      this.prisma.paymentSchedule.aggregate({
        where: { status: 'paid' },
        _sum: { amount: true },
      }),
      this.prisma.paymentSchedule.aggregate({
        where: { status: 'overdue' },
        _sum: { amount: true },
      }),
      this.prisma.operatorRollLine.aggregate({ _sum: { netKg: true } }),
      this.prisma.defectRecord.aggregate({ _sum: { weightKg: true } }),
      this.prisma.rollDispatchItem.count({ where: { status: 'done' } }),
      this.prisma.defectBag.groupBy({
        by: ['status', 'defectType'],
        where: { weightKg: { gt: 0 } },
        _count: { _all: true },
        _sum: { weightKg: true },
      }),
      this.prisma.defectBag.findMany({
        where: { weightKg: { gt: 0 } },
        select: DIRECTOR_DEFECT_BAG_SELECT,
        orderBy: [{ weighedAt: 'desc' }, { id: 'desc' }],
        take: MAX_DIRECTOR_DEFECT_BAGS + 1,
      }),
    ]);
    const plannedAmount = Number(scheduleAll._sum.amount ?? 0);
    const paidAmount = Number(schedulePaid._sum.amount ?? 0);
    const defectBagByStatus = DEFECT_BAG_STATUSES.map((status) => {
      const groups = defectBagGroups.filter((row) => row.status === status);
      return {
        status,
        count: groups.reduce((total, row) => total + row._count._all, 0),
        weightKg: Number(
          groups.reduce((total, row) => total + (row._sum.weightKg ?? 0), 0).toFixed(3),
        ),
      };
    });
    const defectBagByType = DEFECT_BAG_TYPES.map((defectType) => {
      const groups = defectBagGroups.filter((row) => row.defectType === defectType);
      return {
        defectType,
        count: groups.reduce((total, row) => total + row._count._all, 0),
        weightKg: Number(
          groups.reduce((total, row) => total + (row._sum.weightKg ?? 0), 0).toFixed(3),
        ),
      };
    });
    const unclassifiedGroups = defectBagGroups.filter((row) => row.defectType === null);
    return {
      // Ключевые счётчики (обратная совместимость).
      pendingDecisions,
      penalties: penaltyAgg._count._all,
      overdueOrders,
      // Финансовая сводка дашборда «Контроль».
      penaltiesAmount: penaltyAgg._sum.amount ?? 0,
      plannedInvoicedAmount: plannedAmount,
      paidAmount,
      unbilledAmount: Number((plannedAmount - paidAmount).toFixed(2)),
      overdueAmount: Number(scheduleOverdue._sum.amount ?? 0),
      // Производственная сводка.
      producedKg: Number((producedAgg._sum.netKg ?? 0).toFixed(1)),
      defectKg: Number((defectAgg._sum.weightKg ?? 0).toFixed(1)),
      warehouseAcceptedRolls,
      defectBags: {
        totalCount: defectBagByStatus.reduce((total, row) => total + row.count, 0),
        totalWeightKg: Number(
          defectBagByStatus.reduce((total, row) => total + row.weightKg, 0).toFixed(3),
        ),
        byStatus: defectBagByStatus,
        byType: defectBagByType,
        unclassified: {
          count: unclassifiedGroups.reduce((total, row) => total + row._count._all, 0),
          weightKg: Number(
            unclassifiedGroups
              .reduce((total, row) => total + (row._sum.weightKg ?? 0), 0)
              .toFixed(3),
          ),
        },
        recent: defectBagRows.slice(0, MAX_DIRECTOR_DEFECT_BAGS).map((bag) => {
          const receipt = bag.movements.find(({ kind }) => kind === 'receive');
          const shipment = bag.movements.find(({ kind }) => kind === 'ship');
          return {
            id: bag.id,
            code: bag.code,
            status: bag.status as DefectBagStatus,
            defectType: bag.defectType as DefectBagType | null,
            weightKg: bag.weightKg,
            recordedDefectKg: bag.recordedDefectKg,
            differenceKg: bag.differenceKg,
            operatorName: bag.postSession.operator.displayName,
            postCode: bag.postSession.post.code,
            postName: bag.postSession.post.name,
            shiftLabel: bag.postSession.shift?.label ?? null,
            weighedAt: bag.weighedAt.toISOString(),
            receivedAt: receipt?.createdAt.toISOString() ?? null,
            receivedBy: receipt?.actor.displayName ?? null,
            shippedAt: shipment?.createdAt.toISOString() ?? null,
            shippedBy: shipment?.actor.displayName ?? null,
          };
        }),
        hasMore: defectBagRows.length > MAX_DIRECTOR_DEFECT_BAGS,
      },
    };
  }

  async listDecisions(query: DirectorDecisionQueryDto = {}) {
    if (query.scope && !DIRECTOR_DECISION_SCOPES.includes(query.scope)) {
      throw new BadRequestException('Unsupported director decision scope.');
    }
    if (query.status && !DIRECTOR_DECISION_STATUSES.includes(query.status)) {
      throw new BadRequestException('Unsupported director decision status.');
    }
    const decisions = await this.prisma.directorDecision.findMany({
      where: {
        ...(query.scope ? { scope: query.scope } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_DIRECTOR_LIST_ROWS + 1,
    });
    if (decisions.length > MAX_DIRECTOR_LIST_ROWS) throw directorProjectionTooLarge();
    return decisions;
  }

  approveDecision(actor: DirectorActor, decisionId: string) {
    return this.resolveDecision(actor, decisionId, 'approved');
  }

  returnDecision(actor: DirectorActor, decisionId: string, dto: ResolveDecisionDto) {
    return this.resolveDecision(actor, decisionId, 'returned', dto.note);
  }

  private async resolveDecision(
    actor: DirectorActor,
    decisionId: string,
    status: 'approved' | 'returned',
    note?: string,
  ) {
    return this.serializable(async (tx) => {
      const decision = await tx.directorDecision.findUnique({ where: { id: decisionId } });
      if (!decision) throw new NotFoundException(`Decision ${decisionId} not found`);
      if (decision.status !== 'pending') {
        throw new ConflictException({
          code: 'DIRECTOR_DECISION_ALREADY_RESOLVED',
          message: 'Decision is no longer pending.',
        });
      }
      const claimed = await tx.directorDecision.updateMany({
        where: { id: decisionId, status: 'pending' },
        data: { status },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({
          code: 'DIRECTOR_DECISION_ALREADY_RESOLVED',
          message: 'Decision is no longer pending.',
        });
      }
      await this.audit.record(
        {
          type: 'audit:director_decision_resolved',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: decisionId,
          reason: note,
          oldValue: { status: decision.status },
          newValue: { status },
        },
        tx,
      );
      return tx.directorDecision.findUniqueOrThrow({ where: { id: decisionId } });
    });
  }

  // --- Drilldowns -----------------------------------------------------------

  async getFinance(_actorRole: Role, objectId: string) {
    const fo = await this.prisma.financeOrder.findUnique({
      where: { id: objectId },
      select: DIRECTOR_FINANCE_DETAIL_SELECT,
    });
    if (!fo) throw new NotFoundException(`Finance order ${objectId} not found`);
    if (fo.schedules.length > MAX_DIRECTOR_FINANCE_SCHEDULES) {
      throw directorProjectionTooLarge();
    }
    return fo;
  }

  async getProduction(objectId: string) {
    const order = await this.prisma.$transaction(
      async (tx) => {
        const rollCount = await tx.rollDispatchItem.count({
          where: { productionOrderId: objectId },
        });
        if (rollCount > MAX_DIRECTOR_PRODUCTION_ROLLS) throw directorProjectionTooLarge();
        return tx.productionOrder.findUnique({
          where: { id: objectId },
          select: DIRECTOR_PRODUCTION_SELECT,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    if (!order) throw new NotFoundException(`Production order ${objectId} not found`);
    return order;
  }

  // --- List projections (director:read; надзор над всеми контурами) ----------

  /** Все финзаказы с контрагентом (проекция по роли) — для директорской секции «Финансы». */
  async listFinance(_actorRole: Role) {
    const orders = await this.prisma.financeOrder.findMany({
      select: DIRECTOR_FINANCE_SELECT,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: MAX_DIRECTOR_LIST_ROWS + 1,
    });
    if (orders.length > MAX_DIRECTOR_LIST_ROWS) throw directorProjectionTooLarge();
    return orders;
  }

  /** Все заказ-наряды с контрагентом и количеством рулонов — директорская секция «Производство». */
  async listProduction(_actorRole: Role) {
    const orders = await this.prisma.productionOrder.findMany({
      select: DIRECTOR_PRODUCTION_LIST_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_DIRECTOR_LIST_ROWS + 1,
    });
    if (orders.length > MAX_DIRECTOR_LIST_ROWS) throw directorProjectionTooLarge();
    return orders.map(({ _count, ...order }) => ({
      ...order,
      rollCount: _count.dispatchItems,
    }));
  }

  /** Складские/производственные исключения (брак, поломки, баланс, нехватка сырья) —
   *  для директорской секции «Склад». Раскрытые проблемы контура с контекстом. */
  async listWarehouse() {
    const problems = await this.prisma.productionProblem.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_DIRECTOR_LIST_ROWS + 1,
      select: {
        id: true,
        type: true,
        status: true,
        orderId: true,
        rollId: true,
        postId: true,
        actorRole: true,
        reason: true,
        recovery: true,
        createdAt: true,
        resolvedAt: true,
        order: { select: { id: true, orderNumber: true } },
        post: { select: { id: true, code: true, name: true, status: true } },
      },
    });
    if (problems.length > MAX_DIRECTOR_LIST_ROWS) throw directorProjectionTooLarge();
    return problems;
  }

  // --- Overrides (reason + evidence required; double-audited for finance) ----

  async overrideFinance(actor: DirectorActor, objectId: string, dto: FinanceOverrideDto) {
    const context = this.requireOverrideContext(dto);
    if (dto.value && !PAYMENT_UPDATE_STATUSES.includes(dto.value)) {
      throw new BadRequestException('Unsupported payment status override.');
    }
    return this.serializable(async (tx) => {
      const order = await tx.financeOrder.findUnique({ where: { id: objectId } });
      if (!order) throw new NotFoundException(`Finance order ${objectId} not found`);
      await this.audit.record(
        {
          type: 'audit:director_finance_override_requested',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId,
          reason: context.reason,
          detail: { evidence: context.evidence },
        },
        tx,
      );
      if (dto.value) {
        await tx.financeOrder.update({
          where: { id: objectId },
          data: { paymentStatus: dto.value },
        });
        await tx.commercialOrder.update({
          where: { id: order.commercialOrderId },
          data: { paymentStatus: dto.value },
        });
      }
      await this.audit.record(
        {
          type: 'audit:director_finance_override_applied',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId,
          reason: context.reason,
          oldValue: { paymentStatus: order.paymentStatus },
          newValue: { paymentStatus: dto.value ?? order.paymentStatus },
          detail: { evidence: context.evidence },
        },
        tx,
      );
      return { applied: true, objectId };
    });
  }

  async overrideProduction(actor: DirectorActor, objectId: string, dto: ProductionOverrideDto) {
    const context = this.requireOverrideContext(dto);
    if (dto.value && !PRODUCTION_INDICATORS.includes(dto.value)) {
      throw new BadRequestException('Unsupported production indicator override.');
    }
    return this.serializable(async (tx) => {
      const order = await tx.productionOrder.findUnique({ where: { id: objectId } });
      if (!order) throw new NotFoundException(`Production order ${objectId} not found`);
      if (dto.value) {
        await tx.productionOrder.update({
          where: { id: objectId },
          data: { indicator: dto.value },
        });
      }
      await this.audit.record(
        {
          type: 'audit:director_production_override_applied',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId,
          reason: context.reason,
          oldValue: { indicator: order.indicator },
          newValue: { indicator: dto.value ?? order.indicator },
          detail: { evidence: context.evidence },
        },
        tx,
      );
      return { applied: true, objectId };
    });
  }

  async overrideWarehouse(actor: DirectorActor, objectId: string, dto: OverrideDto) {
    const context = this.requireOverrideContext(dto);
    await this.audit.record({
      type: 'audit:director_warehouse_override_applied',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId,
      reason: context.reason,
      detail: { evidence: context.evidence, value: dto.value ?? null },
    });
    return { applied: true, objectId };
  }

  // --- Penalties (event-backed analytics) -----------------------------------

  listPenalties() {
    return this.prisma.penalty.findMany({
      include: { employee: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  listPenaltyTargets() {
    return this.prisma.user.findMany({
      where: { role: { in: ['operator', 'production_lead'] }, isActive: true },
      select: { id: true, displayName: true, role: true, isActive: true },
      orderBy: [{ role: 'asc' }, { displayName: 'asc' }],
    });
  }

  async penaltiesSummary() {
    const penalties = await this.prisma.penalty.findMany();
    const byRole = new Map<string, { targetRole: string; count: number; totalAmount: number }>();
    for (const p of penalties) {
      const row = byRole.get(p.targetRole) ?? {
        targetRole: p.targetRole,
        count: 0,
        totalAmount: 0,
      };
      row.count += 1;
      row.totalAmount += p.amount;
      byRole.set(p.targetRole, row);
    }
    return { total: penalties.length, byRole: [...byRole.values()] };
  }

  penaltiesForOperator(operatorId: string) {
    return this.prisma.penalty.findMany({
      where: { employeeId: operatorId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createPenalty(actor: DirectorActor, dto: CreatePenaltyDto) {
    const reason = dto.reason?.trim() ?? '';
    const employeeId = dto.employeeId?.trim() ?? '';
    if (!reason || !employeeId || !Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Penalty employee, positive amount, and reason are required');
    }
    if (!DIRECTOR_PENALTY_TARGET_ROLES.some((targetRole) => targetRole === dto.targetRole)) {
      throw new NotFoundException('Penalty target must be an operator or production lead');
    }
    const employee = await this.prisma.user.findUnique({
      where: { id: employeeId },
      select: { displayName: true, role: true, isActive: true },
    });
    if (!employee || employee.role !== dto.targetRole || !employee.isActive) {
      throw new NotFoundException('Penalty target employee does not match the selected role');
    }
    if (actor.role === 'production_lead') {
      if (
        dto.targetRole !== 'operator' ||
        !employee ||
        employee.role !== 'operator' ||
        !employee.isActive
      ) {
        throw new NotFoundException('Production may issue penalties only to an active operator');
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const penalty = await tx.penalty.create({
        data: {
          targetRole: dto.targetRole,
          amount: dto.amount,
          reason,
          employeeId,
          sourceObjectId: dto.sourceObjectId,
          authorRole: actor.role,
        },
      });
      await this.audit.record(
        {
          type: 'audit:penalty_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: penalty.id,
          reason,
          detail: {
            targetRole: dto.targetRole,
            amount: dto.amount,
            employeeId,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'notification:penalty_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: penalty.id,
          label: `Штраф назначен: ${employee.displayName}`,
          detail: {
            targetRole: dto.targetRole,
            employeeId,
            employeeName: employee.displayName,
            amount: dto.amount,
            reason,
            sourceObjectId: dto.sourceObjectId ?? null,
          },
        },
        tx,
      );
      return penalty;
    });
  }

  getAudit(objectId: string) {
    return this.audit.forObject(objectId, 'director');
  }

  private requireOverrideContext(dto: OverrideDto): { reason: string; evidence: string } {
    const reason = dto.reason?.trim();
    const evidence = dto.evidence?.trim();
    if (!reason || reason.length < 3 || reason.length > 500) {
      throw new BadRequestException('A bounded override reason is required.');
    }
    if (!evidence || evidence.length < 3 || evidence.length > 500) {
      throw new BadRequestException('Bounded override evidence is required.');
    }
    return { reason, evidence };
  }

  private async serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException({
          code: 'DIRECTOR_MUTATION_CONFLICT',
          message: 'The object changed concurrently. Refresh and retry.',
        });
      }
      throw error;
    }
  }
}
