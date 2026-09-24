import { Injectable } from '@nestjs/common';
import {
  gatewayCapabilityForPrinterPayload,
  type GatewayCapability,
  type PrinterPayload,
} from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { GatewayCommandTimeoutError, GatewayService } from '../../modules/gateway/gateway.service';
import type {
  BoundPrinterDevice,
  PrinterAdapter,
  PrintDeliveryUnknownReason,
  PrintJobResult,
} from '../printer/printer.adapter';

/**
 * Real-topology printer adapter (V2 S4): prints via the post's gateway agent. Same PrinterAdapter
 * interface → drop-in behind PRINTER_ADAPTER (inv. №4). A timeout after the agent claims a print
 * is deliberately uncertain: bytes may already have reached the physical printer, so callers
 * require administrator reconciliation instead of automatically printing again (ТЗ §9).
 */
@Injectable()
export class GatewayPrinterAdapter implements PrinterAdapter {
  readonly transport = 'gateway' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
  ) {}

  async print(binding: BoundPrinterDevice, payload: PrinterPayload): Promise<PrintJobResult> {
    const printerId = binding.deviceId;
    if (!(await this.capabilityIsCurrent(binding.expectedPostId, payload))) {
      return {
        jobId: '',
        printerId,
        status: 'failed',
        failureReason: 'gateway_agent_upgrade_required',
      };
    }
    if (!(await this.bindingIsCurrent(binding))) {
      return {
        jobId: '',
        printerId,
        status: 'failed',
        failureReason: 'printer binding unavailable',
      };
    }
    let result: Record<string, unknown>;
    try {
      result = await this.gateway.dispatchCommand(binding.expectedPostId, 'print', {
        printerId,
        ...payload,
      });
    } catch (error) {
      if (error instanceof GatewayCommandTimeoutError && error.outcome === 'expired') {
        return {
          jobId: '',
          printerId,
          status: 'failed',
          failureReason: 'gateway_command_not_dispatched',
          gatewayCommandId: error.commandId,
        };
      }
      return this.deliveryUnknown(
        printerId,
        '',
        'gateway_transport_outcome_unknown',
        error instanceof GatewayCommandTimeoutError ? error.commandId : undefined,
      );
    }

    const jobId = String(result.jobId ?? '');
    const gatewayCommandId =
      typeof result.gatewayCommandId === 'string' ? result.gatewayCommandId : undefined;
    if (result.status === 'delivery_unknown') {
      return this.deliveryUnknown(
        printerId,
        jobId,
        'printer_delivery_outcome_unknown',
        gatewayCommandId,
      );
    }
    if (['printed', 'submitted'].includes(String(result.status)) && result.ok === false) {
      return this.deliveryUnknown(
        printerId,
        jobId,
        'printer_delivery_outcome_unknown',
        gatewayCommandId,
      );
    }
    if (result.status === 'failed' && result.ok === false) {
      return {
        jobId,
        printerId,
        status: 'failed',
        failureReason: 'printer_transport_failed',
        gatewayCommandId,
      };
    }
    if (!['printed', 'submitted'].includes(String(result.status)) || result.ok !== true || !jobId) {
      return this.deliveryUnknown(
        printerId,
        jobId,
        'printer_result_status_unknown',
        gatewayCommandId,
      );
    }

    try {
      if (!(await this.bindingIsCurrent(binding))) {
        return this.deliveryUnknown(
          printerId,
          jobId,
          'binding_changed_after_acknowledged_print',
          gatewayCommandId,
        );
      }
    } catch {
      return this.deliveryUnknown(
        printerId,
        jobId,
        'binding_verification_unavailable_after_acknowledged_print',
        gatewayCommandId,
      );
    }

    return {
      jobId,
      printerId,
      status: result.status as 'printed' | 'submitted',
      gatewayCommandId,
    };
  }

  private deliveryUnknown(
    printerId: string,
    jobId: string,
    failureReason: PrintDeliveryUnknownReason,
    gatewayCommandId?: string,
  ): PrintJobResult {
    return { jobId, printerId, status: 'delivery_unknown', failureReason, gatewayCommandId };
  }

  private async bindingIsCurrent(binding: BoundPrinterDevice): Promise<boolean> {
    const current = await this.prisma.deviceRuntime.findFirst({
      where: {
        id: binding.deviceId,
        postId: binding.expectedPostId,
        kind: binding.expectedKind,
        isEnabled: true,
        status: 'ready',
      },
      select: { id: true },
    });
    return current !== null;
  }

  private async capabilityIsCurrent(postId: string, payload: PrinterPayload): Promise<boolean> {
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      select: { agentCompatibility: true, agentCapabilities: true },
    });
    if (!post || post.agentCompatibility !== 'compatible') return false;
    const capabilities = Array.isArray(post.agentCapabilities)
      ? (post.agentCapabilities as GatewayCapability[])
      : [];
    return capabilities.includes(gatewayCapabilityForPrinterPayload(payload.kind));
  }
}
