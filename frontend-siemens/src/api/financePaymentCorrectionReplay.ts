import type { FinancePaymentCorrectionCommand } from '../domain/types';
import { isDeliveryUncertain } from './idempotentOperation';

export type FinancePaymentCorrectionPayload = Readonly<
  Omit<FinancePaymentCorrectionCommand, 'operationKey'>
>;

export class FinancePaymentCorrectionRetryConflictError extends Error {
  constructor(readonly retainedCommand: Readonly<FinancePaymentCorrectionCommand>) {
    super(
      `После неопределённого ответа можно повторить только сохранённую корректировку «${retainedCommand.reason}» для ${retainedCommand.target.id}`,
    );
    this.name = 'FinancePaymentCorrectionRetryConflictError';
  }
}

function normalizePayload(
  payload: FinancePaymentCorrectionPayload,
): FinancePaymentCorrectionPayload {
  return {
    target: { kind: payload.target.kind, id: payload.target.id },
    expectedPaymentStatus: payload.expectedPaymentStatus,
    reason: payload.reason.trim(),
  };
}

function samePayload(
  left: FinancePaymentCorrectionPayload,
  right: FinancePaymentCorrectionPayload,
): boolean {
  return (
    left.target.kind === right.target.kind &&
    left.target.id === right.target.id &&
    left.expectedPaymentStatus === right.expectedPaymentStatus &&
    left.reason === right.reason
  );
}

function payloadFromCommand(
  command: Readonly<FinancePaymentCorrectionCommand>,
): FinancePaymentCorrectionPayload {
  return {
    target: command.target,
    expectedPaymentStatus: command.expectedPaymentStatus,
    reason: command.reason,
  };
}

export function financePaymentCorrectionIntent(
  financeOrderId: string,
  payload: FinancePaymentCorrectionPayload,
): string {
  const normalized = normalizePayload(payload);
  return `finance:payment-correction:${JSON.stringify([
    financeOrderId,
    normalized.target.kind,
    normalized.target.id,
    normalized.expectedPaymentStatus,
    normalized.reason,
  ])}`;
}

export class FinancePaymentCorrectionReplayGuard {
  private readonly retainedByOrder = new Map<
    string,
    Readonly<FinancePaymentCorrectionCommand>
  >();

  prepare(
    financeOrderId: string,
    draft: FinancePaymentCorrectionPayload,
  ): FinancePaymentCorrectionPayload {
    const payload = normalizePayload(draft);
    const retained = this.retainedByOrder.get(financeOrderId);
    if (!retained) return payload;
    const retainedPayload = payloadFromCommand(retained);
    if (!samePayload(retainedPayload, payload)) {
      throw new FinancePaymentCorrectionRetryConflictError(retained);
    }
    return retainedPayload;
  }

  command(
    financeOrderId: string,
    payload: FinancePaymentCorrectionPayload,
    operationKey: string,
  ): Readonly<FinancePaymentCorrectionCommand> {
    const retained = this.retainedByOrder.get(financeOrderId);
    if (retained) {
      if (!samePayload(payloadFromCommand(retained), normalizePayload(payload))) {
        throw new FinancePaymentCorrectionRetryConflictError(retained);
      }
      if (retained.operationKey !== operationKey) {
        throw new Error('Повтор корректировки получил другой operationKey.');
      }
      return retained;
    }
    return { operationKey, ...normalizePayload(payload) };
  }

  resolve(financeOrderId: string): void {
    this.retainedByOrder.delete(financeOrderId);
  }

  reject(
    financeOrderId: string,
    command: Readonly<FinancePaymentCorrectionCommand>,
    error: unknown,
  ): void {
    if (!isDeliveryUncertain(error)) {
      this.resolve(financeOrderId);
      return;
    }
    if (!this.retainedByOrder.has(financeOrderId)) {
      this.retainedByOrder.set(financeOrderId, command);
    }
  }
}
