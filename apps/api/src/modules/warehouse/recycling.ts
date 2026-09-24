import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';
import type { AuditService } from '../../common/audit/audit.service';
import { normalizeCatalogName } from '../material-catalog/recipe-catalog.rules';

type RecyclePrisma = Pick<
  Prisma.TransactionClient,
  'rawMaterialDefinition' | 'rawMaterialStock' | 'domainEvent'
>;

const MAX_CATALOG_NAME_LENGTH = 120;

function canonicalAuditQuantity(value: number) {
  const rounded = Number(value.toFixed(6));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function fitsCatalogName(name: string): boolean {
  return (
    name === name.trim() &&
    [...name].length <= MAX_CATALOG_NAME_LENGTH &&
    [...normalizeCatalogName(name)].length <= MAX_CATALOG_NAME_LENGTH
  );
}

function recycledDefinitionName(materialId: string, materialLabel: string | null, base: string) {
  const sourceName =
    materialLabel?.trim().normalize('NFKC') || base.trim().normalize('NFKC') || 'unknown';
  const candidate = `Вторсырьё ${sourceName}`;
  if (fitsCatalogName(candidate)) return candidate;

  const digest = createHash('sha256').update(materialId).digest('hex').slice(0, 12);
  const suffix = ` · ${digest}`;
  const characters = [...candidate];
  const maxPrefixLength = Math.min(characters.length, MAX_CATALOG_NAME_LENGTH - [...suffix].length);
  for (let length = maxPrefixLength; length >= 0; length -= 1) {
    const bounded = `${characters.slice(0, length).join('').trimEnd()}${suffix}`;
    if (fitsCatalogName(bounded)) return bounded;
  }
  throw new ConflictException({
    code: 'RAW_MATERIAL_DEFINITION_NAME_INVALID',
    message: 'Не удалось сформировать безопасное имя вторсырья.',
  });
}

/**
 * Брак уходит на переработку и возвращается вторсырьём (промпт склада, дизайн
 * 2026-07-13 §8): вес брака приходуется на позицию `rm-secondary-<база>` склада.
 * Используется и складом (брак на приёмке), и производством (resolve операторского
 * брака) — источник физического факта пишет событие ровно один раз.
 */
export async function recycleDefectToSecondaryStock(
  prisma: RecyclePrisma,
  audit: Pick<AuditService, 'record'>,
  actor: { userId: string | null; role: Role },
  input: {
    rawMaterialId: string | null;
    materialLabel: string | null;
    kg: number;
    rollCode: string;
    problemId?: string;
    resolution?: 'rework' | 'writeoff';
    note?: string;
  },
): Promise<{ materialId: string; actualQty: number } | null> {
  if (!(input.kg > 0)) return null;
  const base = (input.rawMaterialId ?? 'unknown').replace(/^rm-/, '');
  const materialId = `rm-secondary-${base}`;
  const label = recycledDefinitionName(materialId, input.materialLabel, base);
  const normalizedName = normalizeCatalogName(label);
  const existing = await prisma.rawMaterialStock.findUnique({
    where: { materialId },
    select: { actualQty: true, rawMaterialDefinitionId: true },
  });
  let rawMaterialDefinitionId = existing?.rawMaterialDefinitionId ?? null;
  if (!rawMaterialDefinitionId) {
    const definitionData = {
      name: label,
      normalizedName,
      kind: 'custom',
      status: 'active',
      createdById: actor.userId,
      createdByRole: actor.role,
    };
    const inserted = await prisma.rawMaterialDefinition.createMany({
      data: [definitionData],
      skipDuplicates: true,
    });
    const definition = await prisma.rawMaterialDefinition.findUnique({
      where: { normalizedName },
      select: { id: true, name: true },
    });
    if (!definition) {
      throw new ConflictException({
        code: 'RAW_MATERIAL_DEFINITION_CONCURRENT_UPDATE',
        message: 'Каталог сырья изменился параллельно; повторите операцию.',
      });
    }
    if (inserted.count === 1) {
      await audit.record(
        {
          type: 'audit:raw_material_definition_created',
          actorRole: actor.role,
          actorId: actor.userId,
          objectId: definition.id,
          label: `Raw material ${definition.name} created`,
          detail: { name: definition.name, kind: 'custom', source: 'defect_recycling' },
        },
        prisma,
      );
    }
    rawMaterialDefinitionId = definition.id;
  }
  const updated = await prisma.rawMaterialStock.upsert({
    where: { materialId },
    update: {
      actualQty: { increment: input.kg },
      ...(existing?.rawMaterialDefinitionId ? {} : { rawMaterialDefinitionId }),
    },
    create: {
      materialId,
      label,
      actualQty: input.kg,
      unit: 'кг',
      factStatus: 'warehouse_fact',
      rawMaterialDefinitionId,
    },
  });
  const previousActualQty = canonicalAuditQuantity(updated.actualQty - input.kg);
  const event = {
    type: 'audit:warehouse_roll_defect_recycled',
    actorRole: actor.role,
    actorId: actor.userId,
    objectId: input.rollCode,
    reason: input.note,
    oldValue: { actualQty: previousActualQty },
    newValue: { actualQty: canonicalAuditQuantity(updated.actualQty) },
    detail: {
      materialId,
      recycledKg: input.kg,
      rollCode: input.rollCode,
      problemId: input.problemId ?? null,
      resolution: input.resolution ?? null,
      note: input.note ?? null,
    },
  } as const;
  await audit.record(event, prisma);
  return { materialId, actualQty: updated.actualQty };
}
