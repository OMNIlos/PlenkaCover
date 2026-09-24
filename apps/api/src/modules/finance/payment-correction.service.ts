import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PAYMENT_UPDATE_STATUSES, type PaymentUpdateStatus, type Role } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  PaymentCorrectionDto,
  PaymentCorrectionTargetKind,
} from './dto/payment-correction.dto';
import { lockFinanceOrderAggregate } from './finance-aggregate-lock';
import {
  FinancePaymentStateService,
  type RecomputedPaymentState,
} from './finance-payment-state.service';

type PaymentCorrectionActor = { userId: string | null; role: Role };

export type PaymentCorrectionResult = {
  commandId: string;
  targetKind: PaymentCorrectionTargetKind;
  targetId: string;
  reversalOperationId: string | null;
  paymentStatus: PaymentUpdateStatus;
  productionClearedAt: string | null;
};

type ScheduleTransition = {
  scheduleId: string;
  previousStatus: string;
  requestedStatus: string;
};

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function asPaymentStatus(value: string | null): PaymentUpdateStatus | null {
  return value && PAYMENT_UPDATE_STATUSES.includes(value as PaymentUpdateStatus)
    ? (value as PaymentUpdateStatus)
    : null;
}

function scheduleTransitions(value: Prisma.JsonValue | null): ScheduleTransition[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>).scheduleTransitions;
  if (!Array.isArray(candidate)) return [];
  return candidate.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    return typeof row.scheduleId === 'string' &&
      typeof row.previousStatus === 'string' &&
      typeof row.requestedStatus === 'string'
      ? [
          {
            scheduleId: row.scheduleId,
            previousStatus: row.previousStatus,
            requestedStatus: row.requestedStatus,
          },
        ]
      : [];
  });
}

function resultFromJson(value: Prisma.JsonValue | null): PaymentCorrectionResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const paymentStatus = asPaymentStatus(
    typeof candidate.paymentStatus === 'string' ? candidate.paymentStatus : null,
  );
  if (
    typeof candidate.commandId !== 'string' ||
    !['payment_update', 'schedule_confirmation', 'payment_operation'].includes(
      String(candidate.targetKind),
    ) ||
    typeof candidate.targetId !== 'string' ||
    (candidate.reversalOperationId !== null && typeof candidate.reversalOperationId !== 'string') ||
    !paymentStatus ||
    (candidate.productionClearedAt !== null && typeof candidate.productionClearedAt !== 'string')
  ) {
    throw conflict(
      'PAYMENT_CORRECTION_REPLAY_INVALID',
      'Сохранённый результат корректировки повреждён.',
    );
  }
  return {
    commandId: candidate.commandId,
    targetKind: candidate.targetKind as PaymentCorrectionTargetKind,
    targetId: candidate.targetId,
    reversalOperationId: candidate.reversalOperationId as string | null,
    paymentStatus,
    productionClearedAt: candidate.productionClearedAt as string | null,
  };
}

export function paymentCorrectionFingerprintInput(
  financeOrderId: string,
  dto: PaymentCorrectionDto,
) {
  return {
    financeOrderId,
    operationKey: dto.operationKey.trim().toLowerCase(),
    target: {
      kind: dto.target.kind,
      id: dto.target.id.trim(),
    },
    expectedPaymentStatus: dto.expectedPaymentStatus,
    reason: dto.reason.trim(),
  };
}

