import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  RecordSpoolPriceReferenceInput,
  RecordSpoolStockReceiptInput,
  SpoolPriceReferenceView,
  SpoolPriceTypeView,
  SpoolStockReceiptView,
  SpoolStockSummaryItemView,
} from '@plenka/contracts';
import { Prisma } from '@prisma/client';
import type { Actor } from '../../common/auth/actor';
import { AuditService } from '../../common/audit/audit.service';
import { requestFingerprint } from '../../common/idempotency/request-fingerprint';
import { normalizeSpoolTypeKey } from '../../common/production-cost/production-cost-calculator';
import { PrismaService } from '../../common/prisma/prisma.service';

const MAX_OBSERVED_SPOOL_TYPES = 500;

type SpoolPriceRow = {
  id: string;
  operationKey: string;
  requestFingerprint: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  priceKopecksPerMeter: bigint;
  source: string;
  effectiveFrom: Date;
  reason: string;
  createdById: string;
  createdByRole: SpoolPriceReferenceView['createdByRole'];
  createdAt: Date;
};

type PriceClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'spoolPriceReference'>;

type ReceiptClient = Pick<
  Prisma.TransactionClient,
  '$queryRaw' | '$executeRaw' | 'spoolPriceReference' | 'spoolStockReceipt'
>;

type SpoolReceiptRow = {
  id: string;
  operationKey: string;
  requestFingerprint: string;
  spoolTypeKey: string;
  spoolTypeLabel: string;
  quantityMillimeters: bigint;
  priceReferenceId: string;
  priceReference: SpoolPriceRow;
  receivedAt: Date;
  receivedById: string;
  receivedByRole: SpoolStockReceiptView['receivedByRole'];
  createdAt: Date;
};

function normalizedText(value: string, code: string): string {
  const normalized = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    throw new BadRequestException({ code, message: 'Значение не может быть пустым.' });
  }
  return normalized;
}

function normalizedObservedLabel(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function instant(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new BadRequestException({
      code: 'SPOOL_PRICE_DATE_INVALID',
      message: 'Указана некорректная дата начала действия цены.',
    });
  }
  return result;
}

function view(row: SpoolPriceRow): SpoolPriceReferenceView {
  const price = Number(row.priceKopecksPerMeter);
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new RangeError('stored spool price is outside the safe integer range');
  }
  return {
    id: row.id,
    spoolTypeKey: row.spoolTypeKey,
    spoolTypeLabel: row.spoolTypeLabel,
    priceKopecksPerMeter: price,
    source: row.source,
    effectiveFrom: row.effectiveFrom.toISOString(),
    reason: row.reason,
    createdById: row.createdById,
    createdByRole: row.createdByRole,
    createdAt: row.createdAt.toISOString(),
  };
}

