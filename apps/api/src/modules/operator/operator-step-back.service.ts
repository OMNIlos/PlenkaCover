import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OperatorRollStepBackResult } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { OperatorOperationDto } from './dto/operation.dto';
import { OperatorOperationService } from './operator-operation.service';
import { OperatorRollOwnershipService } from './operator-roll-ownership.service';
import {
  assertOperatorRollMutable,
  assertOperatorRollStepBack,
} from './operator-roll-state';
import type { OperatorActor } from './operator.service';

const STEP_BACK_REASON = 'operator_accidental_touch_correction';

@Injectable()
export class OperatorStepBackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ownership: OperatorRollOwnershipService,
    private readonly operations: OperatorOperationService,
  ) {}

  async stepBack(
    actor: OperatorActor,
    rollCode: string,
    dto: OperatorOperationDto,
  ): Promise<OperatorRollStepBackResult> {
    if (!actor.userId) {
      throw new UnauthorizedException('Для операции требуется полная пользовательская сессия.');
    }
    const actorId = actor.userId;

    return this.transaction(async (tx) => {
      const { session, line } = await this.ownership.lockOwned(tx, actor, rollCode);
      const claim = await this.operations.claim(tx, {
        operationKey: dto.operationKey,
        action: 'step_back',
        actorId,
        operatorRollLineId: line.id,
        postId: session.postId,
        postSessionId: session.id,
        expectedStep: line.step,
        fingerprintInput: {},
        reason: STEP_BACK_REASON,
      });
      if (claim.kind === 'replay') {
        return this.replay(rollCode, claim.operation.expectedStep, claim.operation.resultStep);
      }

      assertOperatorRollMutable('step_back', line);
      await this.assertPrintNotStarted(tx, line);
      const step = assertOperatorRollStepBack(line.step);
      const previousStep = line.step as OperatorRollStepBackResult['previousStep'];
      await this.operations.assertNoPhysicalOperationInProgress(tx, line.id);

      const data =
        step === 'spool_weight'
          ? {
              step,
              spoolKg: null,
              grossKg: null,
              netKg: null,
              toleranceOk: null,
            }
          : {
              step,
              grossKg: null,
              netKg: null,
              toleranceOk: null,
            };
      await tx.operatorRollLine.update({
        where: { id: line.id },
        data,
      });

      const oldValue = {
        step: previousStep,
        spoolKg: line.spoolKg,
        grossKg: line.grossKg,
        netKg: line.netKg,
        toleranceOk: line.toleranceOk,
        labelState: line.labelState,
      };
      const newValue = {
        ...oldValue,
        ...data,
      };
      await this.audit.record(
        {
          type: 'audit:operator_roll_step_reopened',
          actorRole: actor.role,
          actorId,
          objectId: rollCode,
          oldValue,
          newValue,
          reason: STEP_BACK_REASON,
          detail: {
            operationId: claim.operation.id,
            operationKey: dto.operationKey,
            postId: session.postId,
            sessionId: session.id,
          },
        },
        tx,
      );
      await this.operations.complete(tx, claim.operation.id, {
        resultStep: step,
        httpStatus: 200,
      });
      return { rollCode, previousStep, step };
    });
  }

  private async assertPrintNotStarted(
    tx: Prisma.TransactionClient,
    line: { id: string; labelState: string },
  ): Promise<void> {
    if (line.labelState !== 'not_printed') {
      throw this.printStarted();
    }
    const printJob = await tx.labelPrintJob.findFirst({
      where: { operatorRollLineId: line.id },
      select: { id: true },
    });
    if (printJob) throw this.printStarted();
  }

  private replay(
    rollCode: string,
    previousStep: string,
    step: string | null,
  ): OperatorRollStepBackResult {
    if (previousStep === 'qr_print' && step === 'roll_weight') {
      return { rollCode, previousStep, step };
    }
    if (previousStep === 'roll_weight' && step === 'spool_weight') {
      return { rollCode, previousStep, step };
    }
    throw new ConflictException({
      code: 'OPERATOR_STEP_CONFLICT',
      message: 'Сохранённый результат возврата этапа недоступен. Обновите рабочую очередь.',
    });
  }

  private printStarted() {
    return new ConflictException({
      code: 'OPERATOR_STEP_BACK_PRINT_STARTED',
      message: 'Возврат этапа невозможен: печать этикетки уже началась.',
    });
  }

  private async transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const serializationFailure =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            (error.code === 'P2010' && error.meta?.code === '40001'));
        if (serializationFailure && attempt < 3) continue;
        if (serializationFailure) {
          throw new ConflictException({
            code: 'OPERATOR_CONCURRENT_STATE_CONFLICT',
            message: 'Состояние рулона изменилось конкурентно. Обновите очередь.',
          });
        }
        throw error;
      }
    }
  }
}
