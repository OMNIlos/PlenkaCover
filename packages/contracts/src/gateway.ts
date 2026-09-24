import type {
  BigBagLabelPrinterPayload,
  PalletLabelPrinterPayload,
  RollLabelPrinterPayload,
} from './printer';
import { isPrinterPayload } from './printer';

export const GATEWAY_PROTOCOL_VERSION = 2 as const;
export const GATEWAY_MIN_PROTOCOL_VERSION = 2 as const;

export const GATEWAY_CAPABILITIES = [
  'scale.massa-k.protocol-100.v1',
  'scale.read.v1',
  'printer.roll-label.v1',
  'printer.big-bag-label.v1',
  'printer.pallet-label.v1',
  'scanner.hid-keyboard.v1',
  'device.test.v1',
  'device.recover.v1',
] as const;

export type GatewayCapability = (typeof GATEWAY_CAPABILITIES)[number];

export const GATEWAY_DEVICE_KINDS = ['scale', 'printer', 'scanner'] as const;
export type GatewayDeviceKind = (typeof GATEWAY_DEVICE_KINDS)[number];

export const GATEWAY_DEVICE_STATUSES = ['ready', 'offline', 'unstable', 'misconfigured'] as const;
export type GatewayDeviceStatus = (typeof GATEWAY_DEVICE_STATUSES)[number];

export type GatewayHeartbeatDeviceV2 = {
  deviceId: string;
  kind: GatewayDeviceKind;
  status: GatewayDeviceStatus;
  driver: string;
  driverVersion: string;
  configFingerprint: string;
  lastProbeAt: string | null;
};

export type GatewayHeartbeatV2 = {
  protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  agent: {
    packageVersion: string;
    releaseCommit: string;
    bootId: string;
    startedAt: string;
    capabilities: readonly GatewayCapability[];
  };
  devices: readonly GatewayHeartbeatDeviceV2[];
};

export type GatewayHeartbeatAckV2 = {
  accepted: boolean;
  compatibility: 'compatible' | 'upgrade_required' | 'unsupported';
  serverProtocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  minimumProtocolVersion: typeof GATEWAY_MIN_PROTOCOL_VERSION;
  pollAllowed: boolean;
  missingCapabilities: readonly GatewayCapability[];
  serverTime: string;
};

type VersionedLabel<T> = { schemaVersion: 1 } & T;

export type GatewayCommandEnvelopeV2 =
  | {
      protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
      kind: 'scale.read.v1';
      payload: { deviceId: string; sample: 'spool' | 'roll' };
    }
  | {
      protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
      kind: 'label.print.v1';
      payload: {
        printerId: string;
        label:
          | VersionedLabel<RollLabelPrinterPayload>
          | VersionedLabel<PalletLabelPrinterPayload>
          | ({ schemaVersion: 2 } & BigBagLabelPrinterPayload);
      };
    }
  | {
      protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
      kind: 'device.test.v1' | 'device.recover.v1';
      payload: { deviceId: string; kind: GatewayDeviceKind };
    };

const capabilitySet = new Set<string>(GATEWAY_CAPABILITIES);
const deviceKindSet = new Set<string>(GATEWAY_DEVICE_KINDS);
const deviceStatusSet = new Set<string>(GATEWAY_DEVICE_STATUSES);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoundedString = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maxLength;

const isIsoTimestamp = (value: unknown): value is string =>
  isBoundedString(value, 40) && Number.isFinite(Date.parse(value));

export function isGatewayCapability(value: unknown): value is GatewayCapability {
  return typeof value === 'string' && capabilitySet.has(value);
}

export function gatewayCapabilityForPrinterPayload(
  kind:
    | RollLabelPrinterPayload['kind']
    | BigBagLabelPrinterPayload['kind']
    | PalletLabelPrinterPayload['kind'],
): GatewayCapability {
  switch (kind) {
    case 'roll_label':
      return 'printer.roll-label.v1';
    case 'big_bag_label':
      return 'printer.big-bag-label.v1';
    case 'pallet_label':
      return 'printer.pallet-label.v1';
  }
}

function isGatewayHeartbeatDeviceV2(value: unknown): value is GatewayHeartbeatDeviceV2 {
  if (!isRecord(value)) return false;
  return (
    isBoundedString(value.deviceId, 200) &&
    typeof value.kind === 'string' &&
    deviceKindSet.has(value.kind) &&
    typeof value.status === 'string' &&
    deviceStatusSet.has(value.status) &&
    isBoundedString(value.driver, 128) &&
    isBoundedString(value.driverVersion, 128) &&
    typeof value.configFingerprint === 'string' &&
    /^[0-9a-f]{64}$/u.test(value.configFingerprint) &&
    (value.lastProbeAt === null || isIsoTimestamp(value.lastProbeAt))
  );
}

export function isGatewayHeartbeatV2(value: unknown): value is GatewayHeartbeatV2 {
  if (!isRecord(value) || value.protocolVersion !== GATEWAY_PROTOCOL_VERSION) return false;
  if (!isRecord(value.agent) || !Array.isArray(value.devices) || value.devices.length > 64) {
    return false;
  }
  const capabilities = value.agent.capabilities;
  if (
    !isBoundedString(value.agent.packageVersion, 128) ||
    typeof value.agent.releaseCommit !== 'string' ||
    !/^[0-9a-f]{7,64}$/u.test(value.agent.releaseCommit) ||
    !isBoundedString(value.agent.bootId, 128) ||
    !isIsoTimestamp(value.agent.startedAt) ||
    !Array.isArray(capabilities) ||
    capabilities.length > GATEWAY_CAPABILITIES.length ||
    !capabilities.every(isGatewayCapability) ||
    new Set(capabilities).size !== capabilities.length ||
    !value.devices.every(isGatewayHeartbeatDeviceV2)
  ) {
    return false;
  }
  return new Set(value.devices.map((device) => device.deviceId)).size === value.devices.length;
}

export function isGatewayCommandEnvelopeV2(value: unknown): value is GatewayCommandEnvelopeV2 {
  if (!isRecord(value) || value.protocolVersion !== GATEWAY_PROTOCOL_VERSION) return false;
  if (!isRecord(value.payload)) return false;

  if (value.kind === 'scale.read.v1') {
    return (
      isBoundedString(value.payload.deviceId, 200) &&
      (value.payload.sample === 'spool' || value.payload.sample === 'roll')
    );
  }

  if (value.kind === 'label.print.v1') {
    if (!isBoundedString(value.payload.printerId, 200) || !isRecord(value.payload.label)) {
      return false;
    }
    const { schemaVersion, ...label } = value.payload.label;
    if (!isPrinterPayload(label)) return false;
    return schemaVersion === 1
      ? label.kind !== 'big_bag_label'
      : schemaVersion === 2 && label.kind === 'big_bag_label';
  }

  if (value.kind === 'device.test.v1' || value.kind === 'device.recover.v1') {
    return (
      isBoundedString(value.payload.deviceId, 200) &&
      typeof value.payload.kind === 'string' &&
      deviceKindSet.has(value.payload.kind)
    );
  }

  return false;
}
