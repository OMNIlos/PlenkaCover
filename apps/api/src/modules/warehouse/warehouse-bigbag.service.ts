import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BIG_BAG_MATERIAL_PRESETS,
  type BigBagCompositionItem,
  type BigBagLabelPrintView,
  type BigBagLocation,
  type BigBagMaterialPresetId,
  type BigBagMovementResult,
  type Role,
  type WarehouseBigBagView,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { valueBigBag } from '../../common/money/big-bag-valuation';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RecipeCatalogService } from '../material-catalog/recipe-catalog.service';
import { allocateRecipeWeight } from '../material-catalog/recipe-weight-allocation';
import type { CreateBigBagDto, MoveBigBagDto } from './dto/bigbag.dto';

type BigBagActor = {
  userId: string | null;
  role: Role;
};

type BigBagStockRow = {
  id: string;
  materialId: string;
  label: string;
  actualQty: number;
  rawMaterialDefinitionId: string | null;
};

type ResolvedBigBagIngredient = {
  allocationKey: string;
  rawMaterialDefinitionId: string | null;
  name: string;
  shareBasisPoints: number;
  stock?: BigBagStockRow;
};

type ResolvedBigBagSelection = {
  kind: 'legacy' | 'material' | 'recipe';
  name: string;
  baseRawMaterialDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeName: string | null;
  recipeVersionNumber: number | null;
  ingredients: ResolvedBigBagIngredient[];
};

type BigBagPriceSnapshot = {
  priceKopecksPerKg: number | null;
  priceSource: string | null;
  priceEffectiveAt: Date | null;
};

type BigBagSelector =
  | { kind: 'preset'; id: BigBagMaterialPresetId }
  | { kind: 'legacy'; id: string }
  | { kind: 'material'; id: string }
  | { kind: 'recipe'; id: string };

function roundKg(value: number): number {
  return Number(value.toFixed(3));
}

function roundPercent(value: number): number {
  return Number(value.toFixed(3));
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : null;
}

