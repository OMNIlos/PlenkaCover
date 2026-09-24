import { ApiError, ApiResponseParseError } from './client';
import { AUTH_OPERATION_KEYS_STORAGE_KEY, loadSession } from './authStorage';

const DURABLE_OPERATION_KEY_TTL_MS = 24 * 60 * 60 * 1_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type DurableOperationKeys = {
  version: 1;
  userId: string;
  keys: Record<string, unknown>;
};

const TERMINAL_OPERATOR_FAILURE_CODES = new Set([
  'DEFECT_BAG_PRINT_FAILED',
  'OPERATOR_DEVICE_BINDING_UNAVAILABLE',
  'OPERATOR_DEVICE_NOT_READY',
  'OPERATOR_SCALE_UNAVAILABLE',
  'OPERATOR_PRINTER_UNAVAILABLE',
  'OPERATOR_WEIGHT_FINALIZATION_FAILED',
  'POST_NOT_FOUND',
  'POST_NOT_ACTIVE',
  'POST_NOT_COMMISSIONED',
  'POST_AGENT_OFFLINE',
  'POST_AGENT_HEARTBEAT_STALE',
  'GATEWAY_AGENT_UPGRADE_REQUIRED',
  'GATEWAY_AGENT_UNSUPPORTED',
  'POST_CAPABILITY_MISSING',
  'POST_DEVICE_BINDING_UNAVAILABLE',
  'POST_DEVICE_NOT_READY',
  'POST_DEVICE_HEARTBEAT_STALE',
  'POST_DEVICE_PROBE_STALE',
]);

const UNCERTAIN_OPERATOR_OUTCOME_CODES = new Set([
  'OPERATOR_OPERATION_IN_PROGRESS',
  'OPERATOR_OPERATION_LEASE_LOST',
]);

export function createOperationKey(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error(
      'Не удалось создать безопасный идентификатор операции. Обновите браузер или откройте платформу по HTTPS.',
    );
  }
  return globalThis.crypto.randomUUID();
}

export function isDeliveryUncertain(error: unknown): boolean {
  if (error instanceof ApiResponseParseError) return error.deliveryUncertain;
  if (error instanceof ApiError) {
    if (error.code && TERMINAL_OPERATOR_FAILURE_CODES.has(error.code)) return false;
    return (
      error.status === 408 ||
      error.status >= 500 ||
      Boolean(error.code && UNCERTAIN_OPERATOR_OUTCOME_CODES.has(error.code)) ||
      Boolean(error.code?.endsWith('_DELIVERY_UNKNOWN'))
    );
  }
  if (error instanceof TypeError) return true;
  return (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function readDurableKeys(userId: string): DurableOperationKeys | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_OPERATION_KEYS_STORAGE_KEY);
    if (!raw) return { version: 1, userId, keys: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const journal = parsed as Partial<DurableOperationKeys>;
    if (
      journal.version !== 1 ||
      journal.userId !== userId ||
      !journal.keys ||
      typeof journal.keys !== 'object' ||
      Array.isArray(journal.keys)
    ) {
      return null;
    }
    return journal as DurableOperationKeys;
  } catch {
    return null;
  }
}

function readDurableKey(userId: string, intent: string): string | undefined {
  const value = readDurableKeys(userId)?.keys[intent];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const age = Date.now() - Number(entry.createdAt);
  return typeof entry.operationKey === 'string' &&
    UUID_V4.test(entry.operationKey) &&
    age >= 0 &&
    age <= DURABLE_OPERATION_KEY_TTL_MS
    ? entry.operationKey
    : undefined;
}

function writeDurableKey(userId: string, intent: string, operationKey: string): void {
  try {
    const journal = readDurableKeys(userId) ?? { version: 1, userId, keys: {} };
    globalThis.localStorage?.setItem(
      AUTH_OPERATION_KEYS_STORAGE_KEY,
      JSON.stringify({
        ...journal,
        keys: { ...journal.keys, [intent]: { operationKey, createdAt: Date.now() } },
      }),
    );
  } catch {
    // Storage is an optional recovery aid; the in-memory idempotency guard still applies.
  }
}

function deleteDurableKey(userId: string, intent: string, operationKey: string): void {
  try {
    const journal = readDurableKeys(userId);
    if (!journal || readDurableKey(userId, intent) !== operationKey) return;
    const keys = { ...journal.keys };
    delete keys[intent];
    if (Object.keys(keys).length === 0) {
      globalThis.localStorage?.removeItem(AUTH_OPERATION_KEYS_STORAGE_KEY);
      return;
    }
    globalThis.localStorage?.setItem(
      AUTH_OPERATION_KEYS_STORAGE_KEY,
      JSON.stringify({ ...journal, keys }),
    );
  } catch {
    // Storage is an optional recovery aid; the in-memory idempotency guard still applies.
  }
}

/**
 * Serializes one physical user intent and keeps its UUID only while delivery is uncertain.
 * A retry after a network failure therefore reaches the backend with the same operationKey.
 */
export class IdempotentOperationGate {
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly retryKeys = new Map<string, string>();

  constructor(
    private readonly createKey: () => string = createOperationKey,
    private readonly durable = false,
  ) {}

  start<T>(
    intent: string,
    execute: (operationKey: string) => Promise<T>,
    serializationKey = intent,
  ): Promise<T> | null {
    const durableUserId = this.durable ? loadSession()?.userId : undefined;
    const retryKey = durableUserId ? JSON.stringify([durableUserId, intent]) : intent;
    const pendingKey = durableUserId
      ? JSON.stringify([durableUserId, serializationKey])
      : serializationKey;
    if (this.pending.has(pendingKey)) return null;

    let operationKey: string;
    try {
      operationKey =
        this.retryKeys.get(retryKey) ??
        (durableUserId ? readDurableKey(durableUserId, intent) : undefined) ??
        this.createKey();
    } catch (error) {
      return Promise.reject(error);
    }
    this.retryKeys.set(retryKey, operationKey);
    if (durableUserId) writeDurableKey(durableUserId, intent, operationKey);

    let execution: Promise<T>;
    try {
      execution = execute(operationKey);
    } catch (error) {
      execution = Promise.reject(error);
    }

    const request = execution
      .then((result) => {
        this.retryKeys.delete(retryKey);
        if (durableUserId) deleteDurableKey(durableUserId, intent, operationKey);
        return result;
      })
      .catch((error: unknown) => {
        if (!isDeliveryUncertain(error)) {
          this.retryKeys.delete(retryKey);
          if (durableUserId) deleteDurableKey(durableUserId, intent, operationKey);
        }
        throw error;
      })
      .finally(() => {
        if (this.pending.get(pendingKey) === request) {
          this.pending.delete(pendingKey);
        }
      });

    this.pending.set(pendingKey, request);
    return request;
  }
}
