import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { GATEWAY_COMMAND_TIMEOUT_MAX_MS } from '../../common/runtime-config';

export type OperatorOperationAction =
  | 'accept'
  | 'spool_weight'
  | 'roll_weight'
  | 'roll_reweigh'
  | 'step_back'
  | 'defect'
  | 'defer'
  | 'resume'
  | 'qr_print'
  | 'qr_verify'
  | 'handover';

type OperationRecord = {
  id: string;
  operationKey: string;
  operatorRollLineId: string;
  action: string;
  actorId: string;
  postSessionId: string;
  postId: string;
  requestFingerprint: string;
  status: string;
  httpStatus: number | null;
  errorCode: string | null;
  attempt: number;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

type OperationClient = Pick<Prisma.TransactionClient, 'operatorRollOperation'>;

export type ClaimOperationInput = {
  operationKey: string;
  operatorRollLineId: string;
  action: OperatorOperationAction;
  actorId: string;
  postSessionId: string;
  postId: string;
  deviceId?: string | null;
  fingerprintInput: unknown;
  expectedStep: string;
  reason?: string | null;
};

// A gateway command may legally occupy the full configured timeout. Keep a full minute for
// response propagation, local adapter return and the serializable business finalization.
export const OPERATOR_PHYSICAL_OPERATION_LEASE_MS = GATEWAY_COMMAND_TIMEOUT_MAX_MS + 60_000;

const PHYSICAL_ACTIONS = new Set<OperatorOperationAction>([
  'spool_weight',
  'roll_weight',
  'roll_reweigh',
  'defect',
  'qr_print',
  'qr_verify',
]);

const UNSAFE_FINGERPRINT_FIELDS = new Set([
  'payload',
  'qrcode',
  'rawpayload',
  'scannedpayload',
  'rawframe',
]);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .sort()
      .map((key) => {
        if (UNSAFE_FINGERPRINT_FIELDS.has(key.toLowerCase())) {
          throw new Error(`Unsafe operation fingerprint field: ${key}`);
        }
        return [key, canonical(source[key])];
      }),
  );
}

