import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CreatePayrollTariffOrderInput,
  PayrollTariffMatrixV1,
  PayrollTariffOrderFieldError,
  PayrollTariffOrderList,
  PayrollTariffOrderListItem,
  PayrollTariffOrderResult,
  PayrollTariffOrderReview,
  PayrollTariffOrderView,
  PublishPayrollTariffOrderInput,
  ReviewPayrollTariffOrderInput,
  UpdatePayrollTariffOrderInput,
} from '@plenka/contracts';
import { Prisma, type PayrollTariffOrder } from '@prisma/client';
import type { Actor } from '../auth/actor';
import { AuditService } from '../audit/audit.service';
import { requestFingerprint } from '../idempotency/request-fingerprint';
import { PrismaService } from '../prisma/prisma.service';
import { hashPayrollTariffMatrix } from './payroll-tariff-order.canonical';
import {
  corruptPayrollTariffOrder,
  payrollTariffOrderError,
  PayrollTariffOrderDomainError,
} from './payroll-tariff-order.errors';
import {
  PayrollTariffMatrixValidationError,
  parsePayrollTariffMatrix,
} from './payroll-tariff-matrix.parser';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const MOSCOW_OFFSET = '+03:00';
const PUBLICATION_RETRY_ATTEMPTS = 3;

type OrderClient = Pick<
  Prisma.TransactionClient,
  'payrollTariffOrder' | 'payrollTariffOrderCommand' | 'domainEvent' | '$executeRaw'
>;

type PersistedCommand = {
  requestFingerprint: string;
  resultSnapshot: Prisma.JsonValue;
};

function field(path: string, code: string, message: string): PayrollTariffOrderFieldError {
  return { path, code, message };
}

function requireActorId(actor: Actor): string {
  if (actor.userId !== null && actor.userId.trim().length > 0) return actor.userId;
  throw payrollTariffOrderError(
    'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
    'Для управления приказами нужна учётная запись пользователя',
  );
}

function normalizeOperationKey(value: string): string {
  const operationKey = value.trim().toLowerCase();
  if (!UUID_V4.test(operationKey)) {
    throw payrollTariffOrderError(
      'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
      'operationKey должен быть UUID v4',
      [field('operationKey', 'invalid_uuid_v4', 'Укажите корректный UUID v4')],
    );
  }
  return operationKey;
}

function parseDateOnly(value: string): { date: string; instant: Date } {
  const match = DATE_ONLY.exec(value);
  if (!match) {
    throw payrollTariffOrderError(
      'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      'Дата вступления указана неверно',
      [field('effectiveFrom', 'invalid_date', 'Используйте дату в формате ГГГГ-ММ-ДД')],
    );
  }
  const instant = new Date(`${value}T00:00:00.000${MOSCOW_OFFSET}`);
  if (
    !Number.isFinite(instant.getTime()) ||
    moscowDate(instant) !== value ||
    Number(match[1]) < 1000
  ) {
    throw payrollTariffOrderError(
      'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      'Дата вступления указана неверно',
      [field('effectiveFrom', 'invalid_date', 'Укажите существующую календарную дату')],
    );
  }
  return { date: value, instant };
}