@Injectable()
export class PaymentCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly paymentState: FinancePaymentStateService,
  ) {}

  correct(
    actor: PaymentCorrectionActor,
    financeOrderId: string,
    dto: PaymentCorrectionDto,
  ): Promise<PaymentCorrectionResult> {
    const operationKey = dto.operationKey.trim().toLowerCase();
    const targetId = dto.target.id.trim();
    const reason = dto.reason.trim();
    const targetKey = `${financeOrderId}:${dto.target.kind}:${targetId}`;
    const fingerprint = requestFingerprint(paymentCorrectionFingerprintInput(financeOrderId, dto));

    return this.prisma.$transaction(async (tx) => {
      await lockFinanceOrderAggregate(tx, financeOrderId);
      const order = await tx.financeOrder.findUnique({
        where: { id: financeOrderId },
        select: {
          id: true,
          commercialOrderId: true,
          paymentStatus: true,
          productionClearedAt: true,
        },
      });
      if (!order) throw new NotFoundException(`Finance order ${financeOrderId} not found`);

      const existingOperation = await tx.financePaymentCorrectionCommand.findUnique({
        where: {
          financeOrderId_operationKey: { financeOrderId, operationKey },
        },
      });
      if (existingOperation) {
        if (
          existingOperation.requestFingerprint !== fingerprint ||
          existingOperation.targetKey !== targetKey
        ) {
          throw conflict(
            'PAYMENT_CORRECTION_OPERATION_KEY_CONFLICT',
            'operationKey уже связан с другой корректировкой оплаты.',
          );
        }
        const replay = resultFromJson(existingOperation.result);
        if (replay) return replay;
        throw conflict(
          'PAYMENT_CORRECTION_IN_PROGRESS',
          'Корректировка уже выполняется. Обновите заявку.',
        );
      }
      if (order.paymentStatus !== dto.expectedPaymentStatus) {
        throw conflict(
          'PAYMENT_CORRECTION_STATUS_CONFLICT',
          'Статус оплаты уже изменился. Обновите заявку.',
        );
      }

      const claimed = await tx.financePaymentCorrectionCommand.createMany({
        data: [
          {
            financeOrderId,
            operationKey,
            requestFingerprint: fingerprint,
            targetKind: dto.target.kind,
            targetId,
            targetKey,
            reason,
            actorRole: actor.role,
            actorId: actor.userId,
          },
        ],
        skipDuplicates: true,
      });
      const operationClaim = await tx.financePaymentCorrectionCommand.findUnique({
        where: {
          financeOrderId_operationKey: { financeOrderId, operationKey },
        },
      });
      if (operationClaim) {
        if (
          operationClaim.requestFingerprint !== fingerprint ||
          operationClaim.targetKey !== targetKey
        ) {
          throw conflict(
            'PAYMENT_CORRECTION_OPERATION_KEY_CONFLICT',
            'operationKey уже связан с другой корректировкой оплаты.',
          );
        }
        const replay = resultFromJson(operationClaim.result);
        if (replay) return replay;
        if (claimed.count === 0) {
          throw conflict(
            'PAYMENT_CORRECTION_IN_PROGRESS',
            'Корректировка уже выполняется. Обновите заявку.',
          );
        }
      } else {
        const targetClaim = await tx.financePaymentCorrectionCommand.findUnique({
          where: { targetKey },
        });
        if (targetClaim) {
          throw conflict(
            'PAYMENT_ALREADY_CORRECTED',
            'Этот платёжный факт уже был скорректирован.',
          );
        }
        throw conflict(
          'PAYMENT_CORRECTION_CLAIM_LOST',
          'Не удалось зафиксировать корректировку. Обновите заявку.',
        );
      }

      const commandId = operationClaim.id;
      let fallbackStatus: PaymentUpdateStatus = 'unpaid';
      let reversalOperationId: string | null = null;
      if (dto.target.kind === 'payment_update') {
        fallbackStatus = await this.correctPaymentUpdate(
          tx,
          financeOrderId,
          targetId,
          order.paymentStatus,
        );
      } else if (dto.target.kind === 'schedule_confirmation') {
        reversalOperationId = await this.correctScheduleConfirmation(
          tx,
          actor,
          financeOrderId,
          targetId,
          operationKey,
        );
      } else {
        reversalOperationId = await this.correctPaymentOperation(
          tx,
          actor,
          financeOrderId,
          targetId,
          operationKey,
        );
      }

      const state = await this.paymentState.recompute(tx, financeOrderId, fallbackStatus);
      const result = this.result(commandId, dto.target.kind, targetId, reversalOperationId, state);
      await this.audit.record(
        {
          type: 'audit:manual_payment_corrected',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: financeOrderId,
          reason,
          oldValue: {
            paymentStatus: order.paymentStatus,
            productionClearedAt: order.productionClearedAt?.toISOString() ?? null,
          },
          newValue: {
            paymentStatus: result.paymentStatus,
            productionClearedAt: result.productionClearedAt,
          },
          detail: {
            commandId,
            financeOrderId,
            commercialOrderId: order.commercialOrderId,
            targetKind: dto.target.kind,
            targetId,
            reversalOperationId,
          },
        },
        tx,
      );
      await tx.financePaymentCorrectionCommand.update({
        where: { id: commandId },
        data: { result: result as unknown as Prisma.InputJsonValue },
      });
      return result;
    });
  }

  private async correctPaymentUpdate(
    tx: Prisma.TransactionClient,
    financeOrderId: string,
    targetId: string,
    currentStatus: string,
  ): Promise<PaymentUpdateStatus> {
    const target = await tx.financePaymentUpdateCommand.findUnique({
      where: { id: targetId },
    });
    if (!target || target.financeOrderId !== financeOrderId) {
      throw new NotFoundException(`Payment update ${targetId} not found`);
    }
    const requestedStatus = asPaymentStatus(target.requestedStatus);
    const previousStatus = asPaymentStatus(target.previousStatus);
    if (!requestedStatus || !previousStatus) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_NOT_ADDRESSABLE',
        'Старая операция не содержит безопасного снимка для отмены.',
      );
    }
    if (currentStatus !== requestedStatus) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_STALE',
        'После этого подтверждения статус оплаты уже менялся.',
      );
    }
    const [laterUpdate, laterOperation] = await Promise.all([
      tx.financePaymentUpdateCommand.findFirst({
        where: {
          financeOrderId,
          id: { not: target.id },
          createdAt: { gt: target.createdAt },
        },
        select: { id: true },
      }),
      tx.paymentOperation.findFirst({
        where: { financeOrderId, createdAt: { gt: target.createdAt } },
        select: { id: true },
      }),
    ]);
    if (laterUpdate || laterOperation) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_STALE',
        'После этого подтверждения появились новые платёжные факты.',
      );
    }

    for (const transition of scheduleTransitions(target.result)) {
      const restored = await tx.paymentSchedule.updateMany({
        where: {
          id: transition.scheduleId,
          financeOrderId,
          status: transition.requestedStatus,
        },
        data: { status: transition.previousStatus },
      });
      if (restored.count !== 1) {
        throw conflict('PAYMENT_CORRECTION_TARGET_STALE', 'Связанный этап оплаты уже изменился.');
      }
    }
    return previousStatus;
  }

  private async correctScheduleConfirmation(
    tx: Prisma.TransactionClient,
    actor: PaymentCorrectionActor,
    financeOrderId: string,
    scheduleId: string,
    operationKey: string,
  ): Promise<string> {
    const schedule = await tx.paymentSchedule.findFirst({
      where: { id: scheduleId, financeOrderId },
      select: {
        id: true,
        status: true,
        source: true,
        allocations: { select: { amount: true } },
      },
    });
    if (!schedule) throw new NotFoundException(`Payment schedule ${scheduleId} not found`);
    const allocatedFromOneC = (schedule.allocations ?? []).reduce(
      (total, allocation) => total.plus(allocation.amount),
      new Prisma.Decimal(0),
    );
    const platformSchedule = ['manual_platform', 'payment_policy'].includes(schedule.source);
    if (!platformSchedule || allocatedFromOneC.gt(0)) {
      this.sourceCorrectionRequired();
    }
    if (schedule.status !== 'paid') {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_STALE',
        'Выбранный этап уже не подтверждён как оплаченный.',
      );
    }
    const operation = await tx.paymentOperation.findFirst({
      where: {
        financeOrderId,
        paymentScheduleId: scheduleId,
        amount: { gt: 0 },
        reversesOperationId: null,
      },
      include: { reversal: { select: { id: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!operation) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_NOT_ADDRESSABLE',
        'Для этапа не найден связанный ручной платёжный факт.',
      );
    }
    if (operation.source !== 'manual_platform') this.sourceCorrectionRequired();
    if (operation.reversal) {
      throw conflict('PAYMENT_ALREADY_CORRECTED', 'Этот платёжный факт уже был скорректирован.');
    }
    const laterOperation = await tx.paymentOperation.findFirst({
      where: {
        financeOrderId,
        paymentScheduleId: scheduleId,
        id: { not: operation.id },
        createdAt: { gt: operation.createdAt },
      },
      select: { id: true },
    });
    if (laterOperation) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_STALE',
        'После подтверждения этапа появились новые платёжные факты.',
      );
    }
    const restored = await tx.paymentSchedule.updateMany({
      where: { id: scheduleId, financeOrderId, status: 'paid' },
      data: { status: 'unpaid' },
    });
    if (restored.count !== 1) {
      throw conflict('PAYMENT_CORRECTION_TARGET_STALE', 'Этап оплаты уже изменился.');
    }
    return this.createReversal(tx, actor, operation, operationKey);
  }

  private async correctPaymentOperation(
    tx: Prisma.TransactionClient,
    actor: PaymentCorrectionActor,
    financeOrderId: string,
    operationId: string,
    operationKey: string,
  ): Promise<string> {
    const operation = await tx.paymentOperation.findUnique({
      where: { id: operationId },
      include: { reversal: { select: { id: true } } },
    });
    if (!operation || operation.financeOrderId !== financeOrderId) {
      throw new NotFoundException(`Payment operation ${operationId} not found`);
    }
    if (operation.source !== 'manual_platform') this.sourceCorrectionRequired();
    if (operation.amount.lte(0) || operation.reversesOperationId) {
      throw conflict(
        'PAYMENT_CORRECTION_TARGET_NOT_ADDRESSABLE',
        'Отменить можно только исходную положительную ручную операцию.',
      );
    }
    if (operation.reversal) {
      throw conflict('PAYMENT_ALREADY_CORRECTED', 'Этот платёжный факт уже был скорректирован.');
    }
    if (operation.paymentScheduleId) {
      await tx.paymentSchedule.updateMany({
        where: {
          id: operation.paymentScheduleId,
          financeOrderId,
          status: 'paid',
        },
        data: { status: 'unpaid' },
      });
    }
    return this.createReversal(tx, actor, operation, operationKey);
  }

  private async createReversal(
    tx: Prisma.TransactionClient,
    actor: PaymentCorrectionActor,
    operation: {
      id: string;
      financeOrderId: string;
      paymentScheduleId: string | null;
      amount: Prisma.Decimal;
      reconciled: boolean;
    },
    operationKey: string,
  ): Promise<string> {
    const reversal = await tx.paymentOperation.create({
      data: {
        financeOrderId: operation.financeOrderId,
        operationKey,
        operationType: 'manual_adjustment',
        amount: operation.amount.negated(),
        source: 'manual_platform',
        createdByRole: actor.role,
        reconciled: operation.reconciled,
        reversesOperationId: operation.id,
        paymentScheduleId: operation.paymentScheduleId,
      },
      select: { id: true },
    });
    return reversal.id;
  }

  private sourceCorrectionRequired(): never {
    throw conflict(
      'PAYMENT_SOURCE_CORRECTION_REQUIRED',
      'Факт из 1С нужно исправить в 1С; платформа не удаляет источник.',
    );
  }

  private result(
    commandId: string,
    targetKind: PaymentCorrectionTargetKind,
    targetId: string,
    reversalOperationId: string | null,
    state: RecomputedPaymentState,
  ): PaymentCorrectionResult {
    return {
      commandId,
      targetKind,
      targetId,
      reversalOperationId,
      paymentStatus: state.paymentStatus,
      productionClearedAt: state.productionClearedAt?.toISOString() ?? null,
    };
  }
}
