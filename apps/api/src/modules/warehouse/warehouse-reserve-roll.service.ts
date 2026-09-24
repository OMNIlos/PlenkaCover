import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RollTokenService } from '../../common/roll-token/roll-token.service';
import { RecipeCatalogService } from '../material-catalog/recipe-catalog.service';
import {
  canonicalizeRollCoverageSpec,
  fingerprintRollFact,
  WAREHOUSE_COVERAGE_POLICY_VERSION,
} from '../warehouse-coverage/warehouse-coverage-canonical';
import { WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION } from '../warehouse-coverage/warehouse-roll-coverage-fact.service';
import {
  lockCoverageInventoryEpoch,
  runCoverageSerializable,
} from '../warehouse-coverage/warehouse-coverage-transaction';
import type {
  CreateWarehouseReserveRollDto,
  WarehouseReserveRollResponseDto,
} from './dto/reserve-roll.dto';

const PLATFORM_BATCH_TITLE_PREFIX = 'Ручной резерв · ';

function normalizeText(value: string, field: string): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    throw new BadRequestException({
      code: 'RESERVE_ROLL_FIELD_REQUIRED',
      message: `Поле «${field}» не заполнено.`,
    });
  }
  return normalized;
}

function milli(value: number, field: string): number {
  const result = Math.round(value * 1_000);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new BadRequestException({
      code: 'RESERVE_ROLL_NUMBER_INVALID',
      message: `Поле «${field}» должно быть положительным числом.`,
    });
  }
  return result;
}

function kg(milliKg: number): number {
  return Number((milliKg / 1_000).toFixed(3));
}

function platformBatchIdentity(batchCode: string) {
  const digest = createHash('sha256').update(batchCode, 'utf8').digest('hex');
  return {
    orderNumber: `WR-${digest.slice(0, 16).toUpperCase()}`,
    title: `${PLATFORM_BATCH_TITLE_PREFIX}${batchCode}`,
  };
}

function record(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException({
      code: 'RESERVE_ROLL_REPLAY_CORRUPTED',
      message: 'Сохранённый результат регистрации рулона повреждён.',
    });
  }
  return value as Record<string, Prisma.JsonValue>;
}

function stringField(source: Record<string, Prisma.JsonValue>, key: string): string {
  const value = source[key];
  if (typeof value !== 'string' || !value) {
    throw new ConflictException({
      code: 'RESERVE_ROLL_REPLAY_CORRUPTED',
      message: 'Сохранённый результат регистрации рулона повреждён.',
    });
  }
  return value;
}

function numberField(source: Record<string, Prisma.JsonValue>, key: string): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConflictException({
      code: 'RESERVE_ROLL_REPLAY_CORRUPTED',
      message: 'Сохранённый результат регистрации рулона повреждён.',
    });
  }
  return value;
}

function reserveRollResult(value: Prisma.JsonValue): WarehouseReserveRollResponseDto {
  const source = record(value);
  if (
    source.source !== 'platform' ||
    source.availability !== 'available' ||
    source.qrReady !== true
  ) {
    throw new ConflictException({
      code: 'RESERVE_ROLL_REPLAY_CORRUPTED',
      message: 'Сохранённый результат регистрации рулона повреждён.',
    });
  }
  return {
    id: stringField(source, 'id'),
    rollCode: stringField(source, 'rollCode'),
    batchCode: stringField(source, 'batchCode'),
    sourceOrderId: stringField(source, 'sourceOrderId'),
    sourceOrderNumber: stringField(source, 'sourceOrderNumber'),
    filmType: stringField(source, 'filmType'),
    actualThicknessMicron: numberField(source, 'actualThicknessMicron'),
    accountingThicknessMicron: numberField(source, 'accountingThicknessMicron'),
    widthMm: numberField(source, 'widthMm'),
    plannedLengthM: numberField(source, 'plannedLengthM'),
    grossKg: numberField(source, 'grossKg'),
    spoolKg: numberField(source, 'spoolKg'),
    netKg: numberField(source, 'netKg'),
    plannedNetKg: numberField(source, 'plannedNetKg'),
    spoolType: stringField(source, 'spoolType'),
    birka: stringField(source, 'birka'),
    materialLabel: stringField(source, 'materialLabel'),
    source: 'platform',
    availability: 'available',
    receivedAt: stringField(source, 'receivedAt'),
    qrReady: true,
  };
}

