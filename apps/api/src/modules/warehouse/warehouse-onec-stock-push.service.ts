import { createHash } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OneCImportService,
  type OneCStockPushReadiness,
} from '../../integrations/onec/onec-import.service';
import type { OneCStockItem, OneCStockPushAck } from '../../integrations/onec/onec.adapter';
import type { OneCStockPushDto } from './dto/onec-stock-push.dto';
import type { WarehouseActor } from './warehouse.service';

type StockSnapshot = OneCStockPushReadiness & {
  items: OneCStockItem[];
  snapshotHash: string;
  count: number;
  totalQty: number;
};

type SafePushResult = StockSnapshot & {
  operationKey: string;
  pushed: number;
  replayed: boolean;
  ack: OneCStockPushAck & { mode: 'http'; accepted: true; documentCreated: true };
};

type StoredOperation = {
  id: string;
  operationKey: string;
  actorId: string;
  snapshotHash: string;
  status: string;
  safeResult: Prisma.JsonValue | null;
};

const RECONCILIATION_MESSAGE =
  'Не повторяйте отправку: сначала сверьте документ в 1С и выполните ручную сверку.';

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({ code, message });
}

function isConfirmedHttpAck(
  ack: unknown,
  expectedCount: unknown,
): ack is OneCStockPushAck & { mode: 'http'; accepted: true; documentCreated: true } {
  if (!ack || typeof ack !== 'object' || typeof expectedCount !== 'number') return false;
  const candidate = ack as Partial<OneCStockPushAck>;
  return (
    candidate.mode === 'http' &&
    candidate.accepted === true &&
    candidate.documentCreated === true &&
    candidate.count === expectedCount &&
    typeof candidate.ref === 'string' &&
    candidate.ref.length > 0
  );
}