const MOSCOW_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function moscowDate(value: Date): string {
  const parts = new Map(
    MOSCOW_DATE_FORMATTER.formatToParts(value).map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function nextDate(value: string): string {
  const instant = new Date(`${value}T12:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString().slice(0, 10);
}

function minimumDate(now: Date, latestPublishedAt?: Date | null): string {
  const tomorrow = nextDate(moscowDate(now));
  if (!latestPublishedAt) return tomorrow;
  const afterLatest = nextDate(moscowDate(latestPublishedAt));
  return afterLatest > tomorrow ? afterLatest : tomorrow;
}

function validateName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 200) {
    throw payrollTariffOrderError(
      'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
      'Название приказа должно содержать от 1 до 200 символов',
      [field('name', 'invalid_length', 'Введите от 1 до 200 символов')],
    );
  }
  return name;
}

function validateMatrix(value: unknown): PayrollTariffMatrixV1 {
  try {
    return parsePayrollTariffMatrix(value);
  } catch (error) {
    if (error instanceof PayrollTariffMatrixValidationError) {
      throw payrollTariffOrderError(
        'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
        'Исправьте ошибки в тарифной матрице',
        error.fieldErrors,
      );
    }
    throw error;
  }
}

function mapOrder(row: PayrollTariffOrder): PayrollTariffOrderView {
  if (row.status !== 'draft' && row.status !== 'published') throw corruptPayrollTariffOrder();
  if (row.currency !== 'RUB') throw corruptPayrollTariffOrder();
  let matrix: PayrollTariffMatrixV1;
  try {
    matrix = parsePayrollTariffMatrix(row.matrix);
  } catch {
    throw corruptPayrollTariffOrder();
  }
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    effectiveFrom: moscowDate(row.effectiveFrom),
    currency: 'RUB',
    matrix,
    revision: row.revision,
    createdById: row.createdById,
    updatedById: row.updatedById,
    publishedById: row.publishedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  };
}

function listItem(order: PayrollTariffOrderView): PayrollTariffOrderListItem {
  const {
    matrix: _matrix,
    createdById: _created,
    updatedById: _updated,
    publishedById: _published,
    ...item
  } = order;
  return item;
}

function safeResult(value: Prisma.JsonValue): PayrollTariffOrderResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corruptPayrollTariffOrder();
  }
  const source = value as Record<string, unknown>;
  if (source.replayed !== false || source.order === undefined) throw corruptPayrollTariffOrder();
  const order = source.order as PayrollTariffOrderView;
  validateMatrix(order.matrix);
  return { order, replayed: false };
}

function fingerprintFor(
  action: 'create' | 'update' | 'publish',
  orderId: string,
  actorId: string,
  input: unknown,
): string {
  return requestFingerprint({ action, orderId, actorId, input });
}

function isRetryable(error: unknown): boolean {
  const source = error as { code?: unknown; meta?: { code?: unknown } };
  return (
    source?.code === 'P2034' ||
    source?.code === '40001' ||
    source?.code === '40P01' ||
    (source?.code === 'P2010' && (source.meta?.code === '40001' || source.meta?.code === '40P01'))
  );
}

function isUniqueConflict(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'P2002';
}

@Injectable()
export class PayrollTariffOrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(now = new Date()): Promise<PayrollTariffOrderList> {
    const rows = await this.prisma.payrollTariffOrder.findMany({
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
    });
    const orders = rows.map(mapOrder);
    const published = rows.filter((row) => row.status === 'published');
    const nowMs = now.getTime();
    const active = published
      .filter((row) => row.effectiveFrom.getTime() <= nowMs)
      .sort((left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime())[0];
    const latest = published.sort(
      (left, right) => right.effectiveFrom.getTime() - left.effectiveFrom.getTime(),
    )[0];
    return {
      items: orders.map(listItem),
      activeOrderId: active?.id ?? null,
      latestPublishedOrderId: latest?.id ?? null,
      minimumPublishEffectiveFrom: minimumDate(now, latest?.effectiveFrom),
      timezone: 'Europe/Moscow',
      generatedAt: now.toISOString(),
    };
  }

  async get(id: string): Promise<PayrollTariffOrderView> {
    const row = await this.prisma.payrollTariffOrder.findUnique({ where: { id } });
    if (!row) {
      throw payrollTariffOrderError(
        'PAYROLL_TARIFF_ORDER_NOT_FOUND',
        'Приказ по тарифам не найден',
      );
    }
    return mapOrder(row);
  }

  async create(
    actor: Actor,
    input: CreatePayrollTariffOrderInput,
  ): Promise<PayrollTariffOrderResult> {
    const actorId = requireActorId(actor);
    const operationKey = normalizeOperationKey(input.operationKey);
    const name = validateName(input.name);
    const effective = parseDateOnly(input.effectiveFrom);
    const matrix = validateMatrix(input.matrix);
    const normalized = { operationKey, name, effectiveFrom: effective.date, matrix };
    const orderId = `payroll-tariff-order-${randomUUID()}`;
    const fingerprint = fingerprintFor('create', '', actorId, normalized);

    return this.prisma.$transaction(async (tx) => {
      await this.lockCommand(tx, operationKey);
      const replay = await this.replay(tx, operationKey, fingerprint);
      if (replay) return replay;
      const row = await tx.payrollTariffOrder.create({
        data: {
          id: orderId,
          name,
          status: 'draft',
          effectiveFrom: effective.instant,
          currency: 'RUB',
          matrix: matrix as unknown as Prisma.InputJsonValue,
          revision: 1,
          createdById: actorId,
          updatedById: actorId,
        },
      });
      const result = { order: mapOrder(row), replayed: false } as const;
      await tx.payrollTariffOrderCommand.create({
        data: {
          operationKey,
          action: 'create',
          orderId: row.id,
          requestFingerprint: fingerprint,
          resultSnapshot: result as unknown as Prisma.InputJsonValue,
          actorId,
        },
      });
      await this.audit.record(
        {
          type: 'audit:payroll_tariff_order_created',
          objectId: row.id,
          actor: { kind: 'user', actorRole: actor.role, actorId },
          label: `Создан черновик приказа ${row.name}`,
          detail: { revision: row.revision, effectiveFrom: effective.date },
          newValue: { id: row.id, name: row.name, status: row.status },
        },
        tx,
      );
      return result;
    });
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdatePayrollTariffOrderInput,
  ): Promise<PayrollTariffOrderResult> {
    const actorId = requireActorId(actor);
    const operationKey = normalizeOperationKey(input.operationKey);
    const name = validateName(input.name);
    const effective = parseDateOnly(input.effectiveFrom);
    const matrix = validateMatrix(input.matrix);
    const normalized = {
      operationKey,
      expectedRevision: input.expectedRevision,
      name,
      effectiveFrom: effective.date,
      matrix,
    };
    const fingerprint = fingerprintFor('update', id, actorId, normalized);

    return this.prisma.$transaction(async (tx) => {
      await this.lockCommand(tx, operationKey);
      const replay = await this.replay(tx, operationKey, fingerprint);
      if (replay) return replay;
      const before = await tx.payrollTariffOrder.findUnique({ where: { id } });
      if (!before) throw this.notFound();
      if (before.status === 'published') {
        throw payrollTariffOrderError(
          'PAYROLL_TARIFF_ORDER_PUBLISHED_IMMUTABLE',
          'Опубликованный приказ нельзя изменять',
        );
      }
      if (before.revision !== input.expectedRevision) throw this.stale();

      const updated = await tx.payrollTariffOrder.updateMany({
        where: { id, status: 'draft', revision: input.expectedRevision },
        data: {
          name,
          effectiveFrom: effective.instant,
          matrix: matrix as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
          updatedById: actorId,
        },
      });
      if (updated.count !== 1) throw this.stale();
      const row = await tx.payrollTariffOrder.findUnique({ where: { id } });
      if (!row) throw this.notFound();
      const result = { order: mapOrder(row), replayed: false } as const;
      await tx.payrollTariffOrderCommand.create({
        data: {
          operationKey,
          action: 'update',
          orderId: id,
          requestFingerprint: fingerprint,
          resultSnapshot: result as unknown as Prisma.InputJsonValue,
          actorId,
        },
      });
      await this.audit.record(
        {
          type: 'audit:payroll_tariff_order_draft_updated',
          objectId: id,
          actor: { kind: 'user', actorRole: actor.role, actorId },
          label: `Обновлён черновик приказа ${row.name}`,
          detail: { revision: row.revision, effectiveFrom: effective.date },
          oldValue: {
            name: before.name,
            effectiveFrom: moscowDate(before.effectiveFrom),
            revision: before.revision,
          },
          newValue: { name: row.name, effectiveFrom: effective.date, revision: row.revision },
        },
        tx,
      );
      return result;
    });
  }

  async review(
    id: string,
    input: ReviewPayrollTariffOrderInput,
    now = new Date(),
  ): Promise<PayrollTariffOrderReview> {
    const row = await this.prisma.payrollTariffOrder.findUnique({ where: { id } });
    if (!row) throw this.notFound();
    return this.reviewRow(row, input, now, this.prisma);
  }

  async publish(
    actor: Actor,
    id: string,
    input: PublishPayrollTariffOrderInput,
    now = new Date(),
  ): Promise<PayrollTariffOrderResult> {
    const actorId = requireActorId(actor);
    const operationKey = normalizeOperationKey(input.operationKey);
    const normalized = {
      operationKey,
      expectedRevision: input.expectedRevision,
      reviewedMatrixHash: input.reviewedMatrixHash.trim().toLowerCase(),
    };
    const fingerprint = fingerprintFor('publish', id, actorId, normalized);

    for (let attempt = 1; attempt <= PUBLICATION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.lockCommand(tx, operationKey);
            const replay = await this.replay(tx, operationKey, fingerprint);
            if (replay) return replay;
            await tx.$executeRaw(
              Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended('payroll-tariff-publication', 0))`,
            );
            const row = await tx.payrollTariffOrder.findUnique({ where: { id } });
            if (!row) throw this.notFound();
            if (row.status === 'published') {
              throw payrollTariffOrderError(
                'PAYROLL_TARIFF_ORDER_ALREADY_PUBLISHED',
                'Этот приказ уже опубликован',
              );
            }
            if (row.revision !== input.expectedRevision) throw this.stale();
            const review = await this.reviewRow(row, input, now, tx);
            if (review.matrixHash !== normalized.reviewedMatrixHash) throw this.stale();
            if (!review.publishable) throw this.reviewFailure(review);

            const publishedAt = now;
            const updated = await tx.payrollTariffOrder.updateMany({
              where: { id, status: 'draft', revision: input.expectedRevision },
              data: {
                status: 'published',
                publishedAt,
                publishedById: actorId,
                updatedById: actorId,
              },
            });
            if (updated.count !== 1) throw this.stale();
            const published = await tx.payrollTariffOrder.findUnique({ where: { id } });
            if (!published) throw this.notFound();
            const result = { order: mapOrder(published), replayed: false } as const;
            await tx.payrollTariffOrderCommand.create({
              data: {
                operationKey,
                action: 'publish',
                orderId: id,
                requestFingerprint: fingerprint,
                resultSnapshot: result as unknown as Prisma.InputJsonValue,
                actorId,
              },
            });
            await this.audit.record(
              {
                type: 'audit:payroll_tariff_order_published',
                objectId: id,
                actor: { kind: 'user', actorRole: actor.role, actorId },
                label: `Опубликован приказ ${published.name}`,
                detail: {
                  revision: published.revision,
                  effectiveFrom: moscowDate(published.effectiveFrom),
                  matrixHash: review.matrixHash,
                },
                newValue: {
                  id,
                  name: published.name,
                  status: 'published',
                  effectiveFrom: moscowDate(published.effectiveFrom),
                },
              },
              tx,
            );
            return result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw payrollTariffOrderError(
            'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_DUPLICATE',
            'На эту дату уже опубликован другой приказ',
          );
        }
        if (!isRetryable(error)) throw error;
        if (attempt === PUBLICATION_RETRY_ATTEMPTS) {
          throw payrollTariffOrderError(
            'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_DUPLICATE',
            'Другой приказ был опубликован одновременно; обновите список',
          );
        }
      }
    }
    throw new Error('Unreachable payroll tariff publication state');
  }

  private async reviewRow(
    row: PayrollTariffOrder,
    input: ReviewPayrollTariffOrderInput,
    now: Date,
    client: Pick<OrderClient, 'payrollTariffOrder'>,
  ): Promise<PayrollTariffOrderReview> {
    if (row.status === 'published') {
      throw payrollTariffOrderError(
        'PAYROLL_TARIFF_ORDER_ALREADY_PUBLISHED',
        'Этот приказ уже опубликован',
      );
    }
    if (row.revision !== input.expectedRevision) throw this.stale();
    const matrix = validateMatrix(row.matrix);
    const latest = await client.payrollTariffOrder.findFirst({
      where: { status: 'published' },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      select: { effectiveFrom: true },
    });
    const minimum = minimumDate(now, latest?.effectiveFrom);
    const effectiveDate = moscowDate(row.effectiveFrom);
    const today = moscowDate(now);
    const errors: PayrollTariffOrderFieldError[] = [];
    if (effectiveDate <= today) {
      errors.push(
        field(
          'effectiveFrom',
          'past_or_today',
          'Дата вступления должна быть не раньше завтрашнего дня по Москве',
        ),
      );
    }
    if (latest && effectiveDate <= moscowDate(latest.effectiveFrom)) {
      errors.push(
        field(
          'effectiveFrom',
          effectiveDate === moscowDate(latest.effectiveFrom)
            ? 'effective_date_duplicate'
            : 'not_after_latest',
          'Дата должна быть позже последнего опубликованного приказа',
        ),
      );
    }
    return {
      orderId: row.id,
      revision: row.revision,
      matrixHash: hashPayrollTariffMatrix(matrix),
      minimumPublishEffectiveFrom: minimum,
      publishable: errors.length === 0,
      fieldErrors: errors,
    };
  }

  private reviewFailure(review: PayrollTariffOrderReview): PayrollTariffOrderDomainError {
    const duplicate = review.fieldErrors.some((error) => error.code === 'effective_date_duplicate');
    if (duplicate) {
      return payrollTariffOrderError(
        'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_DUPLICATE',
        'На эту дату уже опубликован другой приказ',
        review.fieldErrors,
      );
    }
    const past = review.fieldErrors.some((error) => error.code === 'past_or_today');
    return payrollTariffOrderError(
      past
        ? 'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_PAST_OR_TODAY'
        : 'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_NOT_AFTER_LATEST',
      past
        ? 'Дата вступления приказа уже наступила'
        : 'Дата должна быть позже последнего опубликованного приказа',
      review.fieldErrors,
    );
  }

  private async lockCommand(client: OrderClient, operationKey: string): Promise<void> {
    await client.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-tariff-command:${operationKey}`}, 0))`,
    );
  }

  private async replay(
    client: OrderClient,
    operationKey: string,
    fingerprint: string,
  ): Promise<PayrollTariffOrderResult | null> {
    const existing = (await client.payrollTariffOrderCommand.findUnique({
      where: { operationKey },
      select: { requestFingerprint: true, resultSnapshot: true },
    })) as PersistedCommand | null;
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint) {
      throw payrollTariffOrderError(
        'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
        'operationKey уже использован для другой команды или пользователя',
      );
    }
    const result = safeResult(existing.resultSnapshot);
    return { ...result, replayed: true };
  }

  private notFound(): PayrollTariffOrderDomainError {
    return payrollTariffOrderError('PAYROLL_TARIFF_ORDER_NOT_FOUND', 'Приказ по тарифам не найден');
  }

  private stale(): PayrollTariffOrderDomainError {
    return payrollTariffOrderError(
      'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
      'Черновик изменился; обновите версию и повторите действие',
    );
  }
}
