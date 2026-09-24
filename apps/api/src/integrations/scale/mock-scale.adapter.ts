import { Injectable } from '@nestjs/common';
import type {
  BoundScaleDevice,
  ScaleAdapter,
  ScaleReading,
  ScaleReadingKind,
} from './scale.adapter';

/**
 * Deterministic mock scale (ТЗ §11.8 mock-first). Returns a stable reading; a
 * deviceId of `offline-scale` simulates the offline/unstable blocking path (ТЗ §9),
 * so the no-manual-weight rule and `device.scale.offline` event can be exercised.
 * NOT a production integration.
 */
@Injectable()
export class MockScaleAdapter implements ScaleAdapter {
  async read(binding: BoundScaleDevice, kind: ScaleReadingKind): Promise<ScaleReading> {
    const deviceId = binding.deviceId;
    if (deviceId === 'offline-scale') {
      return { deviceId, status: 'offline', stable: false, grossKg: 0 };
    }
    return {
      deviceId,
      status: 'ready',
      stable: true,
      grossKg: kind === 'spool' ? 2.0 : 43.4,
    };
  }
}
