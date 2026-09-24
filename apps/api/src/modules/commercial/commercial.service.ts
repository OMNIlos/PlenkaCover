import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  CommercialBucket,
  CommercialQueueMode,
  PositionMaterialSelection,
  RecipeIngredientShare,
  Role,
  CommercialOrderComment,
  WarehouseCoverRequestResult,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import {
  COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE,
  invoiceLocksCommercialParameters,
  lockInvoiceBoundaryForCommercialOrder,
} from '../../common/invoice-boundary/commercial-invoice-boundary';
import { projectCounterparty, projectStockProductionTemplate } from './projection';
import { financeAllowsProduction } from '../finance/payment-production-gate';
import {
  acquireWarehouseCoverCase,
  assertWarehouseCoverActionable,
  projectWarehouseCoverRequestCase,
  projectWarehouseCoverRequestOrder,
  WAREHOUSE_COVER_ACTIONABLE_WHERE,
  withWarehouseCoverCaseTransaction,
} from '../../common/warehouse-cover-task';
import type { CreateOrderDto, CreatePositionDto, RecipeParamDto } from './dto/create-order.dto';
import type { UpdatePositionDto } from './dto/update-position.dto';
import type { UpdateOrderCommentDto } from './dto/update-order-comment.dto';
import type { RejectCoverDto } from './dto/cover-decision.dto';
import type { CreateCorrectionDto } from './dto/correction.dto';
import type { InvoiceHandoffDto } from './dto/invoice-handoff.dto';
import type { ForceProductionDto } from './dto/force-production.dto';
import type { WarehouseCoverRouteDto } from './dto/warehouse-cover-route.dto';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import {
  RecipeCatalogService,
  type ResolvedRecipeSelection,
} from '../material-catalog/recipe-catalog.service';
import { RUNTIME_CONFIG } from '../../common/runtime-config.module';
import type { RuntimeConfig } from '../../common/runtime-config';
import {
  assertCoverageWorkflow,
  validateV2CoverageCompleteness,
  workflowVersionForNewOrder,
} from '../warehouse-coverage/warehouse-coverage-workflow';
import type { WarehouseCoverageWorkflowVersion } from '@plenka/contracts';
import { WarehouseCoverageCalculationService } from '../warehouse-coverage/warehouse-coverage-calculation.service';
import { snapshotCounterpartyTemplatePosition } from './counterparty-template.service';
import {
  lockCommercialOrderAggregate,
  lockCoverageInventoryEpoch,
  WarehouseCoverageTransaction,
} from '../warehouse-coverage/warehouse-coverage-transaction';

export interface CommercialActor {
  userId: string | null;
  role: Role;
}

export interface CommercialListQuery {
  bucket: CommercialBucket;
  mode: CommercialQueueMode;
  limit: number;
}

type PositionFields = Omit<
  CreatePositionDto,
  'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'
>;

type CatalogOrderPosition = PositionFields &
  Pick<CreatePositionDto, 'baseRawMaterialDefinitionId' | 'recipeDefinitionVersionId'> & {
    origin: 'catalog';
  };

type LegacyTemplateOrderPosition = PositionFields & {
  origin: 'legacy_template';
  rawMaterialId?: string;
};

type ResolvedOrderPosition = CatalogOrderPosition | LegacyTemplateOrderPosition;

export function createOrderFingerprintInput(role: Role, dto: CreateOrderDto) {
  const comment = dto.comment?.trim();
  return {
    actorRole: role,
    title: dto.title?.trim() || null,
    commercialFinanceNote: dto.commercialFinanceNote?.trim() || null,
    ...(comment ? { comment } : {}),
    mode: dto.mode ?? 'submit',
    orderNumber: dto.orderNumber?.trim() || null,
    counterpartyId: dto.counterpartyId ?? null,
    requestType: dto.requestType,
    templateId: dto.templateId || null,
    templateVersionId: dto.templateVersionId || null,
    ...(dto.saveAsTemplate === true ? { saveAsTemplate: true } : {}),
    ...(dto.stockProductionTemplateId
      ? { stockProductionTemplateId: dto.stockProductionTemplateId }
      : {}),
    ...(dto.stockProductionTemplateVersionId
      ? { stockProductionTemplateVersionId: dto.stockProductionTemplateVersionId }
      : {}),
    onBehalfOfCommercial: role === 'production_lead' && dto.onBehalfOfCommercial === true,
    positions:
      dto.positions?.map((position) => ({
        rollCount: position.rollCount,
        filmType: position.filmType,
        actualThickness: position.actualThickness,
        accountingThickness: position.accountingThickness,
        baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId ?? null,
        recipeDefinitionVersionId: position.recipeDefinitionVersionId ?? null,
        spoolType: position.spoolType ?? null,
        birka: position.birka ?? null,
        ...(position.manualBirka?.trim() ? { manualBirka: position.manualBirka.trim() } : {}),
        comment: position.comment?.trim() || null,
        plannedWeightKg: position.plannedWeightKg ?? null,
        ...(position.widthMm !== undefined ? { widthMm: position.widthMm } : {}),
        ...(position.plannedLengthM !== undefined
          ? { plannedLengthM: position.plannedLengthM }
          : {}),
        recipeParameters: position.recipeParameters ?? [],
      })) ?? null,
  };
}

const ORDER_INCLUDE = {
  counterparty: true,
  positions: { include: { recipe: true } },
  coverProposals: true,
  problems: true,
  financeOrder: {
    select: {
      id: true,
      productionClearedAt: true,
      invoiceStatus: true,
      paymentStatus: true,
      paymentTermsType: true,
      policy: {
        select: {
          id: true,
          stages: { select: { id: true, trigger: true } },
        },
      },
      schedules: {
        where: { kind: { in: ['invoice_prepayment', 'post_delivery'] } },
        select: { paymentPolicyStageId: true, kind: true, status: true },
      },
    },
  },
  productionOrder: { select: { id: true } },
  stockProductionTemplateVersion: { select: { version: true } },
} satisfies Prisma.CommercialOrderInclude;

