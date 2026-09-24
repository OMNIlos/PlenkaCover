import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { lockRollDispatchItems } from '../../common/prisma/roll-dispatch-lock';
import {
  correctionSnapshot,
  hasConsumedMaterialFacts,
  recipeVersionNumber,
} from './commercial-correction-policy';
import type { CommercialActor } from './commercial.service';
import type { MaterialShortageCorrectionDto } from './dto/material-shortage-correction.dto';

@Injectable()
export class MaterialShortageCorrectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async apply(actor: CommercialActor, orderId: string, dto: MaterialShortageCorrectionDto) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const problem = await tx.productionProblem.findFirst({
            where: {
              id: dto.problemId,
              orderId,
              type: 'raw_material_shortage',
              status: 'open',
            },
          });
          if (!problem) {
            throw new ConflictException('Open material shortage problem does not match the order.');
          }
          if (!problem.positionId || problem.rollId !== dto.fromRollId) {
            throw new ConflictException('Problem position or roll does not match the correction.');
          }

          const position = await tx.commercialOrderPosition.findFirst({
            where: { id: problem.positionId, orderId },
            include: { recipe: true },
          });
          if (!position?.recipe) {
            throw new NotFoundException(`Recipe for position ${problem.positionId} not found`);
          }

          const targetIdentity = await tx.rollDispatchItem.findFirst({
            where: {
              rollCode: dto.fromRollId,
              orderLineId: problem.positionId,
              productionOrder: { commercialOrderId: orderId },
            },
            select: {
              id: true,
              productionOrderId: true,
              orderLineId: true,
              positionSequence: true,
            },
          });
          if (!targetIdentity) throw new NotFoundException(`Roll ${dto.fromRollId} not found`);

          const candidateIds = await tx.rollDispatchItem.findMany({
            where: {
              productionOrderId: targetIdentity.productionOrderId,
              orderLineId: problem.positionId,
              positionSequence: { gte: targetIdentity.positionSequence },
            },
            select: { id: true },
            orderBy: { id: 'asc' },
          });
          await lockRollDispatchItems(
            tx,
            candidateIds.map((item) => item.id),
          );

          const target = await tx.rollDispatchItem.findUnique({
            where: { id: targetIdentity.id },
            include: { operatorLine: { include: { weightCaptures: true } } },
          });
          if (!target) throw new NotFoundException(`Roll ${dto.fromRollId} not found`);
          if (hasConsumedMaterialFacts(target)) {
            throw new ConflictException('Target roll already contains material consumption facts.');
          }

          const candidates = await tx.rollDispatchItem.findMany({
            where: {
              productionOrderId: target.productionOrderId,
              orderLineId: problem.positionId,
              positionSequence: { gte: target.positionSequence },
            },
            include: { operatorLine: { include: { weightCaptures: true } } },
            orderBy: [{ positionSequence: 'asc' }, { id: 'asc' }],
          });
          const eligible = candidates.filter((item) => !hasConsumedMaterialFacts(item));
          if (!eligible.some((item) => item.id === target.id)) {
            throw new ConflictException('Target roll is no longer eligible for correction.');
          }
          const snapshots = new Map(
            eligible.map((item) => [item.id, correctionSnapshot(item.characteristicsSnapshot)]),
          );

          const resolutionCase = await tx.orderResolutionCase.create({
            data: {
              orderId,
              problemId: problem.id,
              type: 'material_shortage_correction',
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
          const claimed = await tx.productionProblem.updateMany({
            where: { id: problem.id, status: 'open' },
            data: { status: 'resolved', resolvedAt, resolvedById: actor.userId },
          });
          if (claimed.count !== 1) {
            throw new ConflictException('Material shortage was resolved concurrently.');
          }

          const currentVersion = recipeVersionNumber(position.recipe.version);
          const nextVersionNumber = currentVersion + 1;
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
              version: nextVersionNumber,
              parameters: dto.newParameters as unknown as Prisma.InputJsonValue,
              source: 'material_shortage_correction',
              createdBy: actor.userId ?? 'commercial',
            },
          });
          const nextVersion = `v${nextVersionNumber}`;
          const recipeUpdated = await tx.recipeSnapshot.updateMany({
            where: { id: position.recipe.id, version: position.recipe.version },
            data: {
              version: nextVersion,
              parameters: dto.newParameters as unknown as Prisma.InputJsonValue,
            },
          });
          if (recipeUpdated.count !== 1) {
            throw new ConflictException('Recipe changed concurrently; retry the correction.');
          }

          await tx.commercialOrderPosition.update({
            where: { id: position.id },
            data: { rawMaterialId: dto.newRawMaterialId },
          });

          for (const item of eligible) {
            await tx.rollDispatchItem.update({
              where: { id: item.id },
              data: {
                rawMaterialId: dto.newRawMaterialId,
                recipeVersion: nextVersion,
                characteristicsSnapshot: {
                  ...snapshots.get(item.id),
                  rawMaterialId: dto.newRawMaterialId,
                  recipeVersion: nextVersion,
                  recipeParameters: dto.newParameters,
                } as unknown as Prisma.InputJsonValue,
              },
            });
          }

          const caseClaim = await tx.orderResolutionCase.updateMany({
            where: { id: resolutionCase.id, status: 'open', version: resolutionCase.version },
            data: {
              status: 'resolved',
              outcome: 'material_substituted',
              nextOwnerRole: null,
              resolvedAt,
              version: { increment: 1 },
            },
          });
          if (caseClaim.count !== 1) {
            throw new ConflictException('Material shortage resolution changed concurrently.');
          }

          const affectedRollIds = eligible.map((item) => item.rollCode);
          const detail = {
            caseId: resolutionCase.id,
            problemId: problem.id,
            orderId,
            positionId: position.id,
            fromRollId: target.rollCode,
            affectedRollIds,
            oldRecipeVersionId: oldRecipeVersion.id,
            newRecipeVersionId: newRecipeVersion.id,
          } as Prisma.InputJsonValue;
          const oldValue = {
            rawMaterialId: position.rawMaterialId,
            recipeVersion: position.recipe.version,
            recipeParameters: position.recipe.parameters,
          } as Prisma.InputJsonValue;
          const newValue = {
            rawMaterialId: dto.newRawMaterialId,
            recipeVersion: nextVersion,
            recipeParameters: dto.newParameters,
          } as unknown as Prisma.InputJsonValue;

          await this.audit.record(
            {
              type: 'audit:recipe_correction_applied',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              reason: dto.reason,
              detail,
              oldValue,
              newValue,
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'audit:raw_material_shortage_resolved',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              reason: dto.reason,
              detail,
              oldValue,
              newValue,
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'notification:commercial_correction_applied',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              label: 'Параметры заказа изменены после ошибки сырья',
              detail: {
                notificationKey: `correction:${resolutionCase.id}:${nextVersion}`,
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
              },
            },
            tx,
          );
          await this.audit.record(
            {
              type: 'notification:operator_recipe_changed',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              label: `Recipe changed from roll ${target.rollCode}`,
              detail,
            },
            tx,
          );

          return {
            caseId: resolutionCase.id,
            problemId: problem.id,
            status: 'resolved' as const,
            oldRecipeVersionId: oldRecipeVersion.id,
            newRecipeVersionId: newRecipeVersion.id,
            recipeVersion: nextVersion,
            affectedRollIds,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2034'].includes(error.code)
      ) {
        throw new ConflictException('Correction conflicted with concurrent operator activity.');
      }
      throw error;
    }
  }
}
