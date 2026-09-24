import type { ScaleDevice, ScaleProbeResult, ScaleReadResult } from '../scale';
import {
  PROTOCOL_100_COMMAND,
  Protocol100FrameError,
  type DecodedProtocol100Frame,
} from './protocol-100-frame';
import {
  parseProtocol100Response,
  type Protocol100DeviceErrorResponse,
  type Protocol100ScaleParametersResponse,
} from './protocol-100-messages';
import { Protocol100TimeoutError, type Protocol100Exchange } from './serial-protocol-100-exchange';

const OFFLINE_DEVICE_ERRORS = new Set([0x17, 0x19]);
const roundKg = (value: number) => Math.round(value * 10_000) / 10_000;

function rawHex(frame: DecodedProtocol100Frame): string {
  return frame.raw.subarray(0, 256).toString('hex');
}

function deviceStatus(response: Protocol100DeviceErrorResponse): ScaleReadResult['status'] {
  return response.code !== null && OFFLINE_DEVICE_ERRORS.has(response.code)
    ? 'offline'
    : 'unstable';
}

function deviceFailure(
  response: Protocol100DeviceErrorResponse,
  frame: DecodedProtocol100Frame,
): ScaleReadResult {
  return {
    status: deviceStatus(response),
    stable: false,
    grossKg: 0,
    errorCode: response.message,
    raw: rawHex(frame),
  };
}

function categoricalError(error: unknown): string {
  if (error instanceof Protocol100FrameError) return `protocol_${error.reason}`;
  if (error instanceof Protocol100TimeoutError) return 'timeout';
  return 'transport_unavailable';
}

export class MassaKProtocol100Scale implements ScaleDevice {
  private lastStatus: ScaleReadResult['status'] = 'offline';

  constructor(
    private readonly exchange: Protocol100Exchange,
    private readonly readTimeoutMs: number,
  ) {}

  async probe(): Promise<ScaleProbeResult> {
    try {
      const nameFrame = await this.exchange.request(
        PROTOCOL_100_COMMAND.getName,
        this.readTimeoutMs,
      );
      const name = parseProtocol100Response(nameFrame);
      if (name.kind === 'device_error') return this.probeDeviceFailure(name);
      if (name.kind !== 'name') {
        return this.probeFailure(`unexpected probe response ${name.kind}`);
      }

      const parametersFrame = await this.exchange.request(
        PROTOCOL_100_COMMAND.getScaleParameters,
        this.readTimeoutMs,
      );
      const parsed = parseProtocol100Response(parametersFrame);
      let parameters: Protocol100ScaleParametersResponse | undefined;
      if (parsed.kind === 'scale_parameters') parameters = parsed;
      else if (parsed.kind === 'device_error') return this.probeDeviceFailure(parsed);
      else if (parsed.kind !== 'nack') {
        return this.probeFailure(`unexpected parameters response ${parsed.kind}`);
      }

      this.lastStatus = 'ready';
      return {
        ok: true,
        status: 'ready',
        protocol: 'massa-k-protocol-100',
        simulated: false,
        identity: { manufacturer: 'MASSA-K', scaleId: name.scaleId, name: name.name },
        parameters: parameters
          ? {
              maximum: parameters.maximum,
              minimum: parameters.minimum,
              verificationInterval: parameters.verificationInterval,
              maximumTare: parameters.maximumTare,
              fixation: parameters.fixation,
              calibrationCode: parameters.calibrationCode,
              softwareVersion: parameters.softwareVersion,
              softwareChecksum: parameters.softwareChecksum,
            }
          : undefined,
      };
    } catch (error) {
      return this.probeFailure(categoricalError(error), error);
    }
  }

  async read(_kind: 'spool' | 'roll'): Promise<ScaleReadResult> {
    try {
      const frame = await this.exchange.request(PROTOCOL_100_COMMAND.getMass, this.readTimeoutMs);
      const response = parseProtocol100Response(frame);
      if (response.kind === 'device_error') return this.mark(deviceFailure(response, frame));
      if (response.kind !== 'mass') {
        return this.mark({
          status: 'unstable',
          stable: false,
          grossKg: 0,
          errorCode: `unexpected_${response.kind}`,
          raw: rawHex(frame),
        });
      }
      if (response.net && response.tareKg === null) {
        return this.mark({
          status: 'unstable',
          stable: false,
          grossKg: 0,
          errorCode: 'net_without_tare',
          raw: rawHex(frame),
        });
      }
      const grossKg = roundKg(response.weightKg + (response.net ? response.tareKg! : 0));
      if (!Number.isFinite(grossKg) || grossKg < 0) {
        return this.mark({
          status: 'unstable',
          stable: false,
          grossKg: 0,
          errorCode: 'invalid_gross_weight',
          raw: rawHex(frame),
        });
      }
      return this.mark({
        status: response.stable ? 'ready' : 'unstable',
        stable: response.stable,
        grossKg,
        netKg: response.weightKg,
        tareKg: response.tareKg,
        divisionKg: response.divisionKg,
        net: response.net,
        zero: response.zero,
        raw: rawHex(frame),
      });
    } catch (error) {
      return this.mark({
        status: error instanceof Protocol100FrameError ? 'unstable' : 'offline',
        stable: false,
        grossKg: 0,
        errorCode: categoricalError(error),
      });
    }
  }

  status(): ScaleReadResult['status'] {
    return this.lastStatus;
  }

  close(): Promise<void> {
    return this.exchange.close();
  }

  private mark(result: ScaleReadResult): ScaleReadResult {
    this.lastStatus = result.status;
    return result;
  }

  private probeDeviceFailure(response: Protocol100DeviceErrorResponse): ScaleProbeResult {
    this.lastStatus = deviceStatus(response);
    return {
      ok: false,
      status: this.lastStatus,
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error: response.message,
    };
  }

  private probeFailure(error: string, cause?: unknown): ScaleProbeResult {
    this.lastStatus =
      cause === undefined || cause instanceof Protocol100FrameError ? 'unstable' : 'offline';
    return {
      ok: false,
      status: this.lastStatus,
      protocol: 'massa-k-protocol-100',
      simulated: false,
      error,
    };
  }
}
