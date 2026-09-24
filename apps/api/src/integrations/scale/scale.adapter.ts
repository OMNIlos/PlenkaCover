import type { DeviceStatus } from '@plenka/contracts';

/**
 * Scale device contract (ТЗ §9). Mock-first: real protocols/models/failure modes
 * are discovery (ТЗ §11.8, §12.7). The operator service depends on this interface,
 * never on a concrete device, so a real adapter swaps in without touching call sites.
 */
export interface ScaleReading {
  deviceId: string;
  status: DeviceStatus;
  stable: boolean;
  grossKg: number;
}

export interface BoundScaleDevice {
  deviceId: string;
  expectedPostId: string;
  expectedKind: 'scale';
}

export type ScaleReadingKind = 'spool' | 'roll' | 'control';

export interface ScaleAdapter {
  /** The trusted post binding must survive through the adapter boundary. */
  read(binding: BoundScaleDevice, kind: ScaleReadingKind): Promise<ScaleReading>;
}

/** DI token for the active ScaleAdapter implementation. */
export const SCALE_ADAPTER = 'SCALE_ADAPTER';
