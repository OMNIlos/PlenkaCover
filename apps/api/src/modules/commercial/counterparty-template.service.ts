import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  COMMERCIAL_BIRKA_OPTIONS,
  COMMERCIAL_FILM_TYPES,
  COMMERCIAL_SPOOL_OPTIONS,
  type PositionMaterialSelection,
  type Role,
} from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  RecipeCatalogService,
  type ResolvedRecipeSelection,
} from '../material-catalog/recipe-catalog.service';
import type {
  CounterpartyTemplatePosition,
  CounterpartyTemplateStatus,
  CreateCounterpartyTemplateDto,
  UpdateCounterpartyTemplateDto,
} from './dto/counterparty-template.dto';

export interface CounterpartyTemplateActor {
  userId: string | null;
  role: Role;
}

const MAX_COUNTERPARTY_TEMPLATES = 500;
const MAX_COUNTERPARTY_TEMPLATE_VERSIONS = 100;
const MAX_COUNTERPARTY_TEMPLATE_VERSION_ROWS = 2_000;

const counterpartyTemplateSelect = {
  id: true,
  counterpartyId: true,
  name: true,
  description: true,
  status: true,
  ownerRole: true,
  positions: true,
  usageCount: true,
  lastUsedAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  version: true,
  versions: {
    select: {
      id: true,
      templateId: true,
      version: true,
      positions: true,
      createdById: true,
      createdAt: true,
    },
    orderBy: [{ version: 'desc' as const }, { id: 'asc' as const }],
    take: MAX_COUNTERPARTY_TEMPLATE_VERSIONS + 1,
  },
} as const satisfies Prisma.CounterpartyOrderTemplateSelect;

type CounterpartyTemplateRow = Prisma.CounterpartyOrderTemplateGetPayload<{
  select: typeof counterpartyTemplateSelect;
}>;

function templateCatalogTooLarge(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'COUNTERPARTY_TEMPLATE_CATALOG_TOO_LARGE',
    message: 'Слишком много клиентских шаблонов. Уточните клиента или архивируйте лишние.',
  });
}

function templateHistoryTooLarge(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'COUNTERPARTY_TEMPLATE_HISTORY_TOO_LARGE',
    message: 'История шаблона слишком велика для безопасной выдачи.',
  });
}

function invalidTemplatePosition(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_COUNTERPARTY_TEMPLATE_POSITION',
    message: 'Template position contains a value outside the supported catalog.',
  });
}

function canonicalRecipeParameters(
  position: CounterpartyTemplatePosition,
  selection?: ResolvedRecipeSelection,
) {
  const parameters = [...(position.recipeParameters ?? [])];
  if (!selection) return parameters;

  const materialLabels = new Set(['сырье', 'сырьё']);
  const withoutMaterial = parameters.filter(
    ({ label }) => !materialLabels.has(label.trim().toLocaleLowerCase('ru')),
  );
  if (withoutMaterial.length === parameters.length && parameters.length >= 50) return parameters;
  return [...withoutMaterial, { label: 'Сырьё', value: selection.name }];
}

export function snapshotCounterpartyTemplatePosition(
  position: CounterpartyTemplatePosition,
  selection?: ResolvedRecipeSelection,
) {
  if (
    !COMMERCIAL_FILM_TYPES.includes(position.filmType as (typeof COMMERCIAL_FILM_TYPES)[number]) ||
    (position.spoolType != null &&
      !COMMERCIAL_SPOOL_OPTIONS.includes(
        position.spoolType as (typeof COMMERCIAL_SPOOL_OPTIONS)[number],
      )) ||
    (position.birka != null &&
      !COMMERCIAL_BIRKA_OPTIONS.includes(
        position.birka as (typeof COMMERCIAL_BIRKA_OPTIONS)[number],
      ))
  ) {
    throw invalidTemplatePosition();
  }

  const baseRawMaterialDefinitionId = selection
    ? (selection.baseRawMaterialDefinitionId ?? undefined)
    : position.baseRawMaterialDefinitionId;
  const recipeDefinitionVersionId = selection
    ? (selection.recipeDefinitionVersionId ?? undefined)
    : position.recipeDefinitionVersionId;
  return {
    rollCount: position.rollCount,
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    ...(position.widthMm !== undefined ? { widthMm: position.widthMm } : {}),
    ...(position.plannedLengthM !== undefined ? { plannedLengthM: position.plannedLengthM } : {}),
    ...(baseRawMaterialDefinitionId !== undefined ? { baseRawMaterialDefinitionId } : {}),
    ...(recipeDefinitionVersionId !== undefined ? { recipeDefinitionVersionId } : {}),
    ...(!selection && position.rawMaterialId !== undefined
      ? { rawMaterialId: position.rawMaterialId }
      : {}),
    ...(position.spoolType !== undefined ? { spoolType: position.spoolType } : {}),
    ...(position.birka !== undefined ? { birka: position.birka } : {}),
    ...(position.manualBirka !== undefined ? { manualBirka: position.manualBirka } : {}),
    ...(position.comment !== undefined ? { comment: position.comment } : {}),
    ...(position.plannedWeightKg !== undefined
      ? { plannedWeightKg: position.plannedWeightKg }
      : {}),
    recipeParameters: canonicalRecipeParameters(position, selection),
  };
}

