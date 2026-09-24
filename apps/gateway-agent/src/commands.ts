import {
  GATEWAY_PROTOCOL_VERSION,
  isGatewayCommandEnvelopeV2,
  isPrinterPayload,
} from '@plenka/contracts';
import type { GatewayCommandMsg } from './api-client';
import type { PrinterDevice } from './devices/printer';
import type { ScaleDevice } from './devices/scale';
import type { ScannerDevice } from './devices/scanner';
import type { BufferableEvent } from './offline-buffer';
import { hasCompleteProtocol100Parameters, projectScaleProbeResult } from './probe-scale';
import type { PrinterMode } from './config';

export interface AgentDevices {
  scale: ScaleDevice;
  scaleDeviceId: string;
  printer: PrinterDevice;
  printerDeviceId: string;
  printerMode: PrinterMode;
  scanner: ScannerDevice;
  scannerDeviceId: string | null;
}

const PHYSICAL_SCALE_PROTOCOL = 'massa-k-protocol-100';
const PHYSICAL_DIVISIONS_KG = new Set([0.0001, 0.001, 0.01, 0.1, 1]);
const SETUP_LABEL_TOKEN = `prt_${'0'.repeat(64)}`;

export interface CommandOutcome {
  /** Result posted back to the platform — compatible with Gateway{Scale,Printer}Adapter. */
  result: Record<string, unknown>;
  /** Side-channel ingest events (raw frames etc). Raw NEVER goes into `result`. */
  events: BufferableEvent[];
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

type CommandInput = Pick<GatewayCommandMsg, 'id' | 'protocolVersion' | 'kind' | 'payload'>;

function normalizeCommand(
  cmd: CommandInput,
):
  | { kind: string; payload: Record<string, unknown> }
  | { reasonCode: 'gateway_command_protocol_unsupported' | 'gateway_command_envelope_invalid' } {
  if (cmd.protocolVersion === undefined) {
    return { kind: cmd.kind, payload: record(cmd.payload) };
  }
  if (cmd.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
    return { reasonCode: 'gateway_command_protocol_unsupported' };
  }
  const envelope = {
    protocolVersion: cmd.protocolVersion,
    kind: cmd.kind,
    payload: cmd.payload,
  };
  if (!isGatewayCommandEnvelopeV2(envelope)) {
    return { reasonCode: 'gateway_command_envelope_invalid' };
  }

  if (envelope.kind === 'scale.read.v1') {
    return {
      kind: 'read_scale',
      payload: {
        deviceId: envelope.payload.deviceId,
        kind: envelope.payload.sample,
      },
    };
  }
  if (envelope.kind === 'label.print.v1') {
    const { schemaVersion: _schemaVersion, ...label } = envelope.payload.label;
    return {
      kind: 'print',
      payload: {
        printerId: envelope.payload.printerId,
        ...label,
      },
    };
  }
  return {
    kind: envelope.kind === 'device.test.v1' ? 'device_test' : 'device_recover',
    payload: envelope.payload,
  };
}

/**
 * Execute one platform command against local devices. The printer preserves
 * `delivery_unknown` when bytes may already have reached the physical device, so the platform
 * cannot turn an ambiguous delivery into an ordinary retry; the agent never crashes on a command.
 */
export async function handleCommand(
  cmd: CommandInput,
  devices: AgentDevices,
): Promise<CommandOutcome> {
  const normalized = normalizeCommand(cmd);
  if ('reasonCode' in normalized) {
    return {
      result: { ok: false, status: 'failed', reasonCode: normalized.reasonCode },
      events: [],
    };
  }
  const { kind, payload } = normalized;
  try {
    if (kind === 'read_scale') {
      if (payload.deviceId !== devices.scaleDeviceId) {
        return {
          result: {
            ok: false,
            status: 'misconfigured',
            error: 'scale is not configured on this post agent',
          },
          events: [],
        };
      }
      const kind = payload.kind === 'roll' ? 'roll' : 'spool';
      const r = await devices.scale.read(kind);
      const events: BufferableEvent[] =
        r.raw !== undefined
          ? [
              {
                kind: 'weight',
                payload: {
                  deviceId: devices.scaleDeviceId,
                  kind,
                  status: r.status,
                  stable: r.stable,
                  grossKg: r.grossKg,
                },
                rawPayload: { frame: r.raw },
              },
            ]
          : [];
      return {
        result: {
          ok: true,
          deviceId: devices.scaleDeviceId,
          status: r.status,
          stable: r.stable,
          grossKg: r.grossKg,
        },
        events,
      };
    }

    if (kind === 'print') {
      if (payload.printerId !== devices.printerDeviceId) {
        return {
          result: {
            ok: false,
            status: 'failed',
            error: 'printer is not configured on this post agent',
          },
          events: [],
        };
      }
      const printerPayload = { ...payload };
      delete printerPayload.printerId;
      if (!isPrinterPayload(printerPayload)) {
        return {
          result: { ok: false, status: 'failed', error: 'invalid printer payload' },
          events: [],
        };
      }
      let r: Awaited<ReturnType<PrinterDevice['print']>>;
      try {
        r = await devices.printer.print(printerPayload);
      } catch {
        return {
          result: {
            ok: false,
            status: 'delivery_unknown',
            reasonCode: 'printer_delivery_outcome_unknown',
          },
          events: [],
        };
      }
      return {
        result: r.ok
          ? { ok: true, jobId: r.jobId, status: r.status }
          : {
              ok: false,
              status: r.status,
              reasonCode:
                r.status === 'delivery_unknown'
                  ? 'printer_delivery_outcome_unknown'
                  : 'printer_transport_failed',
            },
        events: [],
      };
    }

    if (kind === 'device_test' || kind === 'device_recover') {
      const deviceId = String(payload.deviceId ?? '');
      const kind = String(payload.kind ?? '');
      const local = localDeviceStatus(deviceId, kind, devices);
      if (!local) {
        return {
          result: {
            ok: false,
            deviceId,
            status: 'misconfigured',
            error: 'device is not configured on this post agent',
          },
          events: [],
        };
      }
      if (normalized.kind === 'device_test' && kind === 'scale') {
        try {
          const probe = projectScaleProbeResult(await devices.scale.probe());
          const evidenceKind = probe.simulated
            ? 'simulated'
            : probe.protocol === 'legacy-ascii'
              ? 'legacy'
              : probe.protocol === PHYSICAL_SCALE_PROTOCOL
                ? 'physical'
                : 'unverified';
          const reading =
            evidenceKind === 'physical' && probe.ok ? await devices.scale.read('roll') : undefined;
          const physicalPass = Boolean(
            probe.ok &&
            probe.status === 'ready' &&
            probe.protocol === PHYSICAL_SCALE_PROTOCOL &&
            probe.simulated === false &&
            probe.identity &&
            hasCompleteProtocol100Parameters(probe.parameters) &&
            reading?.status === 'ready' &&
            reading.stable === true &&
            Number.isFinite(reading.grossKg) &&
            reading.grossKg >= 0 &&
            reading.divisionKg !== undefined &&
            PHYSICAL_DIVISIONS_KG.has(reading.divisionKg),
          );
          return {
            result: {
              ok: probe.ok && (reading?.status ?? probe.status) === 'ready',
              deviceId,
              status: reading?.status ?? probe.status,
              protocol: probe.protocol,
              simulated: probe.simulated,
              identity: probe.identity,
              parameters: probe.parameters,
              error: probe.error,
              evidenceKind,
              physicalPass,
              stable: reading?.stable,
              measuredAt: new Date().toISOString(),
            },
            events: [],
          };
        } catch {
          return {
            result: {
              ok: false,
              deviceId,
              status: 'offline',
              error: 'scale probe failed',
              measuredAt: new Date().toISOString(),
            },
            events: [],
          };
        }
      }
      if (normalized.kind === 'device_test' && kind === 'printer') {
        let printed: Awaited<ReturnType<PrinterDevice['print']>>;
        try {
          printed = await devices.printer.print({
            kind: 'roll_label',
            rollCode: 'PLENKA-SETUP-TEST',
            qrCode: SETUP_LABEL_TOKEN,
          });
        } catch {
          printed = {
            ok: false,
            status: 'delivery_unknown',
            error: 'printer_test_outcome_unknown',
          };
        }
        const operationalPass = printed.ok || printed.status === 'delivery_unknown';
        return {
          result: {
            ok: operationalPass,
            deviceId,
            status: operationalPass ? 'ready' : 'offline',
            evidenceKind: devices.printerMode === 'simulated' ? 'simulated' : 'physical_pending',
            physicalPass: false,
            confirmationRequired: devices.printerMode !== 'simulated',
            message: operationalPass
              ? 'Setup label submitted; physical output requires human confirmation.'
              : 'Printer setup label could not be submitted.',
            measuredAt: new Date().toISOString(),
          },
          events: [],
        };
      }
      if (normalized.kind === 'device_test' && kind === 'scanner') {
        const receiverPresent = local.status === 'ready';
        return {
          result: {
            ok: receiverPresent,
            deviceId,
            status: local.status,
            evidenceKind: 'physical_pending',
            physicalPass: false,
            confirmationRequired: true,
            message: receiverPresent
              ? 'HID receiver is present; complete one browser scan and press Enter to confirm.'
              : 'HID receiver is unavailable; reconnect it, then complete one browser scan and press Enter.',
            measuredAt: new Date().toISOString(),
          },
          events: [],
        };
      }
      if (normalized.kind === 'device_test') {
        return {
          result: {
            ok: local.status === 'ready',
            deviceId,
            status: local.status,
            message:
              local.status === 'ready' ? 'Local device responded.' : 'Local device is unavailable.',
            measuredAt: new Date().toISOString(),
          },
          events: [],
        };
      }
      return {
        result: {
          ok: local.status === 'ready',
          deviceId,
          status: local.status === 'ready' ? 'recovering' : local.status,
          message:
            local.status === 'ready'
              ? 'Device is reachable; platform verification required.'
              : 'Physical recovery is required on the post.',
          measuredAt: new Date().toISOString(),
        },
        events: [],
      };
    }

    return { result: { ok: false, error: `unknown command kind ${kind}` }, events: [] };
  } catch {
    return {
      result: { ok: false, status: 'failed', reasonCode: 'device_command_failed' },
      events: [],
    };
  }
}

function localDeviceStatus(
  deviceId: string,
  kind: string,
  devices: AgentDevices,
): { status: string } | null {
  if (kind === 'scale' && deviceId === devices.scaleDeviceId) {
    return { status: devices.scale.status() };
  }
  if (kind === 'printer' && deviceId === devices.printerDeviceId) {
    return { status: devices.printer.status() };
  }
  if (kind === 'scanner' && deviceId === devices.scannerDeviceId) {
    return { status: devices.scanner.status() };
  }
  return null;
}
