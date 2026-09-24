import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Role } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateStockProductionTemplateDto,
  StockProductionTemplatePositionDto,
  StockProductionTemplateResponseDto,
  StockProductionTemplateVersionResponseDto,
  UpdateStockProductionTemplateDto,
} from './dto/stock-production-template.dto';

const MAX_STOCK_TEMPLATE_ROWS = 500;
const MAX_STOCK_TEMPLATE_VERSIONS_PER_TEMPLATE = 100;
const MAX_STOCK_TEMPLATE_VERSION_ROWS = 2_000;

const templateInclude = {
  versions: {
    orderBy: [{ version: 'desc' as const }, { id: 'asc' as const }],
    take: MAX_STOCK_TEMPLATE_VERSIONS_PER_TEMPLATE + 1,
  },
} satisfies Prisma.StockProductionTemplateInclude;

type StockTemplateRow = Prisma.StockProductionTemplateGetPayload<{
  include: typeof templateInclude;
}>;

export interface StockTemplateActor {
  userId: string | null;
  role: Role;
}

function normalizeTemplateName(value: string): { name: string; normalizedName: string } {
  const name = value.trim().normalize('NFKC');
  const canonicalName = name.toLocaleLowerCase('ru-RU');
  const normalizedName = canonicalName === 'aйка' ? 'айка' : canonicalName;
  const nameLength = [...name].length;
  const normalizedNameLength = [...normalizedName].length;
  if (
    nameLength < 1 ||
    nameLength > 200 ||
    normalizedNameLength < 1 ||
    normalizedNameLength > 200
  ) {
    throw new BadRequestException(
      'Stock production template name must normalize to between 1 and 200 characters',
    );
  }
  return { name, normalizedName };
}

function normalizeDescription(value?: string): string | null {
  return value?.trim().normalize('NFKC') || null;
}

function conflict(message: string): ConflictException {
  return new ConflictException(message);
}

function snapshotPosition(
  position: StockProductionTemplatePositionDto,
): StockProductionTemplatePositionDto {
  return {
    rollCount: position.rollCount,
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    ...(position.widthMm !== undefined ? { widthMm: position.widthMm } : {}),
    ...(position.plannedLengthM !== undefined ? { plannedLengthM: position.plannedLengthM } : {}),
    ...(position.baseRawMaterialDefinitionId !== undefined
      ? { baseRawMaterialDefinitionId: position.baseRawMaterialDefinitionId }
      : {}),
    ...(position.recipeDefinitionVersionId !== undefined
      ? { recipeDefinitionVersionId: position.recipeDefinitionVersionId }
      : {}),
    ...(position.spoolType !== undefined ? { spoolType: position.spoolType } : {}),
    ...(position.birka !== undefined ? { birka: position.birka } : {}),
    ...(position.manualBirka !== undefined ? { manualBirka: position.manualBirka } : {}),
    ...(position.comment !== undefined ? { comment: position.comment } : {}),
    ...(position.plannedWeightKg !== undefined
      ? { plannedWeightKg: position.plannedWeightKg }
      : {}),
    recipeParameters: (position.recipeParameters ?? []).map((parameter) => ({
      label: parameter.label,
      value: parameter.value,
    })),
  };
}

function projectPositions(value: Prisma.JsonValue): StockProductionTemplatePositionDto[] {
  if (!Array.isArray(value)) return [];
  return value.map((position) =>
    snapshotPosition(position as unknown as StockProductionTemplatePositionDto),
  );
}

function projectVersion(
  version: StockTemplateRow['versions'][number],
): StockProductionTemplateVersionResponseDto {
  return {
    id: version.id,
    templateId: version.templateId,
    version: version.version,
    positions: projectPositions(version.positions),
    createdAt: version.createdAt.toISOString(),
  };
}

function projectTemplate(row: StockTemplateRow): StockProductionTemplateResponseDto {
  if (row.versions.length > MAX_STOCK_TEMPLATE_VERSIONS_PER_TEMPLATE) {
    throw catalogTooLarge();
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status === 'archived' ? 'archived' : 'active',
    version: row.version,
    positions: projectPositions(row.positions),
    versions: row.versions.map(projectVersion),
    usageCount: row.usageCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function catalogTooLarge(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    code: 'STOCK_PRODUCTION_TEMPLATE_CATALOG_TOO_LARGE',
    message: 'Каталог шаблонов слишком велик для безопасной выдачи.',
  });
}

