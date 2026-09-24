import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export type WarehouseOperationKind =
  | 'receiving_scan'
  | 'reserve_scan'
  | 'delivery_scan'
  | 'control_weight'
  | 'mark_damaged';

export type WarehouseCaptureChannel =
  | 'warehouse_browser_hid'
  | 'machine_post_gateway'
  | 'warehouse_role_action';

type OperationClient = Pick<Prisma.TransactionClient, 'warehouseOperation'>;

export const WAREHOUSE_CONTROL_WEIGHT_LEASE_MS = 30_000;

export type WarehouseOperationClaim = {
  operationKey: string;
  kind: WarehouseOperationKind;
  taskId: string;
  scanRowId: string;
  rollCode: string;
  actorId: string;
  sessionId: string;
  postId: string | null;
  deviceId?: string | null;
  captureChannel?: WarehouseCaptureChannel;
  fingerprintInput: unknown;
};

type StoredOperation = {
  id: string;
  operationKey: string;
  kind: string;
  status: string;
  taskId: string;
  scanRowId: string;
  rollCode: string;
  actorId: string;
  sessionId: string;
  postId: string | null;
  deviceId: string | null;
  captureChannel: string;
  requestFingerprint: string;
  safeResult: Prisma.JsonValue | null;
  httpStatus: number | null;
  errorCode: string | null;
  attempt: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => [key, canonical(source[key])]),
  );
}

@Injectable()
export class WarehouseOperationService {
  static fingerprint(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
  }

  async claim(client: OperationClient, input: WarehouseOperationClaim) {
    const requestFingerprint = WarehouseOperationService.fingerprint(input.fingerprintInput);
    const existing = await client.warehouseOperation.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (existing) return this.classify(existing, input, requestFingerprint);

    const previousFailure = await client.warehouseOperation.findFirst({
      where: {
        kind: input.kind,
        scanRowId: input.scanRowId,
        status: { in: ['failed', 'expired'] },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true, attempt: true },
    });
    const inserted = await client.warehouseOperation.createMany({
      data: {
        operationKey: input.operationKey,
        kind: input.kind,
        status: 'in_progress',
        taskId: input.taskId,
        scanRowId: input.scanRowId,
        rollCode: input.rollCode,
        actorId: input.actorId,
        sessionId: input.sessionId,
        postId: input.postId,
        deviceId: input.deviceId ?? null,
        captureChannel: input.captureChannel ?? 'machine_post_gateway',
        requestFingerprint,
        attempt: (previousFailure?.attempt ?? 0) + 1,
        leaseToken: input.kind === 'control_weight' ? randomUUID() : null,
        leaseExpiresAt:
          input.kind === 'control_weight'
            ? new Date(Date.now() + WAREHOUSE_CONTROL_WEIGHT_LEASE_MS)
            : null,
      },
      skipDuplicates: true,
    });
    const operation = await client.warehouseOperation.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (operation) {
      if (inserted.count === 0) return this.classify(operation, input, requestFingerprint);
      return {
        kind: 'claimed' as const,
        operation,
        recoveryFromId: previousFailure?.id ?? null,
      };
    }

    const winner = await client.warehouseOperation.findFirst({
      where: {
        kind: input.kind,
        scanRowId: input.scanRowId,
        status: { in: ['in_progress', 'succeeded'] },
      },
    });
    throw new ConflictException({
      code:
        winner?.status === 'in_progress'
          ? 'WAREHOUSE_OPERATION_IN_PROGRESS'
          : this.usedCode(input.kind),
      message: 'Физическая операция уже зафиксирована другим ключом.',
    });
  }