@Injectable()
export class CommercialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recipeCatalog: RecipeCatalogService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    private readonly coverageCalculation: WarehouseCoverageCalculationService,
    private readonly coverageTransaction: WarehouseCoverageTransaction,
  ) {}

  private assertCreateReplay(
    existing: { requestFingerprint: string | null },
    acceptedFingerprints: readonly string[],
  ) {
    if (
      existing.requestFingerprint === null ||
      !acceptedFingerprints.includes(existing.requestFingerprint)
    ) {
      throw new ConflictException({
        code: 'COMMERCIAL_REQUEST_ID_CONFLICT',
        message: 'Client request id is already bound to different order data.',
      });
    }
  }

  async listOrders(actorRole: Role, bucket?: string): Promise<unknown[]>;
  async listOrders(
    actorRole: Role,
    query: CommercialListQuery,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  async listOrders(
    actorRole: Role,
    bucketOrQuery?: string | CommercialListQuery,
  ): Promise<unknown[] | { items: unknown[]; nextCursor: string | null }> {
    const typedQuery = typeof bucketOrQuery === 'object' ? bucketOrQuery : null;
    const bucket = typedQuery?.bucket ?? bucketOrQuery;
    const bucketWhere: Prisma.CommercialOrderWhereInput =
      bucket === 'reserve'
        ? { requestType: 'stock_reserve' }
        : bucket === 'drafts' || bucket === 'draft'
          ? { commercialStage: 'draft' }
          : bucket === 'incoming'
            ? {
                commercialStage: { in: ['incoming', 'sent_to_finance'] },
                paymentStatus: { notIn: ['partial', 'paid'] },
              }
            : bucket === 'in_work'
              ? { commercialStage: 'in_work' }
              : {};
    const where: Prisma.CommercialOrderWhereInput =
      actorRole === 'commercial'
        ? bucketWhere
        : { AND: [bucketWhere, { commercialStage: { not: 'draft' } }] };
    const orders = await this.prisma.commercialOrder.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: typedQuery ? [{ updatedAt: 'desc' }, { id: 'desc' }] : { createdAt: 'desc' },
      ...(typedQuery ? { take: Math.min(Math.max(typedQuery.limit, 1), 100) + 1 } : {}),
    });
    const projected = orders.map((o) => this.project(o, actorRole));
    if (!typedQuery) return projected;

    const limit = Math.min(Math.max(typedQuery.limit, 1), 100);
    const hasNext = projected.length > limit;
    return {
      items: projected.slice(0, limit),
      nextCursor: hasNext ? (orders[limit - 1]?.id ?? null) : null,
    };
  }

  async getOrder(actorRole: Role, orderId: string) {
    const order = await this.prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.commercialStage === 'draft' && actorRole !== 'commercial') {
      throw new NotFoundException(`Order ${orderId} not found`);
    }
    return this.project(order, actorRole);
  }

  async createOrder(actor: CommercialActor, dto: CreateOrderDto) {
    const isStockOrder = dto.requestType === 'stock_reserve';
    const hasStockTemplateId = Boolean(dto.stockProductionTemplateId);
    const hasStockTemplateVersionId = Boolean(dto.stockProductionTemplateVersionId);
    if (isStockOrder && dto.counterpartyId !== undefined && dto.counterpartyId !== null) {
      throw new BadRequestException('stock_reserve must not use a counterparty');
    }
    if (!isStockOrder && !dto.counterpartyId) {
      throw new BadRequestException('counterpartyId is required for client_order');
    }
    if (!isStockOrder && (hasStockTemplateId || hasStockTemplateVersionId)) {
      throw new BadRequestException('client_order must not use a stock production template');
    }
    if (isStockOrder && (dto.templateId || dto.templateVersionId)) {
      throw new BadRequestException('stock_reserve must not use a counterparty template');
    }
    if (isStockOrder && dto.saveAsTemplate) {
      throw new BadRequestException('stock_reserve must not save a counterparty template');
    }
    if (isStockOrder && hasStockTemplateId !== hasStockTemplateVersionId) {
      throw new BadRequestException(
        'stock_reserve must provide both stock production template ids',
      );
    }
    const fingerprintInput = createOrderFingerprintInput(actor.role, dto);
    const fingerprint = requestFingerprint(fingerprintInput);
    const acceptedReplayFingerprints = [fingerprint];
    if (fingerprintInput.commercialFinanceNote === null) {
      acceptedReplayFingerprints.push(
        requestFingerprint({
          ...fingerprintInput,
          commercialFinanceNote: undefined,
        }),
      );
    }
    if (dto.clientRequestId) {
      const existing = await this.prisma.commercialOrder.findUnique({
        where: { clientRequestId: dto.clientRequestId },
        select: { id: true, requestFingerprint: true },
      });
      if (existing) {
        this.assertCreateReplay(existing, acceptedReplayFingerprints);
        return this.getOrder(actor.role, existing.id);
      }
    }
    const counterparty = dto.counterpartyId
      ? await this.prisma.counterparty.findUnique({
          where: { id: dto.counterpartyId },
        })
      : null;
    if (!isStockOrder && !counterparty) {
      throw new NotFoundException(`Counterparty ${dto.counterpartyId} not found`);
    }

    const delegated = actor.role === 'production_lead' && dto.onBehalfOfCommercial === true;
    const template = dto.templateId
      ? await this.prisma.counterpartyOrderTemplate.findFirst({
          where: { id: dto.templateId, counterpartyId: dto.counterpartyId!, status: 'active' },
          include: {
            versions: {
              ...(dto.templateVersionId ? { where: { id: dto.templateVersionId } } : {}),
              orderBy: { version: 'desc' },
              take: 1,
            },
          },
        })
      : null;
    if (dto.templateId && !template) {
      throw new NotFoundException(
        `Template ${dto.templateId} not found for counterparty ${dto.counterpartyId}`,
      );
    }
    const selectedTemplateVersion = template?.versions?.[0] ?? null;
    if (dto.templateVersionId && !selectedTemplateVersion) {
      throw new NotFoundException(
        `Template version ${dto.templateVersionId} not found for template ${dto.templateId}`,
      );
    }
    const templatePositions = selectedTemplateVersion?.positions ?? template?.positions;
    const resolvedPositions: ResolvedOrderPosition[] = dto.positions?.length
      ? dto.positions.map((position) => this.catalogPosition(position))
      : templatePositions
        ? this.positionsFromTemplate(templatePositions)
        : [];
    if (resolvedPositions.length === 0) {
      throw new BadRequestException('positions are required unless templateId is provided');
    }
    const recipeSource = template
      ? 'template'
      : actor.role === 'production_lead'
        ? 'production_lead_form'
        : 'commercial_form';
    const isDraft = dto.mode === 'draft';

    const orderNumber =
      dto.orderNumber?.trim() ||
      (await this.generateOrderNumber(isDraft ? 'D' : isStockOrder ? 'S' : 'A'));
    const stockBatchCode = isStockOrder ? `STOCK-${orderNumber}` : null;

    let created: { id: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const stockTemplate = dto.stockProductionTemplateId
          ? await tx.stockProductionTemplate.findFirst({
              where: { id: dto.stockProductionTemplateId, status: 'active' },
              select: {
                id: true,
                name: true,
                versions: {
                  where: { id: dto.stockProductionTemplateVersionId },
                  select: { id: true, version: true },
                  take: 1,
                },
              },
            })
          : null;
        if (dto.stockProductionTemplateId && !stockTemplate) {
          throw new NotFoundException(
            `Stock production template ${dto.stockProductionTemplateId} not found`,
          );
        }
        const stockTemplateVersion = stockTemplate?.versions[0] ?? null;
        if (dto.stockProductionTemplateVersionId && !stockTemplateVersion) {
          throw new NotFoundException(
            `Stock production template version ${dto.stockProductionTemplateVersionId} not found for template ${dto.stockProductionTemplateId}`,
          );
        }
        const warehouseCoverageWorkflowVersion = isStockOrder
          ? 1
          : workflowVersionForNewOrder(this.config.warehouseCoverageV2Enabled);
        const catalogPositions = resolvedPositions.filter(
          (position): position is CatalogOrderPosition => position.origin === 'catalog',
        );
        const resolvedSelections = catalogPositions.length
          ? await this.recipeCatalog.resolveSelections(
              tx,
              catalogPositions.map((position) => this.positionMaterialSelection(position)),
            )
          : [];
        if (resolvedSelections.length !== catalogPositions.length) {
          throw new InternalServerErrorException({
            code: 'RECIPE_SELECTION_RESOLUTION_INVARIANT',
            message: 'Recipe selection resolution returned an unexpected number of results.',
          });
        }
        const copiedSelections = resolvedSelections.map((selection) =>
          this.copySelection(selection),
        );
        let selectionIndex = 0;
        const preparedPositions = resolvedPositions.map((position) => ({
          position,
          selection: position.origin === 'catalog' ? copiedSelections[selectionIndex++]! : null,
        }));
        const order = await tx.commercialOrder.create({
          data: {
            orderNumber,
            warehouseCoverageWorkflowVersion,
            title: dto.title?.trim() || null,
            commercialFinanceNote:
              dto.requestType === 'client_order' ? dto.commercialFinanceNote?.trim() || null : null,
            comment: dto.comment?.trim() || null,
            clientRequestId: dto.clientRequestId,
            requestFingerprint: fingerprint,
            counterpartyId: dto.counterpartyId ?? null,
            counterpartyTemplateId: template?.id,
            counterpartyTemplateName: template?.name,
            counterpartyTemplateVersionId: selectedTemplateVersion?.id,
            stockProductionTemplateId: stockTemplate?.id,
            stockProductionTemplateName: stockTemplate?.name,
            stockProductionTemplateVersionId: stockTemplateVersion?.id,
            creatorRole: actor.role,
            requestType: dto.requestType,
            stockBatchCode,
            ...(isStockOrder
              ? {
                  productionIndicator: 'needs_production',
                  paymentStatus: 'not_applicable',
                  shipmentStatus: 'not_applicable',
                }
              : {}),
            // Recipe ownership stays commercial even on delegated creation (ТЗ §3).
            recipeOwnerRole: 'commercial',
            delegationMarker: delegated,
            commercialConfirmationPolicy: delegated ? 'bypassed_by_delegation' : 'required',
            commercialStage: isDraft ? 'draft' : isStockOrder ? 'in_work' : 'incoming',
            draftedAt: isDraft ? new Date() : undefined,
            positions: {
              create: preparedPositions.map(({ position: p, selection }) => ({
                rollCount: p.rollCount,
                filmType: p.filmType,
                actualThickness: p.actualThickness,
                accountingThickness: p.accountingThickness,
                rawMaterialId: p.origin === 'legacy_template' ? (p.rawMaterialId ?? null) : null,
                baseRawMaterialDefinitionId: selection?.baseRawMaterialDefinitionId ?? null,
                recipeDefinitionVersionId: selection?.recipeDefinitionVersionId ?? null,
                spoolType: p.spoolType,
                birka: p.birka,
                manualBirka: p.manualBirka,
                comment: p.comment?.trim() || null,
                plannedWeightKg: p.plannedWeightKg,
                widthMm: p.widthMm,
                plannedLengthM: p.plannedLengthM,
                recipe: {
                  create: {
                    recipeOwnerRole: 'commercial',
                    parameters: (p.recipeParameters ?? []) as unknown as Prisma.InputJsonValue,
                    source: recipeSource,
                    createdBy: actor.role,
                    recipeDefinitionId: selection?.recipeDefinitionId ?? null,
                    recipeDefinitionVersionId: selection?.recipeDefinitionVersionId ?? null,
                    recipeVersionNumber: selection?.version ?? null,
                    recipeName: selection?.name ?? null,
                    ingredients: selection
                      ? (selection.ingredients as Prisma.InputJsonValue)
                      : Prisma.DbNull,
                  },
                },
              })),
            },
            ...(warehouseCoverageWorkflowVersion === 2 ? { coverageState: { create: {} } } : {}),
          },
        });

        if (dto.saveAsTemplate) {
          const positionsSnapshot = preparedPositions.map(({ position, selection }) =>
            snapshotCounterpartyTemplatePosition(position, selection ?? undefined),
          ) as unknown as Prisma.InputJsonValue;
          const savedTemplate = await tx.counterpartyOrderTemplate.create({
            data: {
              counterpartyId: dto.counterpartyId!,
              name: `Заявка ${orderNumber}`,
              ownerRole: 'production_lead',
              createdById: actor.userId,
              positions: positionsSnapshot,
              version: 1,
            },
          });
          await tx.counterpartyOrderTemplateVersion.create({
            data: {
              templateId: savedTemplate.id,
              version: 1,
              positions: positionsSnapshot,
              createdById: actor.userId,
            },
          });
          await this.audit.record(
            {
              type: 'audit:counterparty_template_created',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: savedTemplate.id,
              label: `Counterparty template ${savedTemplate.name} created`,
              detail: {
                counterpartyId: dto.counterpartyId,
                sourceOrderId: order.id,
                positionCount: resolvedPositions.length,
                version: 1,
              },
            },
            tx,
          );
        }

        if (template) {
          await tx.counterpartyOrderTemplate.update({
            where: { id: template.id },
            data: {
              usageCount: { increment: 1 },
              lastUsedAt: new Date(),
            },
          });
          await this.audit.record(
            {
              type: 'audit:counterparty_template_applied',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: order.id,
              label: `Counterparty template ${template.name} applied`,
              detail: {
                templateId: template.id,
                templateVersionId: selectedTemplateVersion?.id ?? null,
                counterpartyId: dto.counterpartyId,
                positionCount: resolvedPositions.length,
              },
            },
            tx,
          );
        }
        if (stockTemplate && stockTemplateVersion) {
          await tx.stockProductionTemplate.update({
            where: { id: stockTemplate.id },
            data: {
              usageCount: { increment: 1 },
              lastUsedAt: new Date(),
            },
          });
          await this.audit.record(
            {
              type: 'audit:stock_production_template_applied',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: order.id,
              label: `Stock production template ${stockTemplate.name} applied`,
              detail: {
                templateId: stockTemplate.id,
                templateVersionId: stockTemplateVersion.id,
                templateVersion: stockTemplateVersion.version,
                positionCount: resolvedPositions.length,
              },
            },
            tx,
          );
        }
        await this.audit.record(
          {
            type: 'audit:commercial_recipe_snapshot_set',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: order.id,
            label: `Recipe snapshot set for order ${orderNumber}`,
            detail: {
              positions: preparedPositions.map(({ selection }, positionIndex) => ({
                positionIndex,
                baseRawMaterialDefinitionId: selection?.baseRawMaterialDefinitionId ?? null,
                recipeDefinitionId: selection?.recipeDefinitionId ?? null,
                recipeDefinitionVersionId: selection?.recipeDefinitionVersionId ?? null,
                recipeVersionNumber: selection?.version ?? null,
                recipeName: selection?.name ?? null,
                ingredients: selection?.ingredients ?? null,
              })),
            },
          },
          tx,
        );

        if (delegated) {
          await this.audit.record(
            {
              type: 'audit:production_request_created_on_behalf_of_commercial',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: order.id,
              reason: 'Created by production_lead on explicit commercial delegation',
              detail: { commercialConfirmationPolicy: 'bypassed_by_delegation' },
            },
            tx,
          );
        }
        return order;
      });
    } catch (error) {
      if (
        dto.clientRequestId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.commercialOrder.findUnique({
          where: { clientRequestId: dto.clientRequestId },
          select: { id: true, requestFingerprint: true },
        });
        if (existing) {
          this.assertCreateReplay(existing, acceptedReplayFingerprints);
          return this.getOrder(actor.role, existing.id);
        }
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Order number or request id is already allocated');
      }
      throw error;
    }

    return this.getOrder(actor.role, created.id);
  }

  /**
   * Generate a unique human order number (`A-<n>`). Seeds the counter from the
   * current row count and probes for collisions (deletions can free numbers).
   */
  private async generateOrderNumber(prefix = 'A'): Promise<string> {
    const base = await this.prisma.commercialOrder.count();
    for (let i = 1; i <= 100; i++) {
      const candidate = `${prefix}-${base + i}`;
      const clash = await this.prisma.commercialOrder.findUnique({
        where: { orderNumber: candidate },
      });
      if (!clash) return candidate;
    }
    return `${prefix}-${Date.now()}`;
  }

  async updateOrderComment(
    actor: CommercialActor,
    orderId: string,
    dto: UpdateOrderCommentDto,
  ): Promise<CommercialOrderComment> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.commercialOrder.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          orderNumber: true,
          comment: true,
          commentVersion: true,
          financeOrder: { select: { id: true } },
          productionOrder: { select: { id: true } },
        },
      });
      if (!current) {
        throw new NotFoundException(`Order ${orderId} not found`);
      }
      if (current.commentVersion !== dto.expectedVersion) {
        throw new ConflictException('Order comment changed concurrently; reload and retry');
      }

      const comment = dto.comment.trim() || null;
      const updated = await tx.commercialOrder.updateMany({
        where: { id: orderId, commentVersion: dto.expectedVersion },
        data: { comment, commentVersion: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Order comment changed concurrently; reload and retry');
      }

      const result = { comment, commentVersion: dto.expectedVersion + 1 };
      await this.audit.record(
        {
          type: 'audit:commercial_order_comment_updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          label: 'Commercial order comment updated',
          oldValue: { comment: current.comment, commentVersion: current.commentVersion },
          newValue: result,
        },
        tx,
      );
      const recipientRoles: Role[] = [
        ...(current.financeOrder ? (['finance'] as const) : []),
        ...(current.productionOrder ? (['production_lead'] as const) : []),
      ];
      if (recipientRoles.length > 0) {
        await this.audit.record(
          {
            type: 'notification:commercial_order_amended',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: orderId,
            label: 'Комментарий заявки изменён',
            detail: {
              orderId,
              orderNumber: current.orderNumber,
              field: 'comment',
              recipientRoles,
            },
          },
          tx,
        );
      }
      return result;
    });
  }

  async updatePosition(
    actor: CommercialActor,
    orderId: string,
    positionId: string,
    dto: UpdatePositionDto,
  ) {
    const position = await this.prisma.commercialOrderPosition.findFirst({
      where: { id: positionId, orderId },
      include: { order: true, recipe: true },
    });
    if (!position) {
      throw new NotFoundException(`Position ${positionId} not found for order ${orderId}`);
    }

    const {
      expectedVersion,
      recipeParameters,
      rollCount,
      filmType,
      actualThickness,
      accountingThickness,
      widthMm,
      plannedLengthM,
      rawMaterialId,
      baseRawMaterialDefinitionId,
      recipeDefinitionVersionId,
      spoolType,
      birka,
      manualBirka,
      comment,
      plannedWeightKg,
    } = dto;

    const positionData: Prisma.CommercialOrderPositionUncheckedUpdateManyInput = {};
    if (rollCount !== undefined) positionData.rollCount = rollCount;
    if (filmType !== undefined) positionData.filmType = filmType;
    if (actualThickness !== undefined) positionData.actualThickness = actualThickness;
    if (accountingThickness !== undefined) positionData.accountingThickness = accountingThickness;
    if (widthMm !== undefined) positionData.widthMm = widthMm;
    if (plannedLengthM !== undefined) positionData.plannedLengthM = plannedLengthM;
    if (rawMaterialId !== undefined) positionData.rawMaterialId = rawMaterialId;
    if (spoolType !== undefined) positionData.spoolType = spoolType;
    if (birka !== undefined) positionData.birka = birka;
    if (manualBirka !== undefined) positionData.manualBirka = manualBirka.trim() || null;
    if (comment !== undefined) positionData.comment = comment.trim() || null;
    if (plannedWeightKg !== undefined) positionData.plannedWeightKg = plannedWeightKg;
    const hasCatalogSelectionMutation =
      baseRawMaterialDefinitionId !== undefined || recipeDefinitionVersionId !== undefined;
    if (hasCatalogSelectionMutation) {
      const selectorCount =
        Number(typeof baseRawMaterialDefinitionId === 'string') +
        Number(typeof recipeDefinitionVersionId === 'string');
      if (
        baseRawMaterialDefinitionId === undefined ||
        recipeDefinitionVersionId === undefined ||
        selectorCount !== 1
      ) {
        throw new BadRequestException({
          code: 'INVALID_MATERIAL_SELECTION',
          message:
            'A position material update must select exactly one base material or recipe version.',
        });
      }
    }
    const hasPositionMutation = Object.keys(positionData).length > 0 || hasCatalogSelectionMutation;
    const hasRecipeMutation = recipeParameters !== undefined;

    await this.prisma.$transaction(async (tx) => {
      const invoiceBoundary = await lockInvoiceBoundaryForCommercialOrder(tx, orderId);
      if (invoiceLocksCommercialParameters(invoiceBoundary)) {
        throw new ConflictException({
          code: COMMERCIAL_ORDER_PARAMETERS_LOCKED_AFTER_INVOICE,
          message: 'Параметры заказа закрыты после выставления счёта.',
        });
      }
      await lockCommercialOrderAggregate(tx, orderId);
      if (this.isCommercialOrderLocked(position.order)) {
        throw new ConflictException('Order parameters are locked after finance confirmation');
      }
      if (position.version !== dto.expectedVersion) {
        throw new ConflictException('Position changed concurrently; reload and retry');
      }
      const editableOrder = this.editableCommercialOrderWhere(orderId);
      let resolvedSelection: ResolvedRecipeSelection | null = null;
      if (hasCatalogSelectionMutation) {
        const selector: PositionMaterialSelection =
          typeof baseRawMaterialDefinitionId === 'string'
            ? { baseRawMaterialDefinitionId }
            : { recipeDefinitionVersionId: recipeDefinitionVersionId as string };
        const selections = await this.recipeCatalog.resolveSelections(tx, [selector]);
        if (selections.length !== 1 || !selections[0]) {
          throw new InternalServerErrorException({
            code: 'RECIPE_SELECTION_RESOLUTION_INVARIANT',
            message: 'Recipe selection resolution returned an unexpected number of results.',
          });
        }
        resolvedSelection = this.copySelection(selections[0]);
        positionData.rawMaterialId = null;
        positionData.baseRawMaterialDefinitionId = resolvedSelection.baseRawMaterialDefinitionId;
        positionData.recipeDefinitionVersionId = resolvedSelection.recipeDefinitionVersionId;
      }
      if (hasPositionMutation || hasRecipeMutation) {
        const positionUpdate = await tx.commercialOrderPosition.updateMany({
          where: {
            id: positionId,
            orderId,
            version: expectedVersion,
            order: editableOrder,
          },
          data: { ...positionData, version: { increment: 1 } },
        });
        if (positionUpdate.count !== 1) {
          throw new ConflictException('Position changed concurrently; reload and retry');
        }
      }

      if (hasPositionMutation) {
        await this.audit.record(
          {
            type: 'audit:commercial_position_updated',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: orderId,
            oldValue: {
              version: position.version,
              rollCount: position.rollCount,
              filmType: position.filmType,
              actualThickness: position.actualThickness,
              accountingThickness: position.accountingThickness,
              widthMm: position.widthMm,
              plannedLengthM: position.plannedLengthM,
              rawMaterialId: position.rawMaterialId,
              baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId,
              recipeDefinitionVersionId: position.recipeDefinitionVersionId,
              spoolType: position.spoolType,
              birka: position.birka,
              manualBirka: position.manualBirka,
              comment: position.comment,
              plannedWeightKg: position.plannedWeightKg,
            } as unknown as Prisma.InputJsonValue,
            newValue: {
              version: position.version + 1,
              rollCount: rollCount ?? position.rollCount,
              filmType: filmType ?? position.filmType,
              actualThickness: actualThickness ?? position.actualThickness,
              accountingThickness: accountingThickness ?? position.accountingThickness,
              widthMm: widthMm ?? position.widthMm,
              plannedLengthM: plannedLengthM ?? position.plannedLengthM,
              rawMaterialId: resolvedSelection ? null : (rawMaterialId ?? position.rawMaterialId),
              baseRawMaterialDefinitionId: resolvedSelection
                ? resolvedSelection.baseRawMaterialDefinitionId
                : position.baseRawMaterialDefinitionId,
              recipeDefinitionVersionId: resolvedSelection
                ? resolvedSelection.recipeDefinitionVersionId
                : position.recipeDefinitionVersionId,
              spoolType: spoolType ?? position.spoolType,
              birka: birka ?? position.birka,
              manualBirka:
                manualBirka !== undefined ? manualBirka.trim() || null : position.manualBirka,
              comment: comment !== undefined ? comment.trim() || null : position.comment,
              plannedWeightKg: plannedWeightKg ?? position.plannedWeightKg,
            } as unknown as Prisma.InputJsonValue,
            detail: { positionId },
          },
          tx,
        );
      }

      if (resolvedSelection) {
        if (!position.recipe) {
          throw new NotFoundException(`Recipe for position ${positionId} not found`);
        }
        const nextVersion = this.nextRecipeVersion(position.recipe.version);
        const recipeUpdate = await tx.recipeSnapshot.updateMany({
          where: {
            positionId,
            version: position.recipe.version,
            position: {
              id: positionId,
              orderId,
              order: editableOrder,
            },
          },
          data: {
            ...(recipeParameters !== undefined
              ? {
                  parameters: recipeParameters as unknown as Prisma.InputJsonValue,
                }
              : {}),
            recipeDefinitionId: resolvedSelection.recipeDefinitionId,
            recipeDefinitionVersionId: resolvedSelection.recipeDefinitionVersionId,
            recipeVersionNumber: resolvedSelection.version,
            recipeName: resolvedSelection.name,
            ingredients: resolvedSelection.ingredients as unknown as Prisma.InputJsonValue,
            version: nextVersion,
          },
        });
        if (recipeUpdate.count !== 1) {
          throw new ConflictException('Order parameters changed concurrently; retry the update');
        }
        await tx.domainEvent.create({
          data: {
            family: 'audit',
            type: 'audit:commercial_recipe_snapshot_set',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: orderId,
            oldValue: {
              baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId,
              recipeDefinitionId: position.recipe.recipeDefinitionId,
              recipeDefinitionVersionId: position.recipe.recipeDefinitionVersionId,
              recipeVersionNumber: position.recipe.recipeVersionNumber,
              recipeName: position.recipe.recipeName,
              ingredients: position.recipe.ingredients,
              version: position.recipe.version,
            } as unknown as Prisma.InputJsonValue,
            newValue: {
              baseRawMaterialDefinitionId: resolvedSelection.baseRawMaterialDefinitionId,
              recipeDefinitionId: resolvedSelection.recipeDefinitionId,
              recipeDefinitionVersionId: resolvedSelection.recipeDefinitionVersionId,
              recipeVersionNumber: resolvedSelection.version,
              recipeName: resolvedSelection.name,
              ingredients: resolvedSelection.ingredients,
              version: nextVersion,
            } as unknown as Prisma.InputJsonValue,
            detail: {
              positionId,
              source: 'position_patch',
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return;
      }
      if (recipeParameters === undefined) return;
      await this.updateRecipeParameters(tx, actor, orderId, positionId, recipeParameters, {
        source: 'position_patch',
      });
    });
    return this.getOrder(actor.role, orderId);
  }

  private async updateRecipeParameters(
    tx: Prisma.TransactionClient,
    actor: CommercialActor,
    orderId: string,
    positionId: string,
    parameters: unknown,
    detail: Record<string, unknown>,
    reason?: string,
  ) {
    const position = await tx.commercialOrderPosition.findFirst({
      where: { id: positionId, orderId },
      include: { order: true, recipe: true },
    });
    if (!position) {
      throw new NotFoundException(`Position ${positionId} not found for order ${orderId}`);
    }
    if (this.isCommercialOrderLocked(position.order)) {
      throw new ConflictException('Order parameters are locked after finance confirmation');
    }
    if (!position.recipe) {
      throw new NotFoundException(`Recipe for position ${positionId} not found`);
    }

    const nextVersion = this.nextRecipeVersion(position.recipe.version);
    const recipeUpdate = await tx.recipeSnapshot.updateMany({
      where: {
        positionId,
        version: position.recipe.version,
        position: {
          id: positionId,
          orderId,
          order: this.editableCommercialOrderWhere(orderId),
        },
      },
      data: {
        parameters: parameters as unknown as Prisma.InputJsonValue,
        version: nextVersion,
      },
    });
    if (recipeUpdate.count !== 1) {
      throw new ConflictException('Order parameters changed concurrently; retry the update');
    }
    await tx.domainEvent.create({
      data: {
        family: 'audit',
        type: 'audit:recipe_correction_applied',
        actorRole: actor.role,
        actorId: actor.userId,
        objectId: orderId,
        reason,
        oldValue: {
          parameters: position.recipe.parameters,
          version: position.recipe.version,
        } as unknown as Prisma.InputJsonValue,
        newValue: {
          parameters,
          version: nextVersion,
        } as unknown as Prisma.InputJsonValue,
        detail: {
          positionId,
          ...detail,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async requestCoverCheck(
    actor: CommercialActor,
    orderId: string,
  ): Promise<WarehouseCoverRequestResult> {
    return withWarehouseCoverCaseTransaction(this.prisma, async (tx) => {
      const order = await tx.commercialOrder.findUnique({
        where: { id: orderId },
        include: ORDER_INCLUDE,
      });
      if (!order) throw new NotFoundException(`Order ${orderId} not found`);
      assertCoverageWorkflow(
        order.warehouseCoverageWorkflowVersion as WarehouseCoverageWorkflowVersion,
        1,
      );
      assertWarehouseCoverActionable(order);

      const acquired = await acquireWarehouseCoverCase(tx, {
        orderId,
        affectedPositionIds: order.positions.map((position) => position.id),
        actorRole: actor.role,
        actorId: actor.userId,
        reason: 'commercial_requested_warehouse_cover_check',
      });
      if (!acquired.created) {
        return {
          order: projectWarehouseCoverRequestOrder(order),
          case: projectWarehouseCoverRequestCase(acquired.case),
        };
      }

      const claimed = await tx.commercialOrder.updateMany({
        where: {
          id: orderId,
          version: order.version,
          warehouseCoverStatus: order.warehouseCoverStatus,
          ...WAREHOUSE_COVER_ACTIONABLE_WHERE,
        },
        data: {
          warehouseCoverStatus: 'recheck_requested',
          version: { increment: 1 },
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException('Warehouse cover state changed; reload and retry');
      }
      await this.audit.record(
        {
          type: 'audit:warehouse_cover_recheck_requested',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          detail: { orderId, orderNumber: order.orderNumber, caseId: acquired.case.id },
          oldValue: {
            warehouseCoverStatus: order.warehouseCoverStatus,
            version: order.version,
          },
          newValue: {
            warehouseCoverStatus: 'recheck_requested',
            version: order.version + 1,
          },
        },
        tx,
      );
      const updatedOrder = {
        ...order,
        warehouseCoverStatus: 'recheck_requested',
        version: order.version + 1,
      };
      return {
        order: projectWarehouseCoverRequestOrder(updatedOrder),
        case: projectWarehouseCoverRequestCase(acquired.case),
      };
    });
  }

  async confirmCover(actor: CommercialActor, orderId: string, proposalId: string) {
    const proposal = await this.requireProposal(orderId, proposalId);
    const status = proposal.coverType === 'partial' ? 'partial_confirmed' : 'full_confirmed';
    await this.prisma.warehouseCoverProposal.update({
      where: { id: proposalId },
      data: { status },
    });
    await this.prisma.commercialOrder.update({
      where: { id: orderId },
      data: { warehouseCoverStatus: status },
    });
    await this.audit.record({
      type: 'audit:warehouse_cover_confirmed',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: orderId,
      oldValue: { status: proposal.status },
      newValue: { status },
    });
    return this.getOrder(actor.role, orderId);
  }

  async rejectCover(
    actor: CommercialActor,
    orderId: string,
    proposalId: string,
    dto: RejectCoverDto,
  ) {
    const proposal = await this.requireProposal(orderId, proposalId);
    const status = dto.recheck ? 'recheck_requested' : 'rejected';
    await this.prisma.warehouseCoverProposal.update({
      where: { id: proposalId },
      data: { status },
    });
    await this.prisma.commercialOrder.update({
      where: { id: orderId },
      data: { warehouseCoverStatus: status },
    });
    await this.audit.record({
      type: 'audit:warehouse_cover_rejected',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: orderId,
      reason: dto.reason,
      oldValue: { status: proposal.status },
      newValue: { status },
    });
    return this.getOrder(actor.role, orderId);
  }

  async forceProduction(actor: CommercialActor, orderId: string, dto: ForceProductionDto) {
    const order = await this.prisma.commercialOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    assertCoverageWorkflow(
      order.warehouseCoverageWorkflowVersion as WarehouseCoverageWorkflowVersion,
      1,
    );
    if (order.productionIndicator === 'in_production') {
      throw new ConflictException('Order already in production');
    }
    const oldValue = {
      warehouseCoverStatus: order.warehouseCoverStatus,
      productionIndicator: order.productionIndicator,
    };
    const newValue = {
      warehouseCoverStatus: 'needs_production',
      productionIndicator: 'needs_production',
    };
    await this.prisma.commercialOrder.update({ where: { id: orderId }, data: newValue });
    await this.audit.record({
      type: 'audit:warehouse_cover_forced_production',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: orderId,
      reason: dto.reason,
      oldValue,
      newValue,
    });
    return this.getOrder(actor.role, orderId);
  }

  async selectWarehouseCoverRoute(
    actor: CommercialActor,
    orderId: string,
    dto: WarehouseCoverRouteDto,
  ) {
    const order = await this.prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: { positions: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (this.isCommercialOrderLocked(order)) {
      throw new ConflictException('Order parameters are locked after finance confirmation');
    }
    if (order.productionIndicator === 'in_production') {
      throw new ConflictException('Order already in production');
    }

    const position = order.positions.find((item) => item.id === dto.positionId);
    if (!position) {
      throw new NotFoundException(`Position ${dto.positionId} not found for order ${orderId}`);
    }

    const rollCount = Math.max(0, position.rollCount);
    const coverQty = this.routeCoverQty(dto, rollCount);
    const productionQty = Math.max(0, rollCount - coverQty);
    const coverType = dto.status === 'full_proposed' ? 'full' : 'partial';
    const existingProposal = await this.prisma.warehouseCoverProposal.findFirst({
      where: { orderId, positionId: position.id },
    });

    if (existingProposal) {
      await this.prisma.warehouseCoverProposal.update({
        where: { id: existingProposal.id },
        data: {
          coverType,
          coverQty,
          reserveQty: coverQty,
          productionQty,
          status: dto.status,
        },
      });
    } else {
      await this.prisma.warehouseCoverProposal.create({
        data: {
          orderId,
          positionId: position.id,
          coverType,
          coverQty,
          reserveQty: coverQty,
          productionQty,
          status: dto.status,
        },
      });
    }

    await this.prisma.commercialOrderPosition.update({
      where: { id: position.id },
      data: { warehouseCoverStatus: dto.status },
    });

    const orderWarehouseCoverStatus = this.aggregateWarehouseCoverStatus(
      order.positions.map((item) =>
        item.id === position.id ? dto.status : item.warehouseCoverStatus,
      ),
    );
    const productionIndicator =
      orderWarehouseCoverStatus === 'full_proposed'
        ? order.productionIndicator === 'needs_production'
          ? 'not_started'
          : order.productionIndicator
        : 'needs_production';
    await this.prisma.commercialOrder.update({
      where: { id: orderId },
      data: {
        warehouseCoverStatus: orderWarehouseCoverStatus,
        productionIndicator,
      },
    });

    await this.audit.record({
      type: 'audit:commercial_warehouse_cover_route_selected',
      actorRole: actor.role,
      actorId: actor.userId,
      objectId: orderId,
      reason: dto.reason,
      oldValue: {
        positionId: position.id,
        status: position.warehouseCoverStatus,
        orderWarehouseCoverStatus: order.warehouseCoverStatus,
        productionIndicator: order.productionIndicator,
      },
      newValue: {
        positionId: position.id,
        status: dto.status,
        coverQty,
        productionQty,
        orderWarehouseCoverStatus,
        productionIndicator,
      },
    });

    return this.getOrder(actor.role, orderId);
  }

  async applyCorrection(actor: CommercialActor, orderId: string, dto: CreateCorrectionDto) {
    await this.prisma.$transaction(async (tx) => {
      await lockCommercialOrderAggregate(tx, orderId);
      await this.updateRecipeParameters(
        tx,
        actor,
        orderId,
        dto.positionId,
        dto.newParameters,
        { source: 'manual_correction', fromRollId: dto.fromRollId ?? null },
        dto.reason,
      );
      await tx.domainEvent.create({
        data: {
          family: 'notification',
          type: 'notification:operator_recipe_changed',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: orderId,
          label: `Recipe changed for position ${dto.positionId}`,
        },
      });
    });
    return this.getOrder(actor.role, orderId);
  }

  async invoiceHandoff(actor: CommercialActor, orderId: string, dto: InvoiceHandoffDto) {
    const order = await this.prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: { financeOrder: true, positions: { include: { recipe: true } } },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    if (order.requestType === 'stock_reserve') {
      throw new ConflictException('Stock production does not use a finance handoff');
    }
    if (order.warehouseCoverageWorkflowVersion === 2) {
      const completeness = validateV2CoverageCompleteness(order);
      if (!completeness.ok) {
        throw new ConflictException({
          statusCode: 409,
          code: completeness.reasonCode,
          message: 'Заполните обязательные параметры заказа перед передачей в бухгалтерию.',
          missing: completeness.missing,
        });
      }
    } else {
      assertCoverageWorkflow(
        order.warehouseCoverageWorkflowVersion as WarehouseCoverageWorkflowVersion,
        1,
      );
    }

    if (order.commercialStage === 'sent_to_finance' && order.financeOrder) {
      this.assertCompatibleFinanceHandoff(order.financeOrder, dto);
      return this.getOrder(actor.role, orderId);
    }

    const paymentConfirmed = order.paymentStatus === 'partial' || order.paymentStatus === 'paid';
    const allowedStage = order.commercialStage === 'incoming';
    if (
      !allowedStage ||
      order.commercialStage === 'in_work' ||
      order.commercialLockedAt ||
      paymentConfirmed
    ) {
      throw new ConflictException('Order cannot be handed off to finance in its current state');
    }

    const now = new Date();
    const financeOrderPayload = {
      amountValue: dto.amount ?? null,
      amountLabel: dto.note?.trim() || null,
    };
    const handoffWhere: Prisma.CommercialOrderWhereInput = {
      ...this.editableCommercialOrderWhere(orderId),
      commercialStage: 'incoming',
    };
    try {
      const handoff = async (tx: Prisma.TransactionClient) => {
        if (order.warehouseCoverageWorkflowVersion === 2) {
          await this.coverageCalculation.initializeAtInvoiceHandoff(tx, orderId);
        }
        const recordInvoiceHandoff = () =>
          tx.domainEvent.create({
            data: {
              family: 'audit',
              type: 'audit:invoice_handoff_created',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              oldValue: {
                commercialStage: order.commercialStage,
                orderNumber: order.orderNumber,
              } as unknown as Prisma.InputJsonValue,
              newValue: {
                commercialStage: 'sent_to_finance',
                orderNumber: order.orderNumber,
                amount: dto.amount ?? null,
              } as unknown as Prisma.InputJsonValue,
              detail: {
                amount: dto.amount ?? null,
                note: dto.note?.trim() || null,
              } as unknown as Prisma.InputJsonValue,
            },
          });

        const orderUpdate = await tx.commercialOrder.updateMany({
          where: handoffWhere,
          data: {
            commercialStage: 'sent_to_finance',
            sentToFinanceAt: now,
            version: { increment: 1 },
          },
        });
        if (orderUpdate.count !== 1) {
          const [racedOrder, racedFinanceOrder] = await Promise.all([
            tx.commercialOrder.findUnique({
              where: { id: orderId },
              select: { commercialStage: true },
            }),
            tx.financeOrder.findUnique({
              where: { commercialOrderId: orderId },
            }),
          ]);
          if (racedOrder?.commercialStage === 'sent_to_finance' && racedFinanceOrder) {
            this.assertCompatibleFinanceHandoff(racedFinanceOrder, dto);
            return;
          }
          throw new ConflictException('Order cannot be handed off to finance in its current state');
        }
        const existingFinanceOrder = await tx.financeOrder.findUnique({
          where: { commercialOrderId: orderId },
        });
        if (existingFinanceOrder) {
          this.assertCompatibleFinanceHandoff(existingFinanceOrder, dto);
          await recordInvoiceHandoff();
          return;
        }

        try {
          await tx.financeOrder.create({
            data: {
              commercialOrderId: orderId,
              ...financeOrderPayload,
            },
          });
          await recordInvoiceHandoff();
          await tx.domainEvent.create({
            data: {
              family: 'audit',
              type: 'audit:finance_order_created',
              actorRole: actor.role,
              actorId: actor.userId,
              objectId: orderId,
              label: 'Finance order opened by commercial invoice handoff',
            },
          });
          return;
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            throw error;
          }

          throw new ConflictException('Finance handoff raced with another command; retry');
        }
      };
      if (order.warehouseCoverageWorkflowVersion === 2) {
        await this.coverageTransaction.run(handoff);
      } else {
        await this.prisma.$transaction(handoff);
      }
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Order number is already allocated; retry handoff');
      }
      throw error;
    }
    return this.getOrder(actor.role, orderId);
  }

  async deleteOrder(actor: CommercialActor, orderId: string): Promise<void> {
    await this.coverageTransaction.run(
      async (tx) => {
        await lockCoverageInventoryEpoch(tx);
        await tx.$queryRaw(
          Prisma.sql`SELECT "orderId" FROM "warehouse_coverage_states"
                   WHERE "orderId" = ${orderId} FOR UPDATE`,
        );
        const locked = await tx.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`SELECT "id" FROM "commercial_orders"
                   WHERE "id" = ${orderId} FOR UPDATE`,
        );
        if (locked.length === 0) {
          throw new NotFoundException(`Commercial order ${orderId} not found`);
        }

        const order = await tx.commercialOrder.findUnique({
          where: { id: orderId },
          select: { orderNumber: true, commercialStage: true, cancellationStatus: true },
        });
        if (!order) throw new NotFoundException(`Commercial order ${orderId} not found`);

        if (
          (await tx.warehouseRoll.count({ where: { releasedFromOrderId: orderId } })) ||
          (order.cancellationStatus === 'cancelled' &&
            (await tx.weightCapture.count({
              where: {
                kind: 'roll',
                stable: true,
                line: { rollDispatchItem: { productionOrder: { commercialOrderId: orderId } } },
              },
            })))
        ) {
          throw new ConflictException(
            'История заказа связана с изготовленными рулонами. Удаление недоступно.',
          );
        }

        const [purged] = await tx.$queryRaw<Array<{ deleted: boolean }>>(
          Prisma.sql`SELECT hard_delete_commercial_order(${orderId}) AS deleted`,
        );
        if (!purged?.deleted) throw new NotFoundException(`Commercial order ${orderId} not found`);

        await this.audit.record(
          {
            type: 'audit:commercial_order_deleted',
            objectId: orderId,
            actorRole: actor.role,
            actorId: actor.userId,
            label: 'Commercial order permanently deleted',
            oldValue: {
              orderNumber: order.orderNumber,
              commercialStage: order.commercialStage,
            },
            detail: { irreversible: true },
          },
          tx,
        );
      },
      undefined,
      120_000,
    );
  }

  async promoteDraft(actor: CommercialActor, orderId: string) {
    const order = await this.prisma.commercialOrder.findUnique({
      where: { id: orderId },
      include: { financeOrder: true },
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);

    const isStockOrder = order.requestType === 'stock_reserve';
    const promotedStage = isStockOrder ? 'in_work' : 'incoming';
    if (order.commercialStage === promotedStage && order.draftedAt) {
      return this.getOrder(actor.role, orderId);
    }

    const paymentConfirmed = order.paymentStatus === 'partial' || order.paymentStatus === 'paid';
    if (
      order.commercialStage !== 'draft' ||
      order.commercialLockedAt ||
      paymentConfirmed ||
      order.financeOrder
    ) {
      throw new ConflictException('Draft cannot be promoted in its current state');
    }

    const nextOrderNumber = order.orderNumber.startsWith('D-')
      ? await this.generateOrderNumber(isStockOrder ? 'S' : 'A')
      : undefined;
    const nextStockBatchCode = isStockOrder
      ? `STOCK-${nextOrderNumber ?? order.orderNumber}`
      : undefined;

    try {
      await this.prisma.$transaction(async (tx) => {
        const orderUpdate = await tx.commercialOrder.updateMany({
          where: {
            id: orderId,
            commercialStage: 'draft',
            orderNumber: order.orderNumber,
            commercialLockedAt: null,
            paymentStatus: { notIn: ['partial', 'paid'] },
          },
          data: {
            commercialStage: promotedStage,
            ...(nextOrderNumber ? { orderNumber: nextOrderNumber } : {}),
            ...(nextStockBatchCode ? { stockBatchCode: nextStockBatchCode } : {}),
            version: { increment: 1 },
          },
        });
        if (orderUpdate.count !== 1) {
          throw new ConflictException('Draft cannot be promoted in its current state');
        }

        await tx.domainEvent.create({
          data: {
            family: 'audit',
            type: 'audit:commercial_draft_promoted',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: orderId,
            oldValue: {
              commercialStage: 'draft',
              orderNumber: order.orderNumber,
            } as unknown as Prisma.InputJsonValue,
            newValue: {
              commercialStage: promotedStage,
              orderNumber: nextOrderNumber ?? order.orderNumber,
              stockBatchCode: nextStockBatchCode ?? null,
            } as unknown as Prisma.InputJsonValue,
            label: 'Commercial draft promoted to incoming order',
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Order number is already allocated; retry draft promotion');
      }
      if (error instanceof ConflictException) {
        const latest = await this.prisma.commercialOrder.findUnique({ where: { id: orderId } });
        if (latest?.commercialStage === promotedStage && latest.draftedAt) {
          return this.getOrder(actor.role, orderId);
        }
      }
      throw error;
    }

    return this.getOrder(actor.role, orderId);
  }

  getAudit(orderId: string) {
    return this.audit.forObject(orderId, 'commercial');
  }

  private async requireProposal(orderId: string, proposalId: string) {
    const proposal = await this.prisma.warehouseCoverProposal.findUnique({
      where: { id: proposalId },
    });
    if (!proposal || proposal.orderId !== orderId) {
      throw new NotFoundException(`Cover proposal ${proposalId} not found for order ${orderId}`);
    }
    return proposal;
  }

  private project(
    order: {
      counterparty: Parameters<typeof projectCounterparty>[0];
      financeOrder?: {
        id: string;
        productionClearedAt: Date | null;
        invoiceStatus: string;
        paymentStatus: string;
        paymentTermsType: string | null;
        policy: {
          id: string;
          stages: Array<{ id: string; trigger: string }>;
        } | null;
        schedules: Array<{
          paymentPolicyStageId: string | null;
          kind: string;
          status: string;
        }>;
      } | null;
      paymentStatus?: string;
      commercialLockedAt?: Date | null;
      commercialStage?: string;
      warehouseCoverStatus?: string;
      productionIndicator?: string;
      productionOrder?: { id: string } | null;
      stockProductionTemplateId?: string | null;
      stockProductionTemplateName?: string | null;
      stockProductionTemplateVersionId?: string | null;
      stockProductionTemplateVersion?: { version: number } | null;
      requestType?: string;
      warehouseCoverageWorkflowVersion: number;
    },
    actorRole: Role,
  ) {
    const paymentConfirmed = order.paymentStatus === 'partial' || order.paymentStatus === 'paid';
    const canEditParameters =
      (order.commercialStage === 'draft' || order.commercialStage === 'incoming') &&
      !paymentConfirmed &&
      !order.commercialLockedAt;
    const isStockOrder = order.requestType === 'stock_reserve';
    const canSendToFinance = !isStockOrder && order.commercialStage === 'incoming';
    const canPromoteDraft =
      order.commercialStage === 'draft' && !paymentConfirmed && !order.commercialLockedAt;
    const hasCoverChoice = [
      'partial_proposed',
      'full_proposed',
      'partial_confirmed',
      'full_confirmed',
    ].includes(order.warehouseCoverStatus ?? '');
    const productionHandoffState = order.productionOrder
      ? 'sent'
      : ['commercial', 'production_lead'].includes(actorRole) &&
          (isStockOrder
            ? order.commercialStage === 'in_work'
            : ['sent_to_finance', 'in_work'].includes(order.commercialStage ?? '') &&
              financeAllowsProduction(order.financeOrder ?? null))
        ? 'ready'
        : 'not_ready';
    const { financeOrder, productionOrder, stockProductionTemplateVersion, ...safeOrder } = order;

    return {
      ...safeOrder,
      counterparty: projectCounterparty(order.counterparty, actorRole),
      stockProductionTemplate: projectStockProductionTemplate({
        ...order,
        stockProductionTemplateVersion,
      }),
      financeSummary: financeOrder
        ? {
            id: financeOrder.id,
            invoiceStatus: financeOrder.invoiceStatus,
            paymentStatus: financeOrder.paymentStatus,
          }
        : null,
      canEditParameters,
      canSendToFinance,
      canPromoteDraft,
      canSendToProduction: productionHandoffState === 'ready',
      productionHandoffState,
      productionOrderId: productionOrder?.id ?? null,
      canForceProduction: hasCoverChoice && order.productionIndicator !== 'in_production',
    };
  }

  private nextRecipeVersion(version: string | null | undefined) {
    const current = Number(String(version ?? 'v0').replace(/^v/, ''));
    return `v${Number.isFinite(current) ? current + 1 : 1}`;
  }

  private assertCompatibleFinanceHandoff(
    financeOrder: {
      amountValue: number | Prisma.Decimal | null;
      amountLabel: string | null;
    },
    dto: InvoiceHandoffDto,
  ) {
    const requestedAmount = dto.amount ?? null;
    const requestedLabel = dto.note?.trim() || null;
    if (
      (financeOrder.amountValue === null ? null : Number(financeOrder.amountValue)) !==
        requestedAmount ||
      financeOrder.amountLabel !== requestedLabel
    ) {
      throw new ConflictException('Finance handoff already exists with a different payload');
    }
  }

  private catalogPosition(position: CreatePositionDto): CatalogOrderPosition {
    return {
      origin: 'catalog',
      rollCount: position.rollCount,
      filmType: position.filmType,
      actualThickness: position.actualThickness,
      accountingThickness: position.accountingThickness,
      baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId,
      recipeDefinitionVersionId: position.recipeDefinitionVersionId,
      spoolType: position.spoolType,
      birka: position.birka,
      manualBirka: position.manualBirka,
      comment: position.comment,
      plannedWeightKg: position.plannedWeightKg,
      widthMm: position.widthMm,
      plannedLengthM: position.plannedLengthM,
      recipeParameters: position.recipeParameters ?? [],
    };
  }

  private positionMaterialSelection(position: CatalogOrderPosition): PositionMaterialSelection {
    return {
      ...(typeof position.baseRawMaterialDefinitionId === 'string'
        ? { baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId }
        : {}),
      ...(typeof position.recipeDefinitionVersionId === 'string'
        ? { recipeDefinitionVersionId: position.recipeDefinitionVersionId }
        : {}),
    } as PositionMaterialSelection;
  }

  private copySelection(selection: ResolvedRecipeSelection): ResolvedRecipeSelection {
    return {
      baseRawMaterialDefinitionId: selection.baseRawMaterialDefinitionId,
      recipeDefinitionId: selection.recipeDefinitionId,
      recipeDefinitionVersionId: selection.recipeDefinitionVersionId,
      version: selection.version,
      name: selection.name,
      ingredients: selection.ingredients.map(
        (ingredient): RecipeIngredientShare => ({
          rawMaterialDefinitionId: ingredient.rawMaterialDefinitionId,
          name: ingredient.name,
          shareBasisPoints: ingredient.shareBasisPoints,
        }),
      ),
    };
  }

  private positionsFromTemplate(value: Prisma.JsonValue): ResolvedOrderPosition[] {
    if (!Array.isArray(value)) {
      throw new ConflictException('Counterparty template has invalid positions snapshot');
    }
    return value.map((position, index) => this.positionFromTemplate(position, index));
  }

  private positionFromTemplate(value: Prisma.JsonValue, index: number): ResolvedOrderPosition {
    if (!this.isJsonObject(value)) {
      throw new ConflictException(`Counterparty template position ${index + 1} is invalid`);
    }
    const rollCount = Number(value.rollCount);
    const filmType = this.requiredTemplateString(value, 'filmType', index);
    const actualThickness = this.requiredTemplateString(value, 'actualThickness', index);
    const accountingThickness = this.requiredTemplateString(value, 'accountingThickness', index);
    if (!Number.isInteger(rollCount) || rollCount < 1) {
      throw new ConflictException(
        `Counterparty template position ${index + 1} has invalid rollCount`,
      );
    }

    const position: PositionFields = {
      rollCount,
      filmType,
      actualThickness,
      accountingThickness,
      spoolType: this.optionalTemplateString(value.spoolType),
      birka: this.optionalTemplateString(value.birka),
      manualBirka: this.optionalTemplateString(value.manualBirka),
      comment: this.optionalTemplateString(value.comment),
      plannedWeightKg:
        typeof value.plannedWeightKg === 'number' && Number.isFinite(value.plannedWeightKg)
          ? value.plannedWeightKg
          : undefined,
      widthMm:
        typeof value.widthMm === 'number' && Number.isFinite(value.widthMm)
          ? value.widthMm
          : undefined,
      plannedLengthM:
        typeof value.plannedLengthM === 'number' && Number.isFinite(value.plannedLengthM)
          ? value.plannedLengthM
          : undefined,
      recipeParameters: this.templateRecipeParameters(value.recipeParameters),
    };
    const baseRawMaterialDefinitionId = this.optionalTemplateString(
      value.baseRawMaterialDefinitionId,
    );
    const recipeDefinitionVersionId = this.optionalTemplateString(value.recipeDefinitionVersionId);
    if (baseRawMaterialDefinitionId || recipeDefinitionVersionId) {
      return {
        ...position,
        origin: 'catalog',
        baseRawMaterialDefinitionId,
        recipeDefinitionVersionId,
      };
    }

    return {
      ...position,
      origin: 'legacy_template',
      rawMaterialId: this.optionalTemplateString(value.rawMaterialId),
    };
  }

  private requiredTemplateString(
    value: Record<string, Prisma.JsonValue>,
    key: string,
    index: number,
  ) {
    const fieldValue = value[key];
    if (typeof fieldValue !== 'string' || fieldValue.trim().length === 0) {
      throw new ConflictException(`Counterparty template position ${index + 1} has invalid ${key}`);
    }
    return fieldValue;
  }

  private optionalTemplateString(value: Prisma.JsonValue | undefined) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  }

  private templateRecipeParameters(value: Prisma.JsonValue | undefined): RecipeParamDto[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!this.isJsonObject(item)) return [];
      if (typeof item.label !== 'string' || typeof item.value !== 'string') return [];
      return [{ label: item.label, value: item.value }];
    });
  }

  private isJsonObject(value: Prisma.JsonValue): value is Record<string, Prisma.JsonValue> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isCommercialOrderLocked(order: {
    commercialLockedAt?: Date | null;
    commercialStage?: string | null;
    paymentStatus?: string | null;
  }) {
    return (
      Boolean(order.commercialLockedAt) ||
      order.commercialStage === 'sent_to_finance' ||
      order.commercialStage === 'in_work' ||
      order.paymentStatus === 'partial' ||
      order.paymentStatus === 'paid'
    );
  }

  private routeCoverQty(dto: WarehouseCoverRouteDto, rollCount: number) {
    if (dto.status === 'needs_production') return 0;
    if (dto.status === 'full_proposed') return rollCount;
    if (rollCount <= 1) {
      throw new ConflictException('Partial warehouse cover requires more than one roll');
    }
    const requestedQty = Math.trunc(dto.coverQty ?? rollCount - 1);
    return Math.max(1, Math.min(rollCount - 1, requestedQty));
  }

  private aggregateWarehouseCoverStatus(statuses: string[]) {
    if (statuses.length === 0) return 'not_checked';
    if (statuses.every((status) => status === 'needs_production')) return 'needs_production';
    if (
      statuses.some(
        (status) =>
          status === 'partial_proposed' ||
          status === 'partial_confirmed' ||
          status === 'needs_production',
      )
    ) {
      return 'partial_proposed';
    }
    if (statuses.every((status) => status === 'full_proposed' || status === 'full_confirmed')) {
      return 'full_proposed';
    }
    return statuses.find((status) => status !== 'not_checked') ?? 'not_checked';
  }

  private editableCommercialOrderWhere(orderId: string): Prisma.CommercialOrderWhereInput {
    return {
      id: orderId,
      commercialLockedAt: null,
      commercialStage: { in: ['draft', 'incoming'] },
      paymentStatus: { notIn: ['partial', 'paid'] },
    };
  }
}