function projectTemplate(row: CounterpartyTemplateRow) {
  if (row.versions.length > MAX_COUNTERPARTY_TEMPLATE_VERSIONS) {
    throw templateHistoryTooLarge();
  }
  return {
    id: row.id,
    counterpartyId: row.counterpartyId,
    name: row.name,
    description: row.description,
    status: row.status,
    ownerRole: row.ownerRole,
    positions: row.positions,
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
    versions: row.versions.map((version) => ({
      id: version.id,
      templateId: version.templateId,
      version: version.version,
      positions: version.positions,
      createdById: version.createdById,
      createdAt: version.createdAt,
    })),
  };
}

@Injectable()
export class CounterpartyTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly recipeCatalog: RecipeCatalogService,
  ) {}

  private async snapshotPositions(
    tx: Prisma.TransactionClient,
    positions: CounterpartyTemplatePosition[],
  ) {
    const catalogPositions = positions.flatMap((position, index) => {
      if (
        position.baseRawMaterialDefinitionId === undefined &&
        position.recipeDefinitionVersionId === undefined
      ) {
        return [];
      }
      return [
        {
          index,
          selector: {
            ...(position.baseRawMaterialDefinitionId !== undefined
              ? { baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId }
              : {}),
            ...(position.recipeDefinitionVersionId !== undefined
              ? { recipeDefinitionVersionId: position.recipeDefinitionVersionId }
              : {}),
          } as PositionMaterialSelection,
        },
      ];
    });
    const selections = catalogPositions.length
      ? await this.recipeCatalog.resolveSelections(
          tx,
          catalogPositions.map(({ selector }) => selector),
        )
      : [];
    if (selections.length !== catalogPositions.length) {
      throw new InternalServerErrorException('Recipe selection resolution invariant failed');
    }
    const selectionByPosition = new Map(
      catalogPositions.map(({ index }, selectionIndex) => [index, selections[selectionIndex]!]),
    );
    return positions.map((position, index) =>
      snapshotCounterpartyTemplatePosition(position, selectionByPosition.get(index)),
    );
  }

  async listForCounterparty(counterpartyId: string) {
    return this.prisma.$transaction(
      async (tx) => {
        const roots = await tx.counterpartyOrderTemplate.findMany({
          where: { counterpartyId, status: { in: ['active', 'archived'] } },
          select: { id: true },
          orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
          take: MAX_COUNTERPARTY_TEMPLATES + 1,
        });
        if (roots.length > MAX_COUNTERPARTY_TEMPLATES) throw templateCatalogTooLarge();
        const ids = roots.map(({ id }) => id);
        if (ids.length === 0) return [];

        const versionRoots = await tx.counterpartyOrderTemplateVersion.findMany({
          where: { templateId: { in: ids } },
          select: { id: true, templateId: true },
          orderBy: [{ templateId: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: MAX_COUNTERPARTY_TEMPLATE_VERSION_ROWS + 1,
        });
        if (versionRoots.length > MAX_COUNTERPARTY_TEMPLATE_VERSION_ROWS) {
          throw templateHistoryTooLarge();
        }
        const versionCounts = new Map<string, number>();
        for (const version of versionRoots) {
          const count = (versionCounts.get(version.templateId) ?? 0) + 1;
          if (count > MAX_COUNTERPARTY_TEMPLATE_VERSIONS) throw templateHistoryTooLarge();
          versionCounts.set(version.templateId, count);
        }

        const rows = await tx.counterpartyOrderTemplate.findMany({
          where: { id: { in: ids } },
          select: counterpartyTemplateSelect,
          orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
        });
        return rows.map(projectTemplate);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async create(
    actor: CounterpartyTemplateActor,
    counterpartyId: string,
    dto: CreateCounterpartyTemplateDto,
  ) {
    const counterparty = await this.prisma.counterparty.findUnique({
      where: { id: counterpartyId },
    });
    if (!counterparty) {
      throw new NotFoundException(`Counterparty ${counterpartyId} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      const positions = await this.snapshotPositions(tx, dto.positions);
      const positionsSnapshot = positions as unknown as Prisma.InputJsonValue;
      const created = await tx.counterpartyOrderTemplate.create({
        data: {
          counterpartyId,
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          ownerRole: 'production_lead',
          createdById: actor.userId,
          positions: positionsSnapshot,
          version: 1,
        },
      });
      const createdVersion = await tx.counterpartyOrderTemplateVersion.create({
        data: {
          templateId: created.id,
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
          objectId: created.id,
          label: `Counterparty template ${created.name} created`,
          detail: { counterpartyId, positionCount: positions.length, version: 1 },
        },
        tx,
      );
      return projectTemplate({ ...created, versions: [createdVersion] });
    });
  }

  async update(
    actor: CounterpartyTemplateActor,
    counterpartyId: string,
    templateId: string,
    dto: UpdateCounterpartyTemplateDto,
  ) {
    const existing = await this.prisma.counterpartyOrderTemplate.findFirst({
      where: { id: templateId, counterpartyId, status: 'active' },
    });
    if (!existing) {
      throw new NotFoundException(
        `Template ${templateId} not found for counterparty ${counterpartyId}`,
      );
    }
    if (existing.version >= MAX_COUNTERPARTY_TEMPLATE_VERSIONS) {
      throw templateHistoryTooLarge();
    }

    return this.prisma.$transaction(async (tx) => {
      const positions = await this.snapshotPositions(tx, dto.positions);
      const nextVersion = existing.version + 1;
      const positionsSnapshot = positions as unknown as Prisma.InputJsonValue;
      const result = await tx.counterpartyOrderTemplate.updateMany({
        where: {
          id: templateId,
          counterpartyId,
          status: 'active',
          version: existing.version,
        },
        data: {
          name: dto.name.trim(),
          description: dto.description?.trim() || null,
          positions: positionsSnapshot,
          version: nextVersion,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Template changed concurrently; reload and retry');
      }
      await tx.counterpartyOrderTemplateVersion.create({
        data: {
          templateId,
          version: nextVersion,
          positions: positionsSnapshot,
          createdById: actor.userId,
        },
      });
      await this.audit.record(
        {
          type: 'audit:counterparty_template_updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: templateId,
          label: `Counterparty template ${dto.name.trim()} updated`,
          detail: { counterpartyId, positionCount: positions.length },
          oldValue: { version: existing.version, positions: existing.positions },
          newValue: { version: nextVersion, positions: positionsSnapshot },
        },
        tx,
      );
      const updated = await tx.counterpartyOrderTemplate.findUnique({
        where: { id: templateId },
        select: counterpartyTemplateSelect,
      });
      if (!updated) throw new NotFoundException(`Template ${templateId} not found after update`);
      return projectTemplate(updated);
    });
  }

  async updateStatus(
    actor: CounterpartyTemplateActor,
    counterpartyId: string,
    templateId: string,
    status: CounterpartyTemplateStatus,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.counterpartyOrderTemplate.findFirst({
        where: { id: templateId, counterpartyId },
        select: counterpartyTemplateSelect,
      });
      if (!existing) {
        throw new NotFoundException(
          `Template ${templateId} not found for counterparty ${counterpartyId}`,
        );
      }
      if (existing.status === status) return projectTemplate(existing);

      const result = await tx.counterpartyOrderTemplate.updateMany({
        where: { id: templateId, counterpartyId, status: existing.status },
        data: { status },
      });
      if (result.count !== 1) {
        throw new ConflictException('Template changed concurrently; reload and retry');
      }
      await this.audit.record(
        {
          type: 'audit:counterparty_template_updated',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: templateId,
          label: `Counterparty template ${existing.name} status changed to ${status}`,
          detail: { counterpartyId, status },
          oldValue: { status: existing.status },
          newValue: { status },
        },
        tx,
      );
      const updated = await tx.counterpartyOrderTemplate.findUnique({
        where: { id: templateId },
        select: counterpartyTemplateSelect,
      });
      if (!updated) throw new NotFoundException(`Template ${templateId} not found after update`);
      return projectTemplate(updated);
    });
  }
}