  complete(
    client: OperationClient,
    id: string,
    safeResult: Prisma.InputJsonValue,
    httpStatus = 200,
    leaseToken?: string,
  ) {
    return client.warehouseOperation.update({
      where: { id, status: 'in_progress', ...(leaseToken ? { leaseToken } : {}) },
      data: {
        status: 'succeeded',
        safeResult,
        httpStatus,
        errorCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
  }

  fail(
    client: OperationClient,
    id: string,
    errorCode: string,
    httpStatus = 503,
    leaseToken?: string,
  ) {
    return client.warehouseOperation.update({
      where: { id, status: 'in_progress', ...(leaseToken ? { leaseToken } : {}) },
      data: {
        status: 'failed',
        errorCode,
        httpStatus,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
  }

  async expireStaleControlWeights(
    client: OperationClient,
    input: { taskId: string; scanRowId?: string; now?: Date },
  ) {
    const now = input.now ?? new Date();
    const stale = await client.warehouseOperation.findMany({
      where: {
        taskId: input.taskId,
        ...(input.scanRowId ? { scanRowId: input.scanRowId } : {}),
        kind: 'control_weight',
        status: 'in_progress',
        leaseToken: { not: null },
        leaseExpiresAt: { lte: now },
      },
      orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
    });
    const expired: typeof stale = [];
    for (const operation of stale) {
      const updated = await client.warehouseOperation.updateMany({
        where: {
          id: operation.id,
          status: 'in_progress',
          leaseToken: operation.leaseToken,
          leaseExpiresAt: { lte: now },
        },
        data: {
          status: 'expired',
          leaseToken: null,
          leaseExpiresAt: null,
          errorCode: 'WAREHOUSE_CONTROL_WEIGHT_LEASE_EXPIRED',
          httpStatus: 503,
          completedAt: now,
        },
      });
      if (updated.count === 1) expired.push(operation);
    }
    return expired;
  }

  async bindDevice(client: OperationClient, id: string, deviceId: string) {
    const bound = await client.warehouseOperation.updateMany({
      where: { id, status: 'in_progress', deviceId: null },
      data: { deviceId },
    });
    if (bound.count === 1) return;
    const operation = await client.warehouseOperation.findUnique({ where: { id } });
    if (operation?.status === 'in_progress' && operation.deviceId === deviceId) return;
    throw new ConflictException({
      code: 'WAREHOUSE_DEVICE_BINDING_CONFLICT',
      message: 'Привязка физического устройства изменилась конкурентно.',
    });
  }

  private classify(
    operation: StoredOperation,
    input: WarehouseOperationClaim,
    requestFingerprint: string,
  ) {
    if (
      operation.kind !== input.kind ||
      operation.taskId !== input.taskId ||
      operation.scanRowId !== input.scanRowId ||
      operation.rollCode !== input.rollCode ||
      operation.actorId !== input.actorId ||
      operation.sessionId !== input.sessionId ||
      operation.postId !== input.postId ||
      (input.deviceId !== undefined && operation.deviceId !== input.deviceId) ||
      operation.captureChannel !== (input.captureChannel ?? 'machine_post_gateway') ||
      operation.requestFingerprint !== requestFingerprint
    ) {
      throw new ConflictException({
        code: 'WAREHOUSE_OPERATION_KEY_REUSED',
        message: 'Ключ операции уже относится к другому действию.',
      });
    }
    if (operation.status === 'succeeded') {
      return { kind: 'replay' as const, operation };
    }
    if (operation.status === 'in_progress') {
      throw new ServiceUnavailableException({
        code: 'WAREHOUSE_OPERATION_IN_PROGRESS',
        message: 'Операция ещё выполняется. Повторите запрос позже с тем же ключом.',
      });
    }
    const response = {
      code: operation.errorCode ?? 'WAREHOUSE_OPERATION_FAILED',
      message: 'Операция не выполнена; физический факт не зафиксирован.',
    };
    if (operation.httpStatus === 400) throw new BadRequestException(response);
    if (operation.httpStatus === 503) throw new ServiceUnavailableException(response);
    throw new ConflictException(response);
  }

  private usedCode(kind: WarehouseOperationKind) {
    if (kind.endsWith('_scan')) return 'WAREHOUSE_SCAN_ALREADY_ACCEPTED';
    if (kind === 'control_weight') return 'WAREHOUSE_CONTROL_WEIGHT_ALREADY_CAPTURED';
    return 'WAREHOUSE_DAMAGE_ALREADY_RECORDED';
  }
}
