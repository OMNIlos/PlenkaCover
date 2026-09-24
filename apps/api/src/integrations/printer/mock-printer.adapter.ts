import { Injectable } from '@nestjs/common';
import type { PrinterPayload } from '@plenka/contracts';
import type { BoundPrinterDevice, PrinterAdapter, PrintJobResult } from './printer.adapter';

/**
 * Deterministic mock printer (ТЗ §11.8 mock-first). Prints successfully unless the
 * printerId is `offline-printer`, which yields a failed job (drives the failure path).
 * NOT a production integration.
 */
@Injectable()
export class MockPrinterAdapter implements PrinterAdapter {
  readonly transport = 'mock' as const;

  async print(binding: BoundPrinterDevice, payload: PrinterPayload): Promise<PrintJobResult> {
    const printerId = binding.deviceId;
    const reference =
      payload.kind === 'roll_label'
        ? payload.rollCode
        : payload.kind === 'big_bag_label'
          ? payload.bigBagCode
          : payload.documentId;
    if (printerId === 'offline-printer') {
      return {
        jobId: `job-${reference}`,
        printerId,
        status: 'failed',
        failureReason: 'offline',
      };
    }
    return { jobId: `job-${reference}`, printerId, status: 'printed' };
  }
}