@Injectable()
export class WarehouseOneCStockPushService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly onecImport: OneCImportService,
  ) {}

  async preview(): Promise<StockSnapshot> {
    const [rows, readiness] = await Promise.all([
      this.prisma.rawMaterialStock.findMany({
        select: { materialId: true, actualQty: true, unit: true, revision: true },
        orderBy: { materialId: 'asc' },
      }),
      this.onecImport.stockPushReadiness(),
    ]);
    const versionedItems = rows
      .map((row) => {
        if (
          !row.materialId ||
          !row.unit ||
          !Number.isFinite(row.actualQty) ||
          row.actualQty < 0 ||
          !Number.isInteger(row.revision) ||
          row.revision < 1
        ) {
          throw conflict(
            'ONEC_STOCK_SNAPSHOT_INVALID',
            'Складской snapshot содержит недопустимую строку сырья.',
          );
        }
        return {
          materialId: row.materialId,
          qty: Object.is(row.actualQty, -0) ? 0 : row.actualQty,
          unit: row.unit,
          revision: row.revision,
        };
      })
      .sort((left, right) =>
        left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
      );
    const items = versionedItems.map(({ revision: _revision, ...item }) => item);
    const snapshotHash = createHash('sha256').update(JSON.stringify(versionedItems)).digest('hex');
    const totalQty = Number(items.reduce((sum, item) => sum + item.qty, 0).toFixed(6));
    return { items, snapshotHash, count: items.length, totalQty, ...readiness };
  }

  async push(actor: WarehouseActor, dto: OneCStockPushDto): Promise<SafePushResult> {
    if (!actor.userId) {
      throw new UnauthorizedException('A real user session is required for a 1С stock push.');
    }
    const snapshot = await this.preview();
    if (snapshot.items.length === 0) {
      throw conflict(
        'ONEC_STOCK_SNAPSHOT_EMPTY',
        'Пустой складской snapshot нельзя проводить в 1С.',
      );
    }
    if (snapshot.snapshotHash !== dto.snapshotHash) {
      throw conflict(
        'ONEC_STOCK_SNAPSHOT_CHANGED',
        'Остатки сырья изменились. Получите новый preview перед отправкой.',
      );
    }
    if (!snapshot.writeReady) {
      throw new ServiceUnavailableException({
        code: 'ONEC_STOCK_PUSH_NOT_READY',
        message: snapshot.readinessMessage,
      });
    }

    const claim = await this.claim(actor.userId, dto.operationKey, snapshot.snapshotHash);
    if (claim.kind === 'replay') return this.replay(claim.operation);

    let ack: OneCStockPushAck;
    try {
      ack = await this.onecImport.pushStock(actor, snapshot.items);
      if (!isConfirmedHttpAck(ack, snapshot.items.length)) {
        throw new Error('1С did not confirm a created and posted HTTP document.');
      }
    } catch {
      await this.markOutcomeUnknown(claim.operation.id);
      throw new ServiceUnavailableException({
        code: 'ONEC_STOCK_PUSH_OUTCOME_UNKNOWN',
        message: `Результат отправки в 1С не подтверждён. ${RECONCILIATION_MESSAGE}`,
      });
    }

    const result: SafePushResult = {
      ...snapshot,
      operationKey: dto.operationKey,
      pushed: snapshot.items.length,
      replayed: false,
      ack,
    };
    let completed;
    try {
      completed = await this.prisma.oneCStockPushOperation.updateMany({
        where: { id: claim.operation.id, status: 'in_progress' },
        data: {
          status: 'succeeded',
          safeResult: result as unknown as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
      });
    } catch {
      throw this.completionUnknown();
    }
    if (completed.count !== 1) throw this.completionUnknown();
    return result;
  }

  private async claim(actorId: string, operationKey: string, snapshotHash: string) {
    const existingByKey = await this.prisma.oneCStockPushOperation.findUnique({
      where: { operationKey },
    });
    if (existingByKey) return this.classify(existingByKey, actorId, operationKey, snapshotHash);

    const existingByHash = await this.prisma.oneCStockPushOperation.findUnique({
      where: { snapshotHash },
    });
    if (existingByHash) return this.classify(existingByHash, actorId, operationKey, snapshotHash);

    const inserted = await this.prisma.oneCStockPushOperation.createMany({
      data: { operationKey, actorId, snapshotHash, status: 'in_progress' },
      skipDuplicates: true,
    });
    const [byKey, byHash] = await Promise.all([
      this.prisma.oneCStockPushOperation.findUnique({ where: { operationKey } }),
      this.prisma.oneCStockPushOperation.findUnique({ where: { snapshotHash } }),
    ]);
    const winner = byKey ?? byHash;
    if (!winner) {
      throw conflict(
        'ONEC_STOCK_PUSH_CLAIM_CONFLICT',
        `Не удалось зафиксировать команду. ${RECONCILIATION_MESSAGE}`,
      );
    }
    if (inserted.count === 0) return this.classify(winner, actorId, operationKey, snapshotHash);
    if (
      winner.operationKey !== operationKey ||
      winner.actorId !== actorId ||
      winner.snapshotHash !== snapshotHash
    ) {
      throw this.keyConflict();
    }
    return { kind: 'claimed' as const, operation: winner };
  }

  private classify(
    operation: StoredOperation,
    actorId: string,
    operationKey: string,
    snapshotHash: string,
  ) {
    if (
      operation.actorId !== actorId ||
      operation.snapshotHash !== snapshotHash ||
      (operation.operationKey === operationKey && operation.snapshotHash !== snapshotHash)
    ) {
      throw this.keyConflict();
    }
    if (operation.status === 'succeeded') {
      return { kind: 'replay' as const, operation };
    }
    throw conflict(
      'ONEC_STOCK_PUSH_RECONCILIATION_REQUIRED',
      `Этот snapshot уже получил команду с неопределённым исходом. ${RECONCILIATION_MESSAGE}`,
    );
  }

  private replay(operation: StoredOperation): SafePushResult {
    if (
      !operation.safeResult ||
      Array.isArray(operation.safeResult) ||
      typeof operation.safeResult !== 'object'
    ) {
      throw conflict(
        'ONEC_STOCK_PUSH_RESULT_INVALID',
        `Сохранённый результат неполон. ${RECONCILIATION_MESSAGE}`,
      );
    }
    const safeResult = operation.safeResult as unknown as SafePushResult;
    if (
      safeResult.operationKey !== operation.operationKey ||
      safeResult.snapshotHash !== operation.snapshotHash ||
      !isConfirmedHttpAck(safeResult.ack, safeResult.pushed)
    ) {
      throw conflict(
        'ONEC_STOCK_PUSH_RESULT_INVALID',
        `Сохранённый результат не подтверждает документ 1С. ${RECONCILIATION_MESSAGE}`,
      );
    }
    return { ...safeResult, replayed: true };
  }

  private async markOutcomeUnknown(id: string): Promise<void> {
    try {
      await this.prisma.oneCStockPushOperation.updateMany({
        where: { id, status: 'in_progress' },
        data: { status: 'outcome_unknown', completedAt: new Date() },
      });
    } catch {
      // A durable in_progress claim is deliberately non-retryable as well.
    }
  }

  private keyConflict(): ConflictException {
    return conflict(
      'ONEC_STOCK_PUSH_KEY_CONFLICT',
      `Ключ, snapshot или исполнитель не совпадают с сохранённой командой. ${RECONCILIATION_MESSAGE}`,
    );
  }

  private completionUnknown(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'ONEC_STOCK_PUSH_COMPLETION_UNKNOWN',
      message: `1С подтвердила документ, но локальный результат не зафиксирован. ${RECONCILIATION_MESSAGE}`,
    });
  }
}