function receiptView(row: SpoolReceiptRow): SpoolStockReceiptView {
  const quantity = Number(row.quantityMillimeters);
  const price = Number(row.priceReference.priceKopecksPerMeter);
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new RangeError('stored spool receipt quantity is outside the safe integer range');
  }
  if (!Number.isSafeInteger(price) || price <= 0) {
    throw new RangeError('stored spool price is outside the safe integer range');
  }
  return {
    id: row.id,
    spoolTypeKey: row.spoolTypeKey,
    spoolTypeLabel: row.spoolTypeLabel,
    quantityMillimeters: quantity,
    priceReferenceId: row.priceReferenceId,
    priceKopecksPerMeter: price,
    effectiveFrom: row.priceReference.effectiveFrom.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    receivedById: row.receivedById,
    receivedByRole: row.receivedByRole,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class WarehouseSpoolPriceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  listObservedTypes(): Promise<SpoolPriceTypeView[]> {
    return this.loadObservedTypes(this.prisma);
  }

  async listStock(): Promise<SpoolStockSummaryItemView[]> {
    const observed = await this.loadObservedTypes(this.prisma);
    const aggregates = await this.prisma.spoolStockReceipt.groupBy({
      by: ['spoolTypeKey'],
      _sum: { quantityMillimeters: true },
      _max: { receivedAt: true },
    });
    const totals = new Map(aggregates.map((aggregate) => [aggregate.spoolTypeKey, aggregate]));
    return observed.map(({ key, label }) => {
      const aggregate = totals.get(key);
      const totalReceivedMillimeters = Number(aggregate?._sum.quantityMillimeters ?? 0n);
      if (!Number.isSafeInteger(totalReceivedMillimeters) || totalReceivedMillimeters < 0) {
        throw new RangeError('stored spool receipt total is outside the safe integer range');
      }
      return {
        spoolTypeKey: key,
        spoolTypeLabel: label,
        totalReceivedMillimeters,
        lastReceivedAt: aggregate?._max.receivedAt?.toISOString() ?? null,
      };
    });
  }

  async record(
    actor: Actor,
    dto: RecordSpoolPriceReferenceInput,
  ): Promise<SpoolPriceReferenceView> {
    const actorId = actor.userId;
    if (!actorId) {
      throw new UnauthorizedException({
        code: 'SPOOL_PRICE_USER_REQUIRED',
        message: 'Для изменения цены требуется пользовательская сессия.',
      });
    }
    if (!Number.isSafeInteger(dto.priceKopecksPerMeter) || dto.priceKopecksPerMeter <= 0) {
      throw new BadRequestException({
        code: 'SPOOL_PRICE_AMOUNT_INVALID',
        message: 'Цена шпули должна быть положительным целым числом копеек.',
      });
    }
    const requestedLabel = normalizedObservedLabel(dto.spoolTypeLabel);
    const command = {
      operationKey: dto.operationKey,
      spoolTypeLabel: requestedLabel,
      spoolTypeKey: normalizeSpoolTypeKey(requestedLabel),
      priceKopecksPerMeter: dto.priceKopecksPerMeter,
      source: normalizedText(dto.source, 'SPOOL_PRICE_SOURCE_REQUIRED'),
      effectiveFrom: instant(dto.effectiveFrom).toISOString(),
      reason: normalizedText(dto.reason, 'SPOOL_PRICE_REASON_REQUIRED'),
    };
    const fingerprint = requestFingerprint(command);
    const existing = await this.findByOperationKey(this.prisma, command.operationKey);
    if (existing) return this.replay(existing, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockPriceIdentity(tx, command.spoolTypeKey, command.effectiveFrom);
        const replay = await this.findByOperationKey(tx, command.operationKey);
        if (replay) return this.replay(replay, fingerprint);
        const observed = await this.loadObservedTypes(tx);
        const selected = observed.find(
          ({ key, label }) => key === command.spoolTypeKey && label === command.spoolTypeLabel,
        );
        if (!selected) {
          throw new NotFoundException({
            code: 'SPOOL_PRICE_TYPE_NOT_OBSERVED',
            message: 'Тип шпули отсутствует в подтверждённых заказах и снимках выпуска.',
          });
        }
        const created = await tx.spoolPriceReference.create({
          data: {
            operationKey: command.operationKey,
            requestFingerprint: fingerprint,
            spoolTypeKey: selected.key,
            spoolTypeLabel: selected.label,
            priceKopecksPerMeter: BigInt(command.priceKopecksPerMeter),
            source: command.source,
            effectiveFrom: new Date(command.effectiveFrom),
            reason: command.reason,
            createdById: actorId,
            createdByRole: actor.role,
          },
        });
        await this.audit.record(
          {
            type: 'audit:spool_price_reference_recorded',
            actorRole: actor.role,
            actorId,
            objectId: created.id,
            reason: command.reason,
            newValue: {
              spoolTypeKey: selected.key,
              spoolTypeLabel: selected.label,
              priceKopecksPerMeter: command.priceKopecksPerMeter,
              source: command.source,
              effectiveFrom: command.effectiveFrom,
            },
          },
          tx,
        );
        return view(created as SpoolPriceRow);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByOperationKey(this.prisma, command.operationKey);
        if (winner) return this.replay(winner, fingerprint);
        throw new ConflictException({
          code: 'SPOOL_PRICE_EFFECTIVE_DATE_CONFLICT',
          message: 'Для типа шпули уже зафиксирована цена с этой датой начала действия.',
        });
      }
      throw error;
    }
  }

  async recordReceipt(
    actor: Actor,
    dto: RecordSpoolStockReceiptInput,
  ): Promise<SpoolStockReceiptView> {
    const actorId = actor.userId;
    if (!actorId) {
      throw new UnauthorizedException({
        code: 'SPOOL_STOCK_USER_REQUIRED',
        message: 'Для приёма шпуль требуется пользовательская сессия.',
      });
    }
    if (!Number.isSafeInteger(dto.priceKopecksPerMeter) || dto.priceKopecksPerMeter <= 0) {
      throw new BadRequestException({
        code: 'SPOOL_PRICE_AMOUNT_INVALID',
        message: 'Цена шпули должна быть положительным целым числом копеек.',
      });
    }
    if (!Number.isSafeInteger(dto.quantityMillimeters) || dto.quantityMillimeters <= 0) {
      throw new BadRequestException({
        code: 'SPOOL_STOCK_QUANTITY_INVALID',
        message: 'Количество шпуль должно быть положительным числом миллиметров.',
      });
    }
    const requestedLabel = normalizedObservedLabel(dto.spoolTypeLabel);
    const command = {
      operationKey: dto.operationKey,
      spoolTypeLabel: requestedLabel,
      spoolTypeKey: normalizeSpoolTypeKey(requestedLabel),
      priceKopecksPerMeter: dto.priceKopecksPerMeter,
      quantityMillimeters: dto.quantityMillimeters,
      source: normalizedText(dto.source, 'SPOOL_PRICE_SOURCE_REQUIRED'),
      effectiveFrom: instant(dto.effectiveFrom).toISOString(),
      reason: normalizedText(dto.reason, 'SPOOL_PRICE_REASON_REQUIRED'),
    };
    const fingerprint = requestFingerprint(command);
    const existing = await this.findReceiptByOperationKey(this.prisma, command.operationKey);
    if (existing) return this.replayReceipt(existing, fingerprint);

    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockPriceIdentity(tx, command.spoolTypeKey, command.effectiveFrom);
        const replay = await this.findReceiptByOperationKey(tx, command.operationKey);
        if (replay) return this.replayReceipt(replay, fingerprint);
        const observed = await this.loadObservedTypes(tx);
        const selected = observed.find(
          ({ key, label }) => key === command.spoolTypeKey && label === command.spoolTypeLabel,
        );
        if (!selected) {
          throw new NotFoundException({
            code: 'SPOOL_PRICE_TYPE_NOT_OBSERVED',
            message: 'Тип шпули отсутствует в подтверждённых заказах и снимках выпуска.',
          });
        }

        let price = (await tx.spoolPriceReference.findUnique({
          where: {
            spoolTypeKey_effectiveFrom: {
              spoolTypeKey: selected.key,
              effectiveFrom: new Date(command.effectiveFrom),
            },
          },
        })) as SpoolPriceRow | null;
        if (price) {
          if (price.priceKopecksPerMeter !== BigInt(command.priceKopecksPerMeter)) {
            throw new ConflictException({
              code: 'SPOOL_PRICE_EFFECTIVE_DATE_CONFLICT',
              message: 'Для типа шпули уже зафиксирована другая цена с этой датой.',
            });
          }
        } else {
          price = (await tx.spoolPriceReference.create({
            data: {
              operationKey: command.operationKey,
              requestFingerprint: fingerprint,
              spoolTypeKey: selected.key,
              spoolTypeLabel: selected.label,
              priceKopecksPerMeter: BigInt(command.priceKopecksPerMeter),
              source: command.source,
              effectiveFrom: new Date(command.effectiveFrom),
              reason: command.reason,
              createdById: actorId,
              createdByRole: actor.role,
            },
          })) as SpoolPriceRow;
          await this.audit.record(
            {
              type: 'audit:spool_price_reference_recorded',
              actorRole: actor.role,
              actorId,
              objectId: price.id,
              reason: command.reason,
              newValue: {
                spoolTypeKey: selected.key,
                spoolTypeLabel: selected.label,
                priceKopecksPerMeter: command.priceKopecksPerMeter,
                source: command.source,
                effectiveFrom: command.effectiveFrom,
              },
            },
            tx,
          );
        }

        const receipt = await tx.spoolStockReceipt.create({
          data: {
            operationKey: command.operationKey,
            requestFingerprint: fingerprint,
            spoolTypeKey: selected.key,
            spoolTypeLabel: selected.label,
            quantityMillimeters: BigInt(command.quantityMillimeters),
            priceReferenceId: price.id,
            receivedAt: new Date(command.effectiveFrom),
            receivedById: actorId,
            receivedByRole: actor.role,
          },
          include: { priceReference: true },
        });
        await this.audit.record(
          {
            type: 'audit:spool_stock_receipt_recorded',
            actorRole: actor.role,
            actorId,
            objectId: receipt.id,
            reason: command.reason,
            newValue: {
              spoolTypeKey: selected.key,
              spoolTypeLabel: selected.label,
              quantityMillimeters: command.quantityMillimeters,
              priceReferenceId: price.id,
              priceKopecksPerMeter: command.priceKopecksPerMeter,
              effectiveFrom: command.effectiveFrom,
            },
          },
          tx,
        );
        return receiptView(receipt as SpoolReceiptRow);
      });
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException ||
        error instanceof NotFoundException ||
        error instanceof ConflictException
      ) {
        throw error;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findReceiptByOperationKey(this.prisma, command.operationKey);
        if (winner) return this.replayReceipt(winner, fingerprint);
        throw new ConflictException({
          code: 'SPOOL_PRICE_EFFECTIVE_DATE_CONFLICT',
          message: 'Для типа шпули уже зафиксирована цена с этой датой начала действия.',
        });
      }
      throw error;
    }
  }

  private async loadObservedTypes(client: PriceClient): Promise<SpoolPriceTypeView[]> {
    const rows = await client.$queryRaw<Array<{ label: string }>>(Prisma.sql`
      SELECT label
      FROM (
        SELECT DISTINCT "spoolType" AS label
        FROM "commercial_order_positions"
        WHERE "spoolType" IS NOT NULL
        UNION
        SELECT DISTINCT "characteristicsSnapshot" ->> 'spoolType' AS label
        FROM "roll_dispatch_items"
        WHERE jsonb_typeof("characteristicsSnapshot") = 'object'
          AND jsonb_typeof("characteristicsSnapshot" -> 'spoolType') = 'string'
      ) observed_spool_types
      WHERE label IS NOT NULL
      ORDER BY label
      LIMIT ${MAX_OBSERVED_SPOOL_TYPES + 1}
    `);
    if (rows.length > MAX_OBSERVED_SPOOL_TYPES) {
      throw new ConflictException({
        code: 'SPOOL_PRICE_TYPE_CATALOG_TOO_LARGE',
        message: 'Каталог типов шпуль превышает безопасный предел.',
      });
    }
    const labelsByKey = new Map<string, Set<string>>();
    for (const row of rows) {
      if (typeof row.label !== 'string') continue;
      const label = normalizedObservedLabel(row.label);
      const key = normalizeSpoolTypeKey(label);
      if (!label || !key) continue;
      const labels = labelsByKey.get(key) ?? new Set<string>();
      labels.add(label);
      labelsByKey.set(key, labels);
    }
    const result: SpoolPriceTypeView[] = [];
    for (const [key, labels] of labelsByKey) {
      if (labels.size !== 1) {
        throw new ConflictException({
          code: 'SPOOL_PRICE_TYPE_AMBIGUOUS',
          message: 'Наблюдаемые подписи типа шпули неоднозначны.',
        });
      }
      result.push({ key, label: [...labels][0] });
    }
    return result.sort((left, right) => left.key.localeCompare(right.key, 'ru'));
  }

  private findByOperationKey(client: PriceClient, operationKey: string) {
    return client.spoolPriceReference.findUnique({
      where: { operationKey },
    }) as Promise<SpoolPriceRow | null>;
  }

  private findReceiptByOperationKey(client: ReceiptClient, operationKey: string) {
    return client.spoolStockReceipt.findUnique({
      where: { operationKey },
      include: { priceReference: true },
    }) as Promise<SpoolReceiptRow | null>;
  }

  private lockPriceIdentity(
    client: Pick<Prisma.TransactionClient, '$executeRaw'>,
    spoolTypeKey: string,
    effectiveFrom: string,
  ) {
    return client.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${`spool-price:${spoolTypeKey}:${effectiveFrom}`}, 0)
      )`,
    );
  }

  private replay(row: SpoolPriceRow, fingerprint: string): SpoolPriceReferenceView {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'SPOOL_PRICE_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже использован для другой цены шпули.',
      });
    }
    return view(row);
  }

  private replayReceipt(row: SpoolReceiptRow, fingerprint: string): SpoolStockReceiptView {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'SPOOL_STOCK_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже использован для другого прихода шпуль.',
      });
    }
    return receiptView(row);
  }
}