@Injectable()
export class StockProductionTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<StockProductionTemplateResponseDto[]> {
    return this.prisma.$transaction(
      async (tx) => {
        const roots = await tx.stockProductionTemplate.findMany({
          where: { status: 'active' },
          select: { id: true },
          orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
          take: MAX_STOCK_TEMPLATE_ROWS + 1,
        });
        if (roots.length > MAX_STOCK_TEMPLATE_ROWS) throw catalogTooLarge();
        const ids = roots.map(({ id }) => id);
        if (ids.length === 0) return [];
        const versionRoots = await tx.stockProductionTemplateVersion.findMany({
          where: { templateId: { in: ids } },
          select: { id: true, templateId: true },
          orderBy: [{ templateId: 'asc' }, { version: 'desc' }, { id: 'asc' }],
          take: MAX_STOCK_TEMPLATE_VERSION_ROWS + 1,
        });
        if (versionRoots.length > MAX_STOCK_TEMPLATE_VERSION_ROWS) throw catalogTooLarge();
        const versionCounts = new Map<string, number>();
        for (const version of versionRoots) {
          const count = (versionCounts.get(version.templateId) ?? 0) + 1;
          if (count > MAX_STOCK_TEMPLATE_VERSIONS_PER_TEMPLATE) throw catalogTooLarge();
          versionCounts.set(version.templateId, count);
        }
        const rows = await tx.stockProductionTemplate.findMany({
          where: { id: { in: ids } },
          include: templateInclude,
          orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }, { id: 'asc' }],
        });
        return rows.map(projectTemplate);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async create(
    actor: StockTemplateActor,
    dto: CreateStockProductionTemplateDto,
  ): Promise<StockProductionTemplateResponseDto> {
    const { name, normalizedName } = normalizeTemplateName(dto.name);
    return this.createTransaction(actor, dto, name, normalizedName);
  }

  async update(
    actor: StockTemplateActor,
    templateId: string,
    dto: UpdateStockProductionTemplateDto,
  ): Promise<StockProductionTemplateResponseDto> {
    const { name, normalizedName } = normalizeTemplateName(dto.name);
    return this.updateTransaction(actor, templateId, dto, name, normalizedName);
  }

  private async createTransaction(
    actor: StockTemplateActor,
    dto: CreateStockProductionTemplateDto,
    name: string,
    normalizedName: string,
  ): Promise<StockProductionTemplateResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.assertUniqueName(tx, normalizedName);
        const positions = dto.positions.map(snapshotPosition);
        const positionsSnapshot = positions as unknown as Prisma.InputJsonValue;

        const created = await tx.stockProductionTemplate.create({
          data: {
            name,
            normalizedName,
            description: normalizeDescription(dto.description),
            status: 'active',
            positions: positionsSnapshot,
            createdById: actor.userId,
            version: 1,
          },
        });
        const version = await tx.stockProductionTemplateVersion.create({
          data: {
            templateId: created.id,
            version: 1,
            positions: positionsSnapshot,
            createdById: actor.userId,
          },
        });
        await this.audit.record(
          {
            type: 'audit:stock_production_template_created',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: created.id,
            label: `Stock production template ${created.name} created`,
            detail: { positionCount: positions.length, version: 1 },
          },
          tx,
        );

        return projectTemplate({ ...created, versions: [version] });
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw this.nameConflict();
      throw error;
    }
  }

  private async updateTransaction(
    actor: StockTemplateActor,
    templateId: string,
    dto: UpdateStockProductionTemplateDto,
    name: string,
    normalizedName: string,
  ): Promise<StockProductionTemplateResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.stockProductionTemplate.findFirst({
          where: { id: templateId, status: 'active' },
        });
        if (!existing) {
          throw new NotFoundException(`Stock production template ${templateId} not found`);
        }
        if (existing.version !== dto.expectedVersion) {
          throw conflict('Template changed concurrently; reload and retry');
        }
        if (existing.version >= MAX_STOCK_TEMPLATE_VERSIONS_PER_TEMPLATE) {
          throw catalogTooLarge();
        }

        await this.assertUniqueName(tx, normalizedName, templateId);
        const description = normalizeDescription(dto.description);
        const positions = dto.positions.map(snapshotPosition);
        const positionsSnapshot = positions as unknown as Prisma.InputJsonValue;
        const nextVersion = dto.expectedVersion + 1;
        const updated = await tx.stockProductionTemplate.updateMany({
          where: {
            id: templateId,
            status: 'active',
            version: dto.expectedVersion,
          },
          data: {
            name,
            normalizedName,
            description,
            positions: positionsSnapshot,
            version: nextVersion,
          },
        });
        if (updated.count !== 1) {
          throw conflict('Template changed concurrently; reload and retry');
        }

        await tx.stockProductionTemplateVersion.create({
          data: {
            templateId,
            version: nextVersion,
            positions: positionsSnapshot,
            createdById: actor.userId,
          },
        });
        await this.audit.record(
          {
            type: 'audit:stock_production_template_updated',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: templateId,
            label: `Stock production template ${name} updated`,
            detail: { positionCount: positions.length, version: nextVersion },
            oldValue: {
              name: existing.name,
              description: existing.description,
              version: existing.version,
              positions: existing.positions,
            },
            newValue: {
              name,
              description,
              version: nextVersion,
              positions: positionsSnapshot,
            },
          },
          tx,
        );

        const row = await tx.stockProductionTemplate.findUnique({
          where: { id: templateId },
          include: templateInclude,
        });
        if (!row) {
          throw new NotFoundException(`Stock production template ${templateId} not found`);
        }
        return projectTemplate(row);
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw this.nameConflict();
      throw error;
    }
  }

  private async assertUniqueName(
    tx: Prisma.TransactionClient,
    normalizedName: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await tx.stockProductionTemplate.findUnique({
      where: { normalizedName },
      select: { id: true },
    });
    if (existing && existing.id !== excludeId) {
      throw this.nameConflict();
    }
  }

  private isUniqueConflict(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private nameConflict(): ConflictException {
    return conflict('A stock production template with this name already exists');
  }
}
