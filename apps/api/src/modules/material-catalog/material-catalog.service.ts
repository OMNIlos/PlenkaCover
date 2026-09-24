import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RawMaterialCatalogItem, Role } from '@plenka/contracts';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CreateMaterialCatalogItemDto } from './dto/create-material-catalog-item.dto';
import { normalizeCatalogName } from './recipe-catalog.rules';

type MaterialCatalogActor = {
  userId: string | null;
  role: Role;
};

@Injectable()
export class MaterialCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query?: string): Promise<RawMaterialCatalogItem[]> {
    const normalizedQuery = query ? normalizeCatalogName(query) : '';
    const rows = await this.prisma.rawMaterialDefinition.findMany({
      where: {
        status: 'active',
        isProductionSelectable: true,
        ...(normalizedQuery ? { normalizedName: { contains: normalizedQuery } } : {}),
      },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, kind: true },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as RawMaterialCatalogItem['kind'],
    }));
  }

  async create(
    actor: MaterialCatalogActor,
    dto: CreateMaterialCatalogItemDto,
  ): Promise<RawMaterialCatalogItem> {
    const name = dto.name.trim().normalize('NFKC');
    const normalizedName = normalizeCatalogName(name);
    if (name.length < 1 || name.length > 120) {
      throw new BadRequestException('Название вида сырья должно содержать от 1 до 120 символов.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.rawMaterialDefinition.findUnique({
          where: { normalizedName },
          select: {
            id: true,
            name: true,
            kind: true,
            status: true,
            isProductionSelectable: true,
          },
        });
        if (existing?.status === 'active' && existing.isProductionSelectable) {
          throw new ConflictException({
            code: 'RAW_MATERIAL_TYPE_ALREADY_EXISTS',
            message: `Вид сырья «${existing.name}» уже есть в списке.`,
          });
        }

        const material = existing
          ? await tx.rawMaterialDefinition.update({
              where: { id: existing.id },
              data: {
                name,
                normalizedName,
                kind: 'custom',
                status: 'active',
                isProductionSelectable: true,
              },
              select: { id: true, name: true, kind: true },
            })
          : await tx.rawMaterialDefinition.create({
              data: {
                name,
                normalizedName,
                kind: 'custom',
                status: 'active',
                isProductionSelectable: true,
                createdById: actor.userId,
                createdByRole: actor.role,
              },
              select: { id: true, name: true, kind: true },
            });

        await this.audit.record(
          {
            type: 'audit:raw_material_definition_created',
            actorRole: actor.role,
            actorId: actor.userId,
            objectId: material.id,
            oldValue: existing
              ? {
                  name: existing.name,
                  status: existing.status,
                  isProductionSelectable: existing.isProductionSelectable,
                }
              : { exists: false },
            newValue: {
              name: material.name,
              status: 'active',
              isProductionSelectable: true,
            },
            detail: { source: 'admin_material_type_catalog' },
          },
          tx,
        );

        return {
          id: material.id,
          name: material.name,
          kind: material.kind as RawMaterialCatalogItem['kind'],
        };
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'RAW_MATERIAL_TYPE_ALREADY_EXISTS',
          message: `Вид сырья «${name}» уже есть в списке.`,
        });
      }
      throw error;
    }
  }
}
