import { ApiError } from '../../api/client';
import { isDeliveryUncertain } from '../../api/idempotentOperation';
import type { ServerPalletPrintResult, ServerWarehousePrinter } from '../../api/warehouse';
import type { PalletListDocument } from '../../domain/types';

const MAX_SUBMISSION_ATTEMPTS = 12;
const SUBMISSION_POLL_MS = 500;

export function chooseWarehousePrinterId(
  printers: ServerWarehousePrinter[],
  savedId: string | null,
): string | null {
  const ready = printers.filter((printer) => printer.ready);
  if (savedId && ready.some((printer) => printer.id === savedId)) return savedId;
  return ready.length === 1 ? ready[0].id : null;
}

export class PalletPrintStillQueuedError extends Error {
  constructor() {
    super('Задание остается в очереди. Проверьте статус тем же запросом.');
    this.name = 'PalletPrintStillQueuedError';
  }
}

export type PalletPrintPhase = 'idle' | 'pending' | 'uncertain' | 'submitted' | 'failed';

type PalletPrintFailureDisposition = 'admin_review' | 'uncertain' | 'terminal';

function classifyPalletPrintFailure(error: unknown): PalletPrintFailureDisposition {
  if (error instanceof ApiError) {
    if (error.code === 'PALLET_PRINT_DELIVERY_UNKNOWN') return 'admin_review';
    if (error.code === 'PALLET_PRINT_FAILED') return 'terminal';
  }
  if (error instanceof PalletPrintStillQueuedError) return 'uncertain';
  return isDeliveryUncertain(error) ? 'uncertain' : 'terminal';
}

export function palletPrintFailurePresentation(error: unknown): {
  phase: 'uncertain' | 'failed';
  message: string | null;
  refresh: boolean;
} {
  const disposition = classifyPalletPrintFailure(error);
  if (disposition === 'admin_review') {
    return {
      phase: 'uncertain',
      message:
        'Итог печати не подтвержден. Не отправляйте новое задание: требуется проверка администратора.',
      refresh: true,
    };
  }
  if (disposition === 'uncertain') {
    return {
      phase: 'uncertain',
      message:
        error instanceof PalletPrintStillQueuedError
          ? null
          : 'Статус доставки не подтвержден. Повторная проверка использует тот же запрос.',
      refresh: false,
    };
  }
  if (error instanceof ApiError && error.code === 'PALLET_PRINT_FAILED') {
    return {
      phase: 'failed',
      message: `Печать завершилась ошибкой: ${error.message}`,
      refresh: true,
    };
  }
  if (error instanceof ApiError && error.status === 409) {
    return {
      phase: 'failed',
      message: `Конфликт задания печати: ${error.message}`,
      refresh: true,
    };
  }
  if (error instanceof ApiError && error.status === 503) {
    return {
      phase: 'failed',
      message: `Принтер недоступен: ${error.message}`,
      refresh: true,
    };
  }
  return { phase: 'failed', message: null, refresh: true };
}

export function palletPrintPhaseFromStatus(
  status: PalletListDocument['printStatus'],
): PalletPrintPhase {
  if (status === 'needs_admin') return 'uncertain';
  if (status === 'submitted') return 'submitted';
  if (status === 'failed') return 'failed';
  return 'idle';
}

export async function waitForPalletSubmission(
  send: () => Promise<ServerPalletPrintResult>,
  delay: () => Promise<void> = () =>
    new Promise((resolve) => window.setTimeout(resolve, SUBMISSION_POLL_MS)),
): Promise<ServerPalletPrintResult> {
  for (let attempt = 0; attempt < MAX_SUBMISSION_ATTEMPTS; attempt += 1) {
    const result = await send();
    if (result.status === 'submitted') return result;
    if (attempt < MAX_SUBMISSION_ATTEMPTS - 1) await delay();
  }
  throw new PalletPrintStillQueuedError();
}

export class PalletPrintRequestGate {
  private activePromise: Promise<ServerPalletPrintResult> | null = null;
  private retryRequestId: string | null = null;

  constructor(private readonly createRequestId: () => string = () => crypto.randomUUID()) {}

  retireRetryRequest(): void {
    this.retryRequestId = null;
  }

  run(
    execute: (requestId: string) => Promise<ServerPalletPrintResult>,
  ): Promise<ServerPalletPrintResult> {
    if (this.activePromise) return this.activePromise;

    const requestId = this.retryRequestId ?? this.createRequestId();
    this.retryRequestId = requestId;

    let execution: Promise<ServerPalletPrintResult>;
    try {
      execution = execute(requestId);
    } catch (error) {
      execution = Promise.reject(error);
    }

    const activePromise = execution
      .then((result) => {
        if (result.status === 'submitted') this.retryRequestId = null;
        return result;
      })
      .catch((error: unknown) => {
        if (classifyPalletPrintFailure(error) === 'terminal') this.retryRequestId = null;
        throw error;
      })
      .finally(() => {
        if (this.activePromise === activePromise) this.activePromise = null;
      });

    this.activePromise = activePromise;
    return activePromise;
  }
}
