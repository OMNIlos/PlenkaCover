import type { PrinterPayload } from '@plenka/contracts';

export const PRINT_DELIVERY_UNKNOWN_REASONS = [
  'gateway_transport_outcome_unknown',
  'printer_delivery_outcome_unknown',
  'binding_changed_after_acknowledged_print',
  'binding_verification_unavailable_after_acknowledged_print',
  'operator_finalization_conflict_after_acknowledged_print',
  'pallet_finalization_conflict_after_acknowledged_print',
  'printer_result_status_unknown',
  'printer_adapter_rejection_outcome_unknown',
] as const;

export type PrintDeliveryUnknownReason = (typeof PRINT_DELIVERY_UNKNOWN_REASONS)[number];

export function normalizePrintDeliveryUnknownReason(
  reason: string | undefined,
): PrintDeliveryUnknownReason {
  return PRINT_DELIVERY_UNKNOWN_REASONS.includes(reason as PrintDeliveryUnknownReason)
    ? (reason as PrintDeliveryUnknownReason)
    : 'printer_delivery_outcome_unknown';
}

/**
 * Printer device contract (ТЗ §9). Mock-first: real queue/template/failure modes are
 * discovery (ТЗ §11.8, §12.7). Reprint reason + audit is enforced in the operator service.
 */
export interface PrintJobResult {
  jobId: string;
  printerId: string;
  status: 'printed' | 'submitted' | 'failed' | 'delivery_unknown';
  failureReason?: string;
  gatewayCommandId?: string;
}

export interface BoundPrinterDevice {
  deviceId: string;
  expectedPostId: string;
  expectedKind: 'printer';
}

export interface PrinterAdapter {
  /** `gateway` is the only transport allowed to claim a direct warehouse print. */
  readonly transport: 'mock' | 'gateway';
  print(binding: BoundPrinterDevice, payload: PrinterPayload): Promise<PrintJobResult>;
}

/** DI token for the active PrinterAdapter implementation. */
export const PRINTER_ADAPTER = 'PRINTER_ADAPTER';