@Injectable()
export class WarehouseReserveRollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: RollTokenService,
    private readonly recipes: RecipeCatalogService,
  ) {}

  async create(
    actor: Actor,
    dto: CreateWarehouseReserveRollDto,
  ): Promise<WarehouseReserveRollResponseDto> {
    const command = this.normalize(dto);
    const fingerprint = requestFingerprint(command);
    const existing = await this.prisma.warehouseReserveRollCommand.findUnique({
      where: { operationKey: command.operationKey },
      select: { requestFingerprint: true, resultSnapshot: true },
    });
    if (existing) return this.replay(existing, fingerprint);

    try {
      return await runCoverageSerializable(this.prisma, async (tx) => {
        await lockCoverageInventoryEpoch(tx);
        const replay = await tx.warehouseReserveRollCommand.findUnique({
          where: { operationKey: command.operationKey },
          select: { requestFingerprint: true, resultSnapshot: true },
        });
        if (replay) return this.replay(replay, fingerprint);

        const [selection] = await this.recipes.resolveSelections(tx, [
          command.baseRawMaterialDefinitionId
            ? { baseRawMaterialDefinitionId: command.baseRawMaterialDefinitionId }
            : { recipeDefinitionVersionId: command.recipeDefinitionVersionId! },
        ]);
        if (!selection) {
          throw new ConflictException({
            code: 'RESERVE_ROLL_MATERIAL_UNAVAILABLE',
            message: 'Выбранное сырьё или рецептура больше недоступны.',
          });
        }

        const batchIdentity = platformBatchIdentity(command.batchCode);
        const sourceOrder = await this.getOrCreateBatch(
          tx,
          actor,
          command.batchCode,
          batchIdentity,
        );
        const grossMilliKg = milli(command.grossKg, 'Брутто');
        const spoolMilliKg = milli(command.spoolKg, 'Шпуля');
        const netMilliKg = grossMilliKg - spoolMilliKg;
        if (netMilliKg <= 0) {
          throw new BadRequestException({
            code: 'RESERVE_ROLL_NET_WEIGHT_INVALID',
            message: 'Вес брутто должен быть больше веса шпули.',
          });
        }
        const plannedNetMilliKg = milli(command.plannedNetKg ?? kg(netMilliKg), 'План нетто');
        const receivedAt = new Date();
        const position = await tx.commercialOrderPosition.create({
          data: {
            orderId: sourceOrder.id,
            rollCount: 1,
            filmType: command.filmType,
            actualThickness: `${command.actualThicknessMicron} мкм`,
            accountingThickness: `${command.accountingThicknessMicron} мкм`,
            baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
            recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
            spoolType: command.spoolType,
            birka: command.birka,
            plannedWeightKg: kg(plannedNetMilliKg),
            widthMm: command.widthMm,
            plannedLengthM: command.plannedLengthM,
            warehouseCoverStatus: 'full_confirmed',
          },
          select: { id: true },
        });
        const spec = canonicalizeRollCoverageSpec({
          rollCode: command.rollCode,
          sourceOrderId: sourceOrder.id,
          sourcePositionId: position.id,
          ownerCounterpartyId: null,
          filmType: command.filmType,
          actualThicknessMilliMicron: milli(command.actualThicknessMicron, 'Фактическая толщина'),
          accountingThicknessMilliMicron: milli(
            command.accountingThicknessMicron,
            'Бухгалтерская толщина',
          ),
          widthMilliMm: milli(command.widthMm, 'Ширина'),
          plannedLengthMilliM: milli(command.plannedLengthM, 'Метраж'),
          birka: command.birka,
          spoolType: command.spoolType,
          actualWeightMilliKg: netMilliKg,
          plannedWeightMilliKg: plannedNetMilliKg,
          ingredients: selection.ingredients.map((ingredient) => ({
            rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
            shareBasisPoints: ingredient.shareBasisPoints,
          })),
          recipeId: null,
          recipeVersion:
            selection.version === null ? selection.name : `${selection.name} v${selection.version}`,
          recipeDefinitionId: selection.recipeDefinitionId,
          recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
          recipeVersionNumber: selection.version,
          policyVersion: WAREHOUSE_COVERAGE_POLICY_VERSION,
        });
        const roll = await tx.warehouseRoll.create({
          data: {
            rollCode: command.rollCode,
            positionSnapshot: {
              source: 'platform',
              grossMilliKg,
              spoolMilliKg,
              netMilliKg,
              materialLabel: selection.name,
            },
            ownerCounterpartyId: null,
            producedForStockOrderId: sourceOrder.id,
            warehouseStatus: 'received',
            receivedAt,
          },
          select: { id: true, rollCode: true },
        });
        const fact = await tx.warehouseRollCoverageFact.create({
          data: {
            rollId: roll.id,
            version: 1,
            source: 'manual_platform',
            specVersion: WAREHOUSE_ROLL_COVERAGE_SPEC_VERSION,
            specFingerprint: fingerprintRollFact(spec),
            spec: spec as unknown as Prisma.InputJsonValue,
            sourceOrderId: sourceOrder.id,
            sourcePositionId: position.id,
            actorKind: 'user',
            actorRole: actor.role,
            actorId: actor.userId,
            systemActorKey: null,
            reason: 'Ручная регистрация готового рулона в резерве склада',
          },
          select: { id: true },
        });
        await tx.warehouseRoll.update({
          where: { id: roll.id },
          data: { currentCoverageFactId: fact.id },
        });
        await this.tokens.getOrCreate(roll.rollCode, tx);

        const result: WarehouseReserveRollResponseDto = {
          id: roll.id,
          rollCode: roll.rollCode,
          batchCode: command.batchCode,
          sourceOrderId: sourceOrder.id,
          sourceOrderNumber: sourceOrder.orderNumber,
          filmType: command.filmType,
          actualThicknessMicron: command.actualThicknessMicron,
          accountingThicknessMicron: command.accountingThicknessMicron,
          widthMm: command.widthMm,
          plannedLengthM: command.plannedLengthM,
          grossKg: kg(grossMilliKg),
          spoolKg: kg(spoolMilliKg),
          netKg: kg(netMilliKg),
          plannedNetKg: kg(plannedNetMilliKg),
          spoolType: command.spoolType,
          birka: command.birka,
          materialLabel: selection.name,
          source: 'platform',
          availability: 'available',
          receivedAt: receivedAt.toISOString(),
          qrReady: true,
        };
        await tx.warehouseReserveRollCommand.create({
          data: {
            operationKey: command.operationKey,
            requestFingerprint: fingerprint,
            rollId: roll.id,
            sourceOrderId: sourceOrder.id,
            sourcePositionId: position.id,
            actorRole: actor.role,
            actorId: actor.userId,
            resultSnapshot: result as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.record(
          {
            type: 'audit:warehouse_reserve_roll_created',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: roll.rollCode,
            oldValue: { exists: false },
            newValue: {
              source: 'platform',
              batchCode: command.batchCode,
              grossKg: result.grossKg,
              spoolKg: result.spoolKg,
              netKg: result.netKg,
              available: true,
            },
            detail: {
              warehouseRollId: roll.id,
              sourceOrderId: sourceOrder.id,
              sourcePositionId: position.id,
            },
          },
          tx,
        );
        return result;
      });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.prisma.warehouseReserveRollCommand.findUnique({
          where: { operationKey: command.operationKey },
          select: { requestFingerprint: true, resultSnapshot: true },
        });
        if (winner) return this.replay(winner, fingerprint);
        throw new ConflictException({
          code: 'RESERVE_ROLL_ALREADY_EXISTS',
          message: 'Код рулона или партии уже используется.',
        });
      }
      throw error;
    }
  }

  private normalize(dto: CreateWarehouseReserveRollDto) {
    const baseRawMaterialDefinitionId = dto.baseRawMaterialDefinitionId?.trim() || null;
    const recipeDefinitionVersionId = dto.recipeDefinitionVersionId?.trim() || null;
    if (
      Number(Boolean(baseRawMaterialDefinitionId)) + Number(Boolean(recipeDefinitionVersionId)) !==
      1
    ) {
      throw new BadRequestException({
        code: 'RESERVE_ROLL_MATERIAL_SELECTION_INVALID',
        message: 'Выберите ровно один вид сырья или одну рецептуру.',
      });
    }
    return {
      operationKey: dto.operationKey,
      rollCode: normalizeText(dto.rollCode, 'Код рулона'),
      batchCode: normalizeText(dto.batchCode, 'Партия'),
      filmType: normalizeText(dto.filmType, 'Тип плёнки'),
      actualThicknessMicron: dto.actualThicknessMicron,
      accountingThicknessMicron: dto.accountingThicknessMicron,
      widthMm: dto.widthMm,
      plannedLengthM: dto.plannedLengthM,
      grossKg: dto.grossKg,
      spoolKg: dto.spoolKg,
      plannedNetKg: dto.plannedNetKg,
      spoolType: normalizeText(dto.spoolType, 'Шпуля'),
      birka: normalizeText(dto.birka, 'Бирка'),
      baseRawMaterialDefinitionId,
      recipeDefinitionVersionId,
    };
  }

  private replay(
    stored: { requestFingerprint: string; resultSnapshot: Prisma.JsonValue },
    fingerprint: string,
  ): WarehouseReserveRollResponseDto {
    if (stored.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'RESERVE_ROLL_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже относится к другому рулону.',
      });
    }
    return reserveRollResult(stored.resultSnapshot);
  }

  private async getOrCreateBatch(
    tx: Prisma.TransactionClient,
    actor: Actor,
    batchCode: string,
    identity: { orderNumber: string; title: string },
  ) {
    const existing = await tx.commercialOrder.findUnique({
      where: { stockBatchCode: batchCode },
      select: {
        id: true,
        orderNumber: true,
        title: true,
        requestType: true,
        counterpartyId: true,
      },
    });
    if (existing) {
      if (
        existing.orderNumber !== identity.orderNumber ||
        existing.title !== identity.title ||
        existing.requestType !== 'stock_reserve' ||
        existing.counterpartyId !== null
      ) {
        throw new ConflictException({
          code: 'RESERVE_ROLL_BATCH_CONFLICT',
          message: 'Партия уже используется другим производственным источником.',
        });
      }
      return existing;
    }
    return tx.commercialOrder.create({
      data: {
        orderNumber: identity.orderNumber,
        title: identity.title,
        creatorRole: actor.role,
        requestType: 'stock_reserve',
        stockBatchCode: batchCode,
        productionIndicator: 'ready',
        warehouseCoverStatus: 'full_confirmed',
        paymentStatus: 'not_applicable',
        shipmentStatus: 'not_applicable',
        recipeOwnerRole: actor.role,
        commercialConfirmationPolicy: 'bypassed_by_delegation',
        commercialStage: 'in_work',
      },
      select: {
        id: true,
        orderNumber: true,
        title: true,
        requestType: true,
        counterpartyId: true,
      },
    });
  }
}
