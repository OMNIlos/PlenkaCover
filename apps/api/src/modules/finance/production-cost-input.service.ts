import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AdditionalProductionCostView, MaterialPriceReferenceView } from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  RecordAdditionalProductionCostDto,
  SetMaterialPriceDto,
} from './dto/production-cost-input.dto';

function normalizeText(value: string, code: string): string {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    throw new BadRequestException({ code, message: 'Значение не может быть пустым.' });
  }
  return normalized;
}

function parseInstant(value: string, code: string): Date {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new BadRequestException({ code, message: 'Указана некорректная дата.' });
  }
  return instant;
}

type PriceRow = {
  id: string;
  requestFingerprint: string;
  rawMaterialDefinitionId: string;
  priceKopecksPerKg: number;
  source: string;
  effectiveFrom: Date;
  reason: string;
  createdAt: Date;
  rawMaterialDefinition: { name: string };
};

type AdditionalRow = {
  id: string;
  requestFingerprint: string;
  rollDispatchItemId: string | null;
  productionOrderId: string | null;
  allocationBasis: string;
  amountKopecks: number;
  source: string;
  effectiveAt: Date;
  reason: string;
  createdAt: Date;
};

function priceView(row: PriceRow): MaterialPriceReferenceView {
  return {
    id: row.id,
    rawMaterialDefinitionId: row.rawMaterialDefinitionId,
    materialName: row.rawMaterialDefinition.name,
    priceKopecksPerKg: row.priceKopecksPerKg,
    source: row.source,
    effectiveFrom: row.effectiveFrom.toISOString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

function additionalView(row: AdditionalRow): AdditionalProductionCostView {
  const targetKind = row.rollDispatchItemId === null ? 'order' : 'roll';
  return {
    id: row.id,
    targetKind,
    targetId: row.rollDispatchItemId ?? row.productionOrderId!,
    allocationBasis: targetKind === 'roll' ? 'direct' : 'finished_net_kg',
    amountKopecks: row.amountKopecks,
    source: row.source,
    effectiveAt: row.effectiveAt.toISOString(),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ProductionCostInputService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async setMaterialPrice(
    actor: Actor,
    dto: SetMaterialPriceDto,
  ): Promise<MaterialPriceReferenceView> {
    const command = {
      operationKey: dto.operationKey,
      rawMaterialDefinitionId: dto.rawMaterialDefinitionId.trim(),
      priceKopecksPerKg: dto.priceKopecksPerKg,
      source: normalizeText(dto.source, 'MATERIAL_PRICE_SOURCE_REQUIRED'),
      effectiveFrom: parseInstant(dto.effectiveFrom, 'MATERIAL_PRICE_DATE_INVALID').toISOString(),
      reason: normalizeText(dto.reason, 'MATERIAL_PRICE_REASON_REQUIRED'),
    };
    const fingerprint = requestFingerprint(command);
    const existing = await this.findPrice(command.operationKey);
    if (existing) return this.replayPrice(existing, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await tx.materialPriceReference.findUnique({
          where: { operationKey: command.operationKey },
          include: { rawMaterialDefinition: { select: { name: true } } },
        });
        if (replay) return this.replayPrice(replay, fingerprint);

        const material = await tx.rawMaterialDefinition.findUnique({
          where: { id: command.rawMaterialDefinitionId },
          select: { id: true },
        });
        if (!material) {
          throw new NotFoundException({
            code: 'MATERIAL_PRICE_MATERIAL_NOT_FOUND',
            message: 'Сырьё не найдено.',
          });
        }
        const created = await tx.materialPriceReference.create({
          data: {
            operationKey: command.operationKey,
            requestFingerprint: fingerprint,
            rawMaterialDefinitionId: material.id,
            priceKopecksPerKg: command.priceKopecksPerKg,
            source: command.source,
            effectiveFrom: new Date(command.effectiveFrom),
            reason: command.reason,
            createdById: actor.userId,
            createdByRole: actor.role,
          },
          include: { rawMaterialDefinition: { select: { name: true } } },
        });
        await this.audit.record(
          {
            type: 'audit:material_cost_reference_updated',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: material.id,
            reason: command.reason,
            newValue: {
              priceKopecksPerKg: command.priceKopecksPerKg,
              source: command.source,
              effectiveFrom: command.effectiveFrom,
            },
          },
          tx,
        );
        return priceView(created);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findPrice(command.operationKey);
        if (winner) return this.replayPrice(winner, fingerprint);
        throw new ConflictException({
          code: 'MATERIAL_PRICE_EFFECTIVE_DATE_CONFLICT',
          message: 'Для сырья уже зафиксирована цена с этой датой начала действия.',
        });
      }
      throw error;
    }
  }

  async recordAdditionalCost(
    actor: Actor,
    dto: RecordAdditionalProductionCostDto,
  ): Promise<AdditionalProductionCostView> {
    const rollDispatchItemId = dto.rollDispatchItemId?.trim() || null;
    const productionOrderId = dto.productionOrderId?.trim() || null;
    if (Number(rollDispatchItemId !== null) + Number(productionOrderId !== null) !== 1) {
      throw new BadRequestException({
        code: 'ADDITIONAL_COST_TARGET_INVALID',
        message: 'Выберите либо один рулон, либо один производственный заказ.',
      });
    }
    const command = {
      operationKey: dto.operationKey,
      rollDispatchItemId,
      productionOrderId,
      amountKopecks: dto.amountKopecks,
      source: normalizeText(dto.source, 'ADDITIONAL_COST_SOURCE_REQUIRED'),
      effectiveAt: parseInstant(dto.effectiveAt, 'ADDITIONAL_COST_DATE_INVALID').toISOString(),
      reason: normalizeText(dto.reason, 'ADDITIONAL_COST_REASON_REQUIRED'),
    };
    const fingerprint = requestFingerprint(command);
    const existing = await this.findAdditional(command.operationKey);
    if (existing) return this.replayAdditional(existing, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const replay = await tx.additionalProductionCost.findUnique({
          where: { operationKey: command.operationKey },
        });
        if (replay) return this.replayAdditional(replay, fingerprint);

        const target = rollDispatchItemId
          ? await tx.rollDispatchItem.findUnique({
              where: { id: rollDispatchItemId },
              select: { id: true },
            })
          : await tx.productionOrder.findUnique({
              where: { id: productionOrderId! },
              select: { id: true },
            });
        if (!target) {
          throw new NotFoundException({
            code: 'ADDITIONAL_COST_TARGET_NOT_FOUND',
            message: 'Рулон или производственный заказ не найден.',
          });
        }
        const created = await tx.additionalProductionCost.create({
          data: {
            operationKey: command.operationKey,
            requestFingerprint: fingerprint,
            rollDispatchItemId,
            productionOrderId,
            allocationBasis: rollDispatchItemId ? 'direct' : 'finished_net_kg',
            amountKopecks: command.amountKopecks,
            source: command.source,
            effectiveAt: new Date(command.effectiveAt),
            reason: command.reason,
            createdById: actor.userId,
            createdByRole: actor.role,
          },
        });
        await this.audit.record(
          {
            type: 'audit:additional_production_cost_recorded',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: rollDispatchItemId ?? productionOrderId,
            reason: command.reason,
            newValue: {
              amountKopecks: command.amountKopecks,
              allocationBasis: created.allocationBasis,
              source: command.source,
              effectiveAt: command.effectiveAt,
            },
          },
          tx,
        );
        return additionalView(created);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findAdditional(command.operationKey);
        if (winner) return this.replayAdditional(winner, fingerprint);
      }
      throw error;
    }
  }

  private findPrice(operationKey: string): Promise<PriceRow | null> {
    return this.prisma.materialPriceReference.findUnique({
      where: { operationKey },
      include: { rawMaterialDefinition: { select: { name: true } } },
    });
  }

  private findAdditional(operationKey: string): Promise<AdditionalRow | null> {
    return this.prisma.additionalProductionCost.findUnique({ where: { operationKey } });
  }

  private replayPrice(row: PriceRow, fingerprint: string): MaterialPriceReferenceView {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'MATERIAL_PRICE_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже использован для другого изменения цены.',
      });
    }
    return priceView(row);
  }

  private replayAdditional(row: AdditionalRow, fingerprint: string): AdditionalProductionCostView {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'ADDITIONAL_COST_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже использован для другой затраты.',
      });
    }
    return additionalView(row);
  }
}
