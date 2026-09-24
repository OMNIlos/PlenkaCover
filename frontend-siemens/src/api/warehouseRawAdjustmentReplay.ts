import { isDeliveryUncertain } from './idempotentOperation';

export type WarehouseRawAdjustmentPayload = Readonly<{
  actualQty: number;
  reason: string;
}>;

export class WarehouseRawAdjustmentRetryConflictError extends Error {
  constructor(readonly retainedPayload: WarehouseRawAdjustmentPayload) {
    super(
      `После неопределённого ответа можно повторить только сохранённую корректировку: ${retainedPayload.actualQty} кг, причина «${retainedPayload.reason}»`,
    );
    this.name = 'WarehouseRawAdjustmentRetryConflictError';
  }
}

export function warehouseRawAdjustmentIntent(
  materialId: string,
  payload: WarehouseRawAdjustmentPayload,
): string {
  return `warehouse:raw-adjust:${JSON.stringify([materialId, payload.actualQty, payload.reason])}`;
}

export class WarehouseRawAdjustmentReplayGuard {
  private readonly retainedByMaterial = new Map<string, WarehouseRawAdjustmentPayload>();

  prepare(
    materialId: string,
    draft: WarehouseRawAdjustmentPayload,
  ): WarehouseRawAdjustmentPayload {
    const payload = { actualQty: draft.actualQty, reason: draft.reason.trim() };
    const retained = this.retainedByMaterial.get(materialId);
    if (!retained) return payload;
    if (retained.actualQty !== payload.actualQty || retained.reason !== payload.reason) {
      throw new WarehouseRawAdjustmentRetryConflictError(retained);
    }
    return retained;
  }

  resolve(materialId: string): void {
    this.retainedByMaterial.delete(materialId);
  }

  reject(
    materialId: string,
    payload: WarehouseRawAdjustmentPayload,
    error: unknown,
  ): void {
    if (!isDeliveryUncertain(error)) {
      this.resolve(materialId);
      return;
    }
    if (!this.retainedByMaterial.has(materialId)) {
      this.retainedByMaterial.set(materialId, payload);
    }
  }
}