@Injectable()
export class OperatorOperationService {
  static fingerprint(value: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(canonical(value)))
      .digest('hex');
  }

  static conflict(code: 'OPERATOR_OPERATION_IN_PROGRESS' | 'OPERATOR_OPERATION_KEY_CONFLICT') {
    return new ConflictException({
      code,
      message:
        code === 'OPERATOR_OPERATION_IN_PROGRESS'
          ? 'Операция уже выполняется. Дождитесь результата.'
          : 'Ключ операции уже использован для другого действия.',
    });
  }

  async claim(client: OperationClient, input: ClaimOperationInput) {
    const requestFingerprint = OperatorOperationService.fingerprint(input.fingerprintInput);
    const now = new Date();
    const existing = await client.operatorRollOperation.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (existing) {
      this.assertCompatible(existing, input, requestFingerprint);
      if (existing.status === 'in_progress') {
        return this.reclaimOrThrow(client, existing, now);
      }
      if (existing.status === 'failed') this.throwStoredFailure(existing);
      return { kind: 'replay' as const, operation: existing };
    }

    const previousFailure = await client.operatorRollOperation.findFirst({
      where: {
        operatorRollLineId: input.operatorRollLineId,
        action: input.action,
        status: 'failed',
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    });
    const physical = PHYSICAL_ACTIONS.has(input.action);
    const data = {
      operationKey: input.operationKey,
      operatorRollLineId: input.operatorRollLineId,
      action: input.action,
      actorId: input.actorId,
      postSessionId: input.postSessionId,
      postId: input.postId,
      deviceId: input.deviceId ?? null,
      requestFingerprint,
      expectedStep: input.expectedStep,
      status: 'in_progress',
      reason: input.reason ?? null,
      attempt: physical ? 1 : 0,
      leaseToken: physical ? randomUUID() : null,
      leaseExpiresAt: physical
        ? new Date(now.getTime() + OPERATOR_PHYSICAL_OPERATION_LEASE_MS)
        : null,
    };
    const inserted = await client.operatorRollOperation.createMany({
      data,
      skipDuplicates: true,
    });
    const operation = await client.operatorRollOperation.findUnique({
      where: { operationKey: input.operationKey },
    });
    if (!operation) {
      throw new ConflictException({
        code: 'OPERATOR_OPERATION_CLAIM_CONFLICT',
        message: 'Не удалось зафиксировать ключ операции. Повторите запрос с новым ключом.',
      });
    }
    if (inserted.count === 0) {
      this.assertCompatible(operation, input, requestFingerprint);
      if (operation.status === 'in_progress') {
        return this.reclaimOrThrow(client, operation, now);
      }
      if (operation.status === 'failed') this.throwStoredFailure(operation);
      return { kind: 'replay' as const, operation };
    }
    return {
      kind: 'claimed' as const,
      operation,
      recoveryFromId: previousFailure?.id ?? null,
    };
  }

  async bindDevice(
    client: OperationClient,
    id: string,
    deviceId: string,
    leaseToken?: string | null,
  ): Promise<void> {
    const now = new Date();
    const bound = await client.operatorRollOperation.updateMany({
      where: {
        id,
        status: 'in_progress',
        leaseToken: leaseToken ?? null,
        ...(leaseToken ? { leaseExpiresAt: { gt: now } } : {}),
        OR: [{ deviceId: null }, { deviceId }],
      },
      data: { deviceId },
    });
    if (bound.count !== 1) throw this.leaseLost();
  }

  async complete(
    client: OperationClient,
    id: string,
    result: { resultStep: string; resultRef?: string | null; httpStatus: number },
    leaseToken?: string | null,
  ) {
    const completed = await client.operatorRollOperation.updateMany({
      where: {
        id,
        status: 'in_progress',
        leaseToken: leaseToken ?? null,
        ...(leaseToken ? { leaseExpiresAt: { gt: new Date() } } : {}),
      },
      data: {
        status: 'succeeded',
        resultStep: result.resultStep,
        resultRef: result.resultRef ?? null,
        httpStatus: result.httpStatus,
        errorCode: null,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
    if (completed.count !== 1) throw this.leaseLost();
  }

  async fail(
    client: OperationClient,
    id: string,
    result: { httpStatus: number; errorCode: string; resultRef?: string | null },
    leaseToken?: string | null,
  ) {
    const failed = await client.operatorRollOperation.updateMany({
      where: {
        id,
        status: 'in_progress',
        leaseToken: leaseToken ?? null,
        ...(leaseToken ? { leaseExpiresAt: { gt: new Date() } } : {}),
      },
      data: {
        status: 'failed',
        resultStep: null,
        resultRef: result.resultRef ?? null,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      },
    });
    if (failed.count !== 1) throw this.leaseLost();
  }

  async assertCurrentLease(client: OperationClient, id: string, leaseToken: string): Promise<void> {
    const operation = await client.operatorRollOperation.findFirst({
      where: {
        id,
        status: 'in_progress',
        leaseToken,
        leaseExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!operation) throw this.leaseLost();
  }

  async assertNoPhysicalOperationInProgress(
    client: OperationClient,
    operatorRollLineId: string,
    now = new Date(),
  ): Promise<void> {
    const operation = await client.operatorRollOperation.findFirst({
      where: {
        operatorRollLineId,
        action: { in: [...PHYSICAL_ACTIONS] },
        status: 'in_progress',
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { gt: now } }],
      },
      select: { id: true },
    });
    if (operation) {
      throw new ConflictException({
        code: 'OPERATOR_PHYSICAL_OPERATION_IN_PROGRESS',
        message: 'Дождитесь завершения взвешивания или печати перед возвратом этапа.',
      });
    }
  }

  async settleExpired(
    client: OperationClient,
    id: string,
    leaseToken: string,
    result: { httpStatus: number; errorCode: string; resultRef?: string | null },
    now = new Date(),
  ): Promise<boolean> {
    const settled = await client.operatorRollOperation.updateMany({
      where: {
        id,
        status: 'in_progress',
        leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: 'failed',
        resultStep: null,
        resultRef: result.resultRef ?? null,
        httpStatus: result.httpStatus,
        errorCode: result.errorCode,
        leaseToken: null,
        leaseExpiresAt: null,
        completedAt: now,
      },
    });
    return settled.count === 1;
  }

  private assertCompatible(
    operation: OperationRecord,
    input: ClaimOperationInput,
    requestFingerprint: string,
  ) {
    if (
      operation.action !== input.action ||
      operation.operatorRollLineId !== input.operatorRollLineId ||
      operation.actorId !== input.actorId ||
      operation.postId !== input.postId ||
      operation.postSessionId !== input.postSessionId ||
      operation.requestFingerprint !== requestFingerprint
    ) {
      throw OperatorOperationService.conflict('OPERATOR_OPERATION_KEY_CONFLICT');
    }
  }

  private throwStoredFailure(operation: OperationRecord): never {
    const response = {
      code: operation.errorCode ?? 'OPERATOR_OPERATION_FAILED',
      message: operation.errorCode === 'OPERATOR_PRINT_NOT_SENT'
        ? 'Печать не началась. Повторите печать QR.'
        : 'Операция не выполнена; состояние рулона не изменено.',
    };
    if (operation.httpStatus === 400) throw new BadRequestException(response);
    if (operation.httpStatus === 404) throw new NotFoundException(response);
    if (operation.httpStatus === 503) throw new ServiceUnavailableException(response);
    throw new ConflictException(response);
  }

  private async reclaimOrThrow(client: OperationClient, operation: OperationRecord, now: Date) {
    if (!PHYSICAL_ACTIONS.has(operation.action as OperatorOperationAction)) {
      throw OperatorOperationService.conflict('OPERATOR_OPERATION_IN_PROGRESS');
    }
    if (!operation.leaseToken || !operation.leaseExpiresAt) {
      throw new ServiceUnavailableException({
        code: 'OPERATOR_OPERATION_RECOVERY_UNAVAILABLE',
        message:
          'Операция создана без защитной аренды. Требуется безопасная проверка незавершённой операции.',
      });
    }
    if (operation.leaseExpiresAt.getTime() > now.getTime()) {
      throw OperatorOperationService.conflict('OPERATOR_OPERATION_IN_PROGRESS');
    }

    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + OPERATOR_PHYSICAL_OPERATION_LEASE_MS);
    const reacquired = await client.operatorRollOperation.updateMany({
      where: {
        id: operation.id,
        status: 'in_progress',
        leaseToken: operation.leaseToken,
        leaseExpiresAt: { lte: now },
      },
      data: {
        attempt: { increment: 1 },
        leaseToken,
        leaseExpiresAt,
      },
    });
    if (reacquired.count !== 1) {
      throw OperatorOperationService.conflict('OPERATOR_OPERATION_IN_PROGRESS');
    }
    const current = await client.operatorRollOperation.findUnique({
      where: { operationKey: operation.operationKey },
    });
    if (!current || current.leaseToken !== leaseToken) throw this.leaseLost();
    return {
      kind: 'claimed' as const,
      operation: current,
      recoveryFromId: operation.id,
    };
  }

  private leaseLost() {
    return new ConflictException({
      code: 'OPERATOR_OPERATION_LEASE_LOST',
      message: 'Срок выполнения операции истёк или запрос уже безопасно повторён.',
    });
  }
}