const bigBagViewSelect = {
  id: true,
  code: true,
  material: true,
  materialId: true,
  materialSelectionKind: true,
  materialPreset: true,
  baseRawMaterialDefinitionId: true,
  recipeDefinitionVersionId: true,
  recipeName: true,
  recipeVersionNumber: true,
  supplierName: true,
  receivedAt: true,
  composition: true,
  status: true,
  registrationStatus: true,
  location: true,
  locationRevision: true,
  initialKg: true,
  currentKg: true,
  lastMeasuredKg: true,
  lastActorRole: true,
  lastMeasuredAt: true,
  machineId: true,
  lastWarehouseMeasuredKg: true,
  lastWarehouseMeasuredAt: true,
  priceKopecksPerKg: true,
  priceSource: true,
  priceEffectiveAt: true,
  createdByRole: true,
  createdAt: true,
  printJobs: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
    select: {
      id: true,
      requestId: true,
      bigBagId: true,
      printerId: true,
      channel: true,
      status: true,
      reason: true,
      replacesPrintJobId: true,
      gatewayCommandId: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} satisfies Prisma.BigBagUnitSelect;

type BigBagViewRow = Prisma.BigBagUnitGetPayload<{ select: typeof bigBagViewSelect }>;

function projectBigBag(row: BigBagViewRow): WarehouseBigBagView {
  const valuation = valueBigBag({
    kg: row.currentKg ?? row.lastMeasuredKg ?? row.initialKg ?? 0,
    priceKopecksPerKg: row.priceKopecksPerKg,
  });
  return {
    id: row.id,
    code: row.code,
    material: row.material,
    materialId: row.materialId,
    materialSelectionKind:
      row.materialSelectionKind as WarehouseBigBagView['materialSelectionKind'],
    materialPreset: row.materialPreset as WarehouseBigBagView['materialPreset'],
    baseRawMaterialDefinitionId: row.baseRawMaterialDefinitionId,
    recipeDefinitionVersionId: row.recipeDefinitionVersionId,
    recipeName: row.recipeName,
    recipeVersionNumber: row.recipeVersionNumber,
    supplierName: row.supplierName ?? null,
    receivedAt: toIso(row.receivedAt),
    composition: row.composition as BigBagCompositionItem[],
    status: row.status as WarehouseBigBagView['status'],
    registrationStatus: row.registrationStatus as WarehouseBigBagView['registrationStatus'],
    location: row.location as WarehouseBigBagView['location'],
    locationRevision: row.locationRevision,
    initialKg: row.initialKg,
    currentKg: row.currentKg,
    lastMeasuredKg: row.lastMeasuredKg,
    lastActorRole: row.lastActorRole as WarehouseBigBagView['lastActorRole'],
    lastMeasuredAt: toIso(row.lastMeasuredAt),
    machineId: row.machineId,
    lastWarehouseMeasuredKg: row.lastWarehouseMeasuredKg,
    lastWarehouseMeasuredAt: toIso(row.lastWarehouseMeasuredAt),
    ...valuation,
    priceSource: row.priceSource,
    priceEffectiveAt: toIso(row.priceEffectiveAt),
    createdByRole: row.createdByRole as WarehouseBigBagView['createdByRole'],
    createdAt: toIso(row.createdAt) ?? '',
    latestLabelPrint: row.printJobs?.[0]
      ? {
          ...row.printJobs[0],
          channel: row.printJobs[0].channel as BigBagLabelPrintView['channel'],
          status: row.printJobs[0].status as BigBagLabelPrintView['status'],
          createdAt: row.printJobs[0].createdAt.toISOString(),
          updatedAt: row.printJobs[0].updatedAt.toISOString(),
        }
      : null,
  };
}

@Injectable()
export class WarehouseBigBagService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recipes: RecipeCatalogService,
  ) {}

  async list(): Promise<WarehouseBigBagView[]> {
    const rows = await this.prisma.bigBagUnit.findMany({
      where: {
        status: { in: ['available', 'in_use'] },
        OR: [{ status: 'in_use' }, { currentKg: { gt: 0 } }, { currentKg: null }],
      },
      orderBy: { code: 'asc' },
      select: bigBagViewSelect,
    });
    return rows.map(projectBigBag);
  }

  async create(actor: BigBagActor, dto: CreateBigBagDto) {
    const weightKg = roundKg(dto.weightKg);
    if (!Number.isFinite(weightKg) || !(weightKg > 0)) {
      throw new ConflictException('Вес мешка должен быть положительным.');
    }
    const selector = this.selector(dto);
    const price = this.priceSnapshot(dto.priceKopecksPerKg);
    const batchCode = dto.batchCode?.trim() || null;
    const supplierName = dto.supplierName?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      if (selector.kind === 'preset') {
        return this.createPreset(
          tx,
          actor,
          selector.id,
          weightKg,
          price,
          batchCode,
          supplierName,
          dto.code?.trim(),
        );
      }
      if (selector.kind === 'material') {
        return this.createCatalogMaterial(
          tx,
          actor,
          selector.id,
          weightKg,
          price,
          batchCode,
          supplierName,
          dto.code?.trim(),
        );
      }
      const selection = await this.resolveSelection(tx, selector);
      const code =
        dto.code?.trim() ||
        (await this.nextCode(tx, selector.kind === 'legacy' ? selector.id : selection.name));
      const allocation = allocateRecipeWeight(
        weightKg,
        selection.ingredients.map((ingredient) => ({
          rawMaterialDefinitionId: ingredient.allocationKey,
          shareBasisPoints: ingredient.shareBasisPoints,
        })),
      );
      const plannedByKey = new Map(
        allocation.map((item) => [item.rawMaterialDefinitionId, item.plannedNeedKg]),
      );
      const zeroComponent = allocation.find((item) => item.plannedNeedKg <= 0);
      if (zeroComponent) {
        throw new BadRequestException({
          code: 'BIGBAG_WEIGHT_BELOW_RECIPE_PRECISION',
          message:
            'Увеличьте массу Big-Bag: каждый компонент рецептуры должен составлять ' +
            'не менее 0,001 кг.',
        });
      }
      const definitionIds = selection.ingredients.flatMap((ingredient) =>
        ingredient.rawMaterialDefinitionId ? [ingredient.rawMaterialDefinitionId] : [],
      );
      const stockRows =
        definitionIds.length > 0
          ? await tx.rawMaterialStock.findMany({
              where: { rawMaterialDefinitionId: { in: definitionIds } },
              select: {
                id: true,
                materialId: true,
                label: true,
                actualQty: true,
                rawMaterialDefinitionId: true,
              },
            })
          : [];
      const stockByDefinitionId = new Map(
        stockRows.map((stock) => [stock.rawMaterialDefinitionId, stock]),
      );
      const components = selection.ingredients.map((ingredient) => {
        const stock =
          ingredient.stock ??
          (ingredient.rawMaterialDefinitionId
            ? stockByDefinitionId.get(ingredient.rawMaterialDefinitionId)
            : undefined);
        if (!stock) {
          throw new ConflictException({
            code: 'BIGBAG_MATERIAL_STOCK_MISSING',
            message:
              `Для сырья «${ingredient.name}» нет складского остатка. ` +
              'Сначала оприходуйте гранулы.',
          });
        }
        const initialKg = plannedByKey.get(ingredient.allocationKey) ?? 0;
        if (stock.actualQty < initialKg) {
          throw new ConflictException(
            `Недостаточно сырья «${ingredient.name}»: доступно ${stock.actualQty} кг, ` +
              `нужно ${initialKg} кг.`,
          );
        }
        return {
          stock,
          snapshot: {
            rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
            materialId: stock.materialId,
            name: ingredient.name,
            shareBasisPoints: ingredient.shareBasisPoints,
            initialKg,
          } satisfies BigBagCompositionItem & Prisma.InputJsonObject,
        };
      });

      const stockChanges = [];
      const deductionOrder = [...components].sort((left, right) =>
        left.stock.id === right.stock.id ? 0 : left.stock.id < right.stock.id ? -1 : 1,
      );
      for (const component of deductionOrder) {
        const [updated] = await tx.rawMaterialStock.updateManyAndReturn({
          where: {
            id: component.stock.id,
            actualQty: { gte: component.snapshot.initialKg },
          },
          data: { actualQty: { decrement: component.snapshot.initialKg } },
          select: { actualQty: true },
        });
        if (!updated) {
          throw new ConflictException(
            `Недостаточно сырья «${component.snapshot.name}» — ` +
              'остаток изменился параллельной операцией.',
          );
        }
        stockChanges.push({
          materialId: component.stock.materialId,
          name: component.snapshot.name,
          actualQty: roundKg(updated.actualQty + component.snapshot.initialKg),
          nextActualQty: roundKg(updated.actualQty),
          deductedKg: component.snapshot.initialKg,
        });
      }

      const composition = components.map((component) => component.snapshot);
      const bag = await tx.bigBagUnit.create({
        data: {
          code,
          material: selection.name,
          batchCode,
          materialId: selection.kind === 'recipe' ? null : composition[0]?.materialId,
          materialSelectionKind: selection.kind,
          baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
          recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
          recipeName: selection.recipeName,
          recipeVersionNumber: selection.recipeVersionNumber,
          supplierName,
          receivedAt: null,
          composition,
          initialKg: weightKg,
          currentKg: weightKg,
          lastMeasuredKg: weightKg,
          lastActorRole: actor.role,
          lastMeasuredAt: new Date(),
          ...price,
          status: 'available',
          ...this.pendingLifecycle(),
          createdByRole: actor.role,
        },
        select: bigBagViewSelect,
      });

      const singleChange = stockChanges.length === 1 ? stockChanges[0] : null;
      const valuation = valueBigBag({
        kg: weightKg,
        priceKopecksPerKg: price.priceKopecksPerKg,
      });
      await this.audit.record(
        {
          type: 'audit:bigbag_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: bag.code,
          oldValue: singleChange
            ? { actualQty: singleChange.actualQty }
            : {
                components: stockChanges.map(({ materialId, name, actualQty }) => ({
                  materialId,
                  name,
                  actualQty,
                })),
              },
          newValue: singleChange
            ? {
                actualQty: singleChange.nextActualQty,
                bagCode: bag.code,
                weightKg,
                supplierName,
                ...valuation,
              }
            : {
                components: stockChanges.map(({ materialId, name, nextActualQty, deductedKg }) => ({
                  materialId,
                  name,
                  actualQty: nextActualQty,
                  deductedKg,
                })),
                bagCode: bag.code,
                weightKg,
                supplierName,
                ...valuation,
              },
          detail: {
            materialSelectionKind: selection.kind,
            baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
            recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
            recipeVersionNumber: selection.recipeVersionNumber,
            batchCode,
            supplierName,
            composition,
          },
        },
        tx,
      );
      return projectBigBag(bag);
    });
  }

  async move(actor: BigBagActor, dto: MoveBigBagDto): Promise<BigBagMovementResult> {
    const warehouseWeightKg =
      dto.warehouseWeightKg === undefined ? null : roundKg(dto.warehouseWeightKg);
    const fingerprint = requestFingerprint({
      qrCode: dto.qrCode,
      destination: dto.destination,
      warehouseWeightKg,
    });

    const replay = await this.prisma.bigBagMovement.findUnique({
      where: { operationKey: dto.operationKey },
      select: { requestFingerprint: true, resultSnapshot: true },
    });
    if (replay) return this.replayMovement(replay, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const concurrentReplay = await tx.bigBagMovement.findUnique({
          where: { operationKey: dto.operationKey },
          select: { requestFingerprint: true, resultSnapshot: true },
        });
        if (concurrentReplay) return this.replayMovement(concurrentReplay, fingerprint);

        const scanToken = await tx.bigBagScanToken.findUnique({
          where: { token: dto.qrCode },
          select: { bigBagId: true },
        });
        if (!scanToken) {
          throw new NotFoundException({
            code: 'BIGBAG_QR_UNKNOWN',
            message: 'QR-код Big-Bag не найден.',
          });
        }

        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "big_bag_units" WHERE "id" = ${scanToken.bigBagId} FOR UPDATE`,
        );
        const bag = await tx.bigBagUnit.findUnique({
          where: { id: scanToken.bigBagId },
          select: bigBagViewSelect,
        });
        if (!bag) {
          throw new NotFoundException({
            code: 'BIGBAG_NOT_FOUND',
            message: 'Big-Bag не найден.',
          });
        }

        const now = new Date();
        const transition = await this.resolveMovement(
          tx,
          bag,
          dto.destination,
          warehouseWeightKg,
          now,
        );
        const updated = await tx.bigBagUnit.update({
          where: { id: bag.id },
          data: {
            ...transition.update,
            locationRevision: bag.locationRevision + 1,
          },
          select: bigBagViewSelect,
        });
        const result = {
          bag: projectBigBag(updated),
          movement: {
            kind: transition.kind,
            fromLocation: transition.fromLocation,
            toLocation: dto.destination,
            locationRevision: updated.locationRevision,
            createdAt: now.toISOString(),
          },
          weightComparison: transition.weightComparison,
        } satisfies BigBagMovementResult;

        await tx.bigBagMovement.create({
          data: {
            bigBagId: bag.id,
            operationKey: dto.operationKey,
            requestFingerprint: fingerprint,
            kind: transition.kind,
            fromLocation: transition.fromLocation,
            toLocation: dto.destination,
            locationRevision: updated.locationRevision,
            operatorReportedKg: transition.weightComparison?.operatorReportedKg,
            warehouseMeasuredKg: transition.weightComparison?.warehouseMeasuredKg,
            differenceKg: transition.weightComparison?.differenceKg,
            differencePercent: transition.weightComparison?.differencePercent,
            actorId: actor.userId,
            actorRole: actor.role,
            resultSnapshot: result as unknown as Prisma.InputJsonValue,
            createdAt: now,
          },
        });

        await this.recordMovementAudit(tx, actor, bag, result);
        return result;
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const winner = await this.prisma.bigBagMovement.findUnique({
        where: { operationKey: dto.operationKey },
        select: { requestFingerprint: true, resultSnapshot: true },
      });
      if (winner) return this.replayMovement(winner, fingerprint);
      throw error;
    }
  }

  private selector(dto: CreateBigBagDto): BigBagSelector {
    const candidates: BigBagSelector[] = [];
    if (dto.materialPreset) candidates.push({ kind: 'preset', id: dto.materialPreset });
    const materialId = dto.materialId?.trim();
    const baseRawMaterialDefinitionId = dto.baseRawMaterialDefinitionId?.trim();
    const recipeDefinitionVersionId = dto.recipeDefinitionVersionId?.trim();
    if (materialId) candidates.push({ kind: 'legacy', id: materialId });
    if (baseRawMaterialDefinitionId) {
      candidates.push({ kind: 'material', id: baseRawMaterialDefinitionId });
    }
    if (recipeDefinitionVersionId) {
      candidates.push({ kind: 'recipe', id: recipeDefinitionVersionId });
    }
    if (candidates.length !== 1) {
      throw new BadRequestException({
        code: 'BIGBAG_MATERIAL_SELECTION_INVALID',
        message: 'Выберите ровно один вид сырья или одну рецептуру.',
      });
    }
    return candidates[0];
  }

  private async createPreset(
    tx: Prisma.TransactionClient,
    actor: BigBagActor,
    presetId: BigBagMaterialPresetId,
    weightKg: number,
    price: BigBagPriceSnapshot,
    batchCode: string | null,
    supplierName: string | null,
    requestedCode?: string,
  ) {
    const preset = BIG_BAG_MATERIAL_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) {
      throw new BadRequestException({
        code: 'BIGBAG_MATERIAL_PRESET_INVALID',
        message: 'Выберите один из доступных видов сырья.',
      });
    }
    const code = requestedCode || (await this.nextCode(tx, preset.label));
    const composition = [
      {
        rawMaterialDefinitionId: null,
        materialId: `bigbag-preset:${preset.id}`,
        name: preset.label,
        shareBasisPoints: 10_000,
        initialKg: weightKg,
      } satisfies BigBagCompositionItem & Prisma.InputJsonObject,
    ];
    const bag = await tx.bigBagUnit.create({
      data: {
        code,
        material: preset.label,
        batchCode,
        materialId: null,
        materialSelectionKind: 'preset',
        materialPreset: preset.id,
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeName: null,
        recipeVersionNumber: null,
        supplierName,
        receivedAt: null,
        composition,
        initialKg: weightKg,
        currentKg: weightKg,
        lastMeasuredKg: weightKg,
        lastActorRole: actor.role,
        lastMeasuredAt: new Date(),
        ...price,
        status: 'available',
        ...this.pendingLifecycle(),
        createdByRole: actor.role,
      },
      select: bigBagViewSelect,
    });
    const valuation = valueBigBag({
      kg: weightKg,
      priceKopecksPerKg: price.priceKopecksPerKg,
    });
    await this.audit.record(
      {
        type: 'audit:bigbag_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: bag.code,
        oldValue: { registered: false },
        newValue: {
          registered: false,
          bagCode: bag.code,
          material: preset.label,
          weightKg,
          supplierName,
          ...valuation,
        },
        detail: {
          materialSelectionKind: 'preset',
          materialPreset: preset.id,
          batchCode,
          supplierName,
          manualWarehouseFact: true,
          composition,
        },
      },
      tx,
    );
    return projectBigBag(bag);
  }

  private async createCatalogMaterial(
    tx: Prisma.TransactionClient,
    actor: BigBagActor,
    materialDefinitionId: string,
    weightKg: number,
    price: BigBagPriceSnapshot,
    batchCode: string | null,
    supplierName: string | null,
    requestedCode?: string,
  ) {
    const material = await tx.rawMaterialDefinition.findUnique({
      where: { id: materialDefinitionId },
      select: {
        id: true,
        name: true,
        status: true,
        isProductionSelectable: true,
      },
    });
    if (!material || material.status !== 'active' || !material.isProductionSelectable) {
      throw new ConflictException({
        code: 'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
        message: 'Выбранный вид сырья больше недоступен.',
      });
    }

    const code = requestedCode || (await this.nextCode(tx, material.name));
    const composition = [
      {
        rawMaterialDefinitionId: material.id,
        materialId: `bigbag-material:${material.id}`,
        name: material.name,
        shareBasisPoints: 10_000,
        initialKg: weightKg,
      } satisfies BigBagCompositionItem & Prisma.InputJsonObject,
    ];
    const bag = await tx.bigBagUnit.create({
      data: {
        code,
        material: material.name,
        batchCode,
        materialId: null,
        materialSelectionKind: 'material',
        materialPreset: null,
        baseRawMaterialDefinitionId: material.id,
        recipeDefinitionVersionId: null,
        recipeName: null,
        recipeVersionNumber: null,
        supplierName,
        receivedAt: null,
        composition,
        initialKg: weightKg,
        currentKg: weightKg,
        lastMeasuredKg: weightKg,
        lastActorRole: actor.role,
        lastMeasuredAt: new Date(),
        ...price,
        status: 'available',
        ...this.pendingLifecycle(),
        createdByRole: actor.role,
      },
      select: bigBagViewSelect,
    });
    const valuation = valueBigBag({
      kg: weightKg,
      priceKopecksPerKg: price.priceKopecksPerKg,
    });
    await this.audit.record(
      {
        type: 'audit:bigbag_created',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: bag.code,
        oldValue: { registered: false },
        newValue: {
          registered: false,
          bagCode: bag.code,
          material: material.name,
          weightKg,
          supplierName,
          ...valuation,
        },
        detail: {
          materialSelectionKind: 'material',
          baseRawMaterialDefinitionId: material.id,
          batchCode,
          supplierName,
          manualWarehouseFact: true,
          composition,
        },
      },
      tx,
    );
    return projectBigBag(bag);
  }

  private pendingLifecycle() {
    return {
      registrationStatus: 'pending_scan',
      location: 'warehouse',
      locationRevision: 0,
      scanToken: {
        create: {
          token: `bbt_${randomBytes(32).toString('hex')}`,
        },
      },
    } as const;
  }

  private priceSnapshot(priceKopecksPerKg: number | undefined): BigBagPriceSnapshot {
    if (priceKopecksPerKg === undefined) {
      return {
        priceKopecksPerKg: null,
        priceSource: null,
        priceEffectiveAt: null,
      };
    }
    if (!Number.isSafeInteger(priceKopecksPerKg) || priceKopecksPerKg < 0) {
      throw new BadRequestException({
        code: 'BIGBAG_PRICE_INVALID',
        message: 'Цена за килограмм должна быть целым неотрицательным числом копеек.',
      });
    }
    return {
      priceKopecksPerKg,
      priceSource: 'manual_warehouse',
      priceEffectiveAt: new Date(),
    };
  }

  private async resolveMovement(
    tx: Prisma.TransactionClient,
    bag: BigBagViewRow,
    destination: BigBagLocation,
    warehouseWeightKg: number | null,
    now: Date,
  ): Promise<{
    kind: BigBagMovementResult['movement']['kind'];
    fromLocation: BigBagLocation | null;
    update: Prisma.BigBagUnitUpdateInput;
    weightComparison: BigBagMovementResult['weightComparison'];
  }> {
    if (bag.registrationStatus === 'pending_scan') {
      if (destination !== 'warehouse' || warehouseWeightKg !== null) {
        throw new ConflictException({
          code: 'BIGBAG_REGISTRATION_SCAN_REQUIRED',
          message: 'Сначала подтвердите создание Big-Bag на складе.',
        });
      }
      return {
        kind: 'registration',
        fromLocation: null,
        update: {
          registrationStatus: 'registered',
          location: 'warehouse',
          receivedAt: now,
        },
        weightComparison: null,
      };
    }

    if (bag.location === destination) {
      throw new ConflictException({
        code: 'BIGBAG_ALREADY_IN_LOCATION',
        message:
          destination === 'warehouse'
            ? 'Big-Bag уже находится на складе.'
            : 'Big-Bag уже находится на производстве.',
      });
    }

    if (destination === 'production') {
      if (warehouseWeightKg !== null) {
        throw new ConflictException({
          code: 'BIGBAG_WAREHOUSE_WEIGHT_NOT_EXPECTED',
          message: 'Контрольный вес вводится только при возврате на склад.',
        });
      }
      if (bag.status === 'consumed') {
        throw new ConflictException({
          code: 'BIGBAG_CONSUMED',
          message: 'Израсходованный Big-Bag нельзя передать в производство.',
        });
      }
      return {
        kind: 'to_production',
        fromLocation: 'warehouse',
        update: { location: 'production' },
        weightComparison: null,
      };
    }

    const openUsages = await tx.shiftBagUsage.count({
      where: { bigBagId: bag.id, closedAt: null },
    });
    if (bag.status === 'in_use' || openUsages > 0) {
      throw new ConflictException({
        code: 'BIGBAG_IN_USE',
        message: 'Сначала оператор должен сдать Big-Bag.',
      });
    }
    if (warehouseWeightKg === null) {
      throw new ConflictException({
        code: 'BIGBAG_WAREHOUSE_WEIGHT_REQUIRED',
        message: 'Укажите контрольный вес Big-Bag при возврате на склад.',
      });
    }

    const operatorReportedKg = bag.currentKg ?? bag.lastMeasuredKg ?? 0;
    if (warehouseWeightKg > operatorReportedKg) {
      throw new ConflictException({
        code: 'BIGBAG_WAREHOUSE_WEIGHT_INCREASE',
        message: 'Вес при приёмке не может быть больше предыдущего веса Big-Bag.',
        previousKg: operatorReportedKg,
        warehouseWeightKg,
      });
    }
    const differenceKg = roundKg(warehouseWeightKg - operatorReportedKg);
    const differencePercent =
      operatorReportedKg > 0 ? roundPercent((differenceKg / operatorReportedKg) * 100) : null;
    return {
      kind: 'to_warehouse',
      fromLocation: 'production',
      update: {
        location: 'warehouse',
        currentKg: warehouseWeightKg,
        lastMeasuredKg: warehouseWeightKg,
        lastMeasuredAt: now,
        lastActorRole: 'warehouse',
        lastWarehouseMeasuredKg: warehouseWeightKg,
        lastWarehouseMeasuredAt: now,
        status: warehouseWeightKg === 0 ? 'consumed' : 'available',
      },
      weightComparison: {
        operatorReportedKg,
        warehouseMeasuredKg: warehouseWeightKg,
        differenceKg,
        differencePercent,
      },
    };
  }

  private async recordMovementAudit(
    tx: Prisma.TransactionClient,
    actor: BigBagActor,
    previous: BigBagViewRow,
    result: BigBagMovementResult,
  ): Promise<void> {
    const eventType =
      result.movement.kind === 'registration'
        ? 'audit:bigbag_registration_confirmed'
        : result.movement.kind === 'to_production'
          ? 'audit:bigbag_moved_to_production'
          : 'audit:bigbag_returned_to_warehouse';
    await this.audit.record(
      {
        type: eventType,
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: previous.code,
        oldValue: {
          registrationStatus: previous.registrationStatus,
          location: result.movement.fromLocation,
          locationRevision: previous.locationRevision,
          receivedAt: toIso(previous.receivedAt),
        },
        newValue: {
          registrationStatus: result.bag.registrationStatus,
          location: result.bag.location,
          locationRevision: result.bag.locationRevision,
          receivedAt: result.bag.receivedAt,
        },
        detail: { movementKind: result.movement.kind },
      },
      tx,
    );
    await this.audit.record(
      {
        type: 'audit:bigbag_scan_recorded',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: previous.code,
        detail: {
          movementKind: result.movement.kind,
          destination: result.movement.toLocation,
          locationRevision: result.movement.locationRevision,
        },
      },
      tx,
    );
    if (result.weightComparison) {
      await this.audit.record(
        {
          type: 'audit:bigbag_warehouse_weight_recorded',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: previous.code,
          oldValue: { weightKg: result.weightComparison.operatorReportedKg },
          newValue: { weightKg: result.weightComparison.warehouseMeasuredKg },
          detail: {
            differenceKg: result.weightComparison.differenceKg,
            differencePercent: result.weightComparison.differencePercent,
          },
        },
        tx,
      );
    }
  }

  private replayMovement(
    row: { requestFingerprint: string; resultSnapshot: Prisma.JsonValue },
    fingerprint: string,
  ): BigBagMovementResult {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'BIGBAG_OPERATION_KEY_CONFLICT',
        message: 'Этот operationKey уже использован для другого перемещения.',
      });
    }
    const result = row.resultSnapshot as unknown as BigBagMovementResult;
    return {
      ...result,
      bag: {
        ...result.bag,
        supplierName: result.bag.supplierName ?? null,
        receivedAt: result.bag.receivedAt ?? null,
      },
    };
  }

  private async resolveSelection(
    tx: Prisma.TransactionClient,
    selector: BigBagSelector,
  ): Promise<ResolvedBigBagSelection> {
    if (selector.kind === 'legacy') {
      const stock = await tx.rawMaterialStock.findUnique({
        where: { materialId: selector.id },
        select: {
          id: true,
          materialId: true,
          label: true,
          actualQty: true,
          rawMaterialDefinitionId: true,
        },
      });
      if (!stock) throw new NotFoundException(`Raw material ${selector.id} not found`);
      return {
        kind: 'legacy',
        name: stock.label,
        baseRawMaterialDefinitionId: null,
        recipeDefinitionVersionId: null,
        recipeName: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            allocationKey: stock.rawMaterialDefinitionId ?? `legacy:${stock.materialId}`,
            rawMaterialDefinitionId: stock.rawMaterialDefinitionId,
            name: stock.label,
            shareBasisPoints: 10_000,
            stock,
          },
        ],
      };
    }

    if (selector.kind === 'material') {
      const material = await tx.rawMaterialDefinition.findUnique({
        where: { id: selector.id },
        select: { id: true, name: true, status: true },
      });
      if (!material || material.status !== 'active') {
        throw new ConflictException({
          code: 'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
          message: 'Выбранный вид сырья больше недоступен.',
        });
      }
      return {
        kind: 'material',
        name: material.name,
        baseRawMaterialDefinitionId: material.id,
        recipeDefinitionVersionId: null,
        recipeName: null,
        recipeVersionNumber: null,
        ingredients: [
          {
            allocationKey: material.id,
            rawMaterialDefinitionId: material.id,
            name: material.name,
            shareBasisPoints: 10_000,
          },
        ],
      };
    }

    const [recipe] = await this.recipes.resolveSelections(tx, [
      { recipeDefinitionVersionId: selector.id },
    ]);
    if (!recipe) {
      throw new ConflictException('Выбранная рецептура больше недоступна.');
    }
    return {
      kind: 'recipe',
      name: recipe.name,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: recipe.recipeDefinitionVersionId,
      recipeName: recipe.name,
      recipeVersionNumber: recipe.version,
      ingredients: recipe.ingredients.map((ingredient) => ({
        allocationKey: ingredient.rawMaterialDefinitionId,
        rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
        name: ingredient.name,
        shareBasisPoints: ingredient.shareBasisPoints,
      })),
    };
  }

  private async nextCode(tx: Prisma.TransactionClient, materialIdentity: string): Promise<string> {
    const token =
      materialIdentity
        .replace(/^rm-/u, '')
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 24)
        .toUpperCase() || 'MATERIAL';
    const base = `BB-${token}`;
    const count = await tx.bigBagUnit.count({
      where: { code: { startsWith: base } },
    });
    for (let n = count + 1; n < count + 50; n += 1) {
      const code = `${base}-${String(n).padStart(2, '0')}`;
      const exists = await tx.bigBagUnit.findUnique({ where: { code } });
      if (!exists) return code;
    }
    return `${base}-${Date.now()}`;
  }
}
