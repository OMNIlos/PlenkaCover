import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommercialCurrentRollResolution } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lockRollDispatchItems } from '../../common/prisma/roll-dispatch-lock';
import {
  correctionSnapshot,
  hasConsumedMaterialFacts,
  recipeVersionNumber,
} from './commercial-correction-policy';
import type { CommercialActor } from './commercial.service';
import type { ProblemCorrectionDto } from './dto/correction.dto';

type ProblemCorrectionCommand = Omit<ProblemCorrectionDto, 'currentRollResolution'> & {
  currentRollResolution: CommercialCurrentRollResolution;
};

@Injectable()
export class CommercialResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async apply(
    actor: CommercialActor,
    orderId: string,
    problemId: string,
    dto: ProblemCorrectionCommand,
  ) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const order = await tx.commercialOrder.findUnique({
            where: { id: orderId },
            select: {
              id: true,
              commercialStage: true,
              paymentStatus: true,
              commercialLockedAt: true,
            },
          });
          if (!order) throw new NotFoundException(`Commercial order ${orderId} not found`);

          const problem = await tx.productionProblem.findFirst({
            where: {
              id: problemId,
              orderId,
              positionId: dto.positionId,
              status: 'open',
            },
          });
          if (problem?.type === 'raw_material_shortage') {
            throw new ConflictException(
              'Raw material shortages require the dedicated material correction flow',
            );
          }
          if (!problem?.positionId || !problem.rollId) {
            throw new ConflictException(
              'An open production problem with a position and roll is required for correction',
            );
          }

          const position = await tx.commercialOrderPosition.findFirst({
            where: { id: dto.positionId, orderId },
            include: { recipe: true },
          });
          if (!position?.recipe) {
            throw new NotFoundException(`Recipe for position ${dto.positionId} not found`);
          }
          if (position.recipe.version !== dto.expectedRecipeVersion) {
            throw new ConflictException('Recipe changed; reload the problem before correcting it');
          }

          const [problemRoll, targetRoll] = await Promise.all([
            this.rollIdentity(tx, orderId, problem.positionId, problem.rollId),
            this.rollIdentity(tx, orderId, problem.positionId, dto.fromRollId),
          ]);
          if (problemRoll.productionOrderId !== targetRoll.productionOrderId) {
            throw new ConflictException('Correction boundary belongs to another production order');
          }
          this.assertBoundary(
            dto.currentRollResolution,
            problemRoll.positionSequence,
            targetRoll.positionSequence,
          );

          const candidateIds = await tx.rollDispatchItem.findMany({
            where: {
              productionOrderId: targetRoll.productionOrderId,
              orderLineId: position.id,
              positionSequence: { gte: targetRoll.positionSequence },
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          await lockRollDispatchItems(
            tx,
            candidateIds.map((item) => item.id),
          );

          const target = await tx.rollDispatchItem.findUnique({
            where: { id: targetRoll.id },
            include: { operatorLine: { include: { weightCaptures: true } } },
          });
          if (!target) throw new NotFoundException(`Roll ${dto.fromRollId} not found`);
          if (hasConsumedMaterialFacts(target)) {
            throw new ConflictException(
              'Correction boundary already has material consumption facts',
            );
          }

          const candidates = await tx.rollDispatchItem.findMany({
            where: {
              productionOrderId: target.productionOrderId,
              orderLineId: position.id,
              positionSequence: { gte: target.positionSequence },
            },
            include: { operatorLine: { include: { weightCaptures: true } } },
            orderBy: [{ positionSequence: 'asc' }, { id: 'asc' }],
          });
          const eligible = candidates.filter((item) => !hasConsumedMaterialFacts(item));
          if (!eligible.some((item) => item.id === target.id)) {
            throw new ConflictException('Correction boundary is no longer eligible');
          }
          const snapshots = new Map(
            eligible.map((item) => [item.id, correctionSnapshot(item.characteristicsSnapshot)]),
          );

          const resolutionCase = await tx.orderResolutionCase.create({
            data: {
              orderId,
              problemId: problem.id,
              type: 'production_recipe_correction',
              status: 'open',
              ownerRole: 'commercial',
              affectedPositionIds: [position.id],
              affectedRollIds: eligible.map((item) => item.rollCode),
              reason: dto.reason,
              createdByRole: actor.role,
              createdById: actor.userId,
            },
          });
          const resolvedAt = new Date();
          const problemClaim = await tx.productionProblem.updateMany({
            where: { id: problem.id, status: 'open' },
            data: { status: 'resolved', resolvedAt, resolvedById: actor.userId },
          });
          if (problemClaim.count !== 1) {
            throw new ConflictException('Production problem was corrected concurrently');
          }

          const currentVersion = recipeVersionNumber(position.recipe.version);
          const nextVersion = currentVersion + 1;
          const oldRecipeVersion = await tx.recipeSnapshotVersion.upsert({
            where: {
              recipeSnapshotId_version: {
                recipeSnapshotId: position.recipe.id,
                version: currentVersion,
              },
            },
            update: {},
            create: {
              recipeSnapshotId: position.recipe.id,
              version: currentVersion,
              parameters: position.recipe.parameters as Prisma.InputJsonValue,
              source: position.recipe.source,
              createdBy: position.recipe.createdBy,
              createdAt: position.recipe.createdAt,
            },
          });
          const newRecipeVersion = await tx.recipeSnapshotVersion.create({
            data: {
              recipeSnapshotId: position.recipe.id,
              version: nextVersion,
              parameters: dto.newParameters as unknown as Prisma.InputJsonValue,
              source: 'production_problem_correction',
              createdBy: actor.userId ?? 'commercial',
            },
          });
          const nextVersionLabel = `v${nextVersion}`;
          const recipeClaim = await tx.recipeSnapshot.updateMany({
            where: { id: position.recipe.id, version: position.recipe.version },
            data: {
              version: nextVersionLabel,
              parameters: dto.newParameters as unknown as Prisma.InputJsonValue,
            },
          });
          if (recipeClaim.count !== 1) {
            throw new ConflictException('Recipe changed concurrently; retry the correction');
          }
          const positionClaim = await tx.commercialOrderPosition.updateMany({
            where: { id: position.id, orderId, version: position.version },
            data: { version: { increment: 1 } },
          });
          if (positionClaim.count !== 1) {
            throw new ConflictException(
              'Order position changed concurrently; retry the correction',
            );
          }

          for (const item of eligible) {
            await tx.rollDispatchItem.update({
              where: { id: item.id },
              data: {
                recipeVersion: nextVersionLabel,
                characteristicsSnapshot: {
                  ...snapshots.get(item.id),
                  recipeVersion: nextVersionLabel,
                  recipeParameters: dto.newParameters,
                } as unknown as Prisma.InputJsonValue,
              },
            });
          }

          const caseClaim = await tx.orderResolutionCase.updateMany({
            where: { id: resolutionCase.id, status: 'open', version: resolutionCase.version },
            data: {
              status: 'resolved',
              outcome: dto.currentRollResolution,
              nextOwnerRole: null,
              resolvedAt,
              version: { increment: 1 },
            },
          });
          if (caseClaim.count !== 1) {
            throw new ConflictException('Resolution case changed concurrently');
          }
          await tx.commercialOrder.updateMany({
            where: { id: orderId },
            data: { readyForShipmentAt: null },
          });

          const affectedRollIds = eligible.map((item) => item.rollCode);
          const detail = {
            caseId: resolutionCase.id,
            problemId: problem.id,
            positionId: position.id,
            fromRollId: target.rollCode,
            fromPositionSequence: target.positionSequence,
            affectedRollIds,
            oldRecipeVersionId: oldRecipeVersion.id,
            newRecipeVersionId: newRecipeVersion.id,
          } as Prisma.InputJsonValue;
          const oldValue = {
            recipeVersionId: oldRecipeVersion.id,
            recipeVersion: position.recipe.version,
            parameters: position.recipe.parameters,
          } as Prisma.InputJsonValue;
          const newValue = {
            recipeVersionId: newRecipeVersion.id,
            recipeVersion: nextVersionLabel,
            parameters: dto.newParameters,
          } as unknown as Prisma.InputJsonValue;
          const relatedRoleNotification = {
            notificationKey: `correction:${resolutionCase.id}:${nextVersionLabel}`,
            recipientRoles: [
              'commercial',
              'production_lead',
              'operator',
              'warehouse',
              'finance',
              'director',
            ],
            recipientUserIds: [
              ...new Set(
                eligible
                  .map((item) => item.assignedOperatorId)
                  .filter((operatorId): operatorId is string => Boolean(operatorId)),
              ),
            ].sort(),
            orderId,
            productionOrderId: target.productionOrderId,
            problemId: problem.id,
            caseId: resolutionCase.id,
            positionId: position.id,
            rollIds: affectedRollIds,
          } as Prisma.InputJsonValue;
          for (const event of [
            {
              type: 'audit:commercial_position_correction_requested',
              oldValue,
              newValue,
            },
            { type: 'audit:correction_applies_from_roll_set', detail },
            {
              type: 'audit:current_roll_resolution_set',
              newValue: { resolution: dto.currentRollResolution },
            },
            { type: 'audit:recipe_correction_applied', oldValue, newValue },
            {
              type: 'notification:commercial_correction_applied',
              label: 'Параметры заказа изменены после производственной ошибки',
              detail: relatedRoleNotification,
            },
            {
              type: 'notification:operator_recipe_changed',
              label: `Recipe changed from roll ${target.rollCode}`,
            },
          ] as const) {
            await this.audit.record(
              {
                ...event,
                actorRole: actor.role,
                actorId: actor.userId,
                objectId: orderId,
                reason: dto.reason,
                detail: 'detail' in event ? event.detail : detail,
              },
              tx,
            );
          }

          return {
            caseId: resolutionCase.id,
            problemId: problem.id,
            status: 'resolved' as const,
            oldRecipeVersionId: oldRecipeVersion.id,
            newRecipeVersionId: newRecipeVersion.id,
            recipeVersion: nextVersionLabel,
            affectedRollIds,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException('Correction conflicted with another request; reload and retry');
      }
      throw error;
    }
  }

  private async rollIdentity(
    tx: Prisma.TransactionClient,
    orderId: string,
    positionId: string,
    rollReference: string,
  ) {
    const roll = await tx.rollDispatchItem.findFirst({
      where: {
        OR: [{ id: rollReference }, { rollCode: rollReference }],
        orderLineId: positionId,
        productionOrder: { commercialOrderId: orderId },
      },
      select: {
        id: true,
        rollCode: true,
        productionOrderId: true,
        positionSequence: true,
      },
    });
    if (!roll) {
      throw new NotFoundException(`Roll ${rollReference} not found for the problem position`);
    }
    return roll;
  }

  private assertBoundary(
    resolution: CommercialCurrentRollResolution,
    problemSequence: number,
    targetSequence: number,
  ) {
    if (targetSequence < problemSequence) {
      throw new ConflictException('Correction cannot rewrite rolls before the reported problem');
    }
    if (resolution === 'stop_and_apply_new' && targetSequence !== problemSequence) {
      throw new ConflictException('Stopping the current roll must apply from that same roll');
    }
    if (resolution === 'finish_old_version' && targetSequence <= problemSequence) {
      throw new ConflictException('Finishing the current roll requires the next roll as boundary');
    }
  }
}
