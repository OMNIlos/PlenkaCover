import { Reflector } from '@nestjs/core';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { PlatformHealthController } from './platform-health.controller';

describe('PlatformHealthController', () => {
  it('gates every route with admin:platform_health', () => {
    const reflector = new Reflector();
    const proto = PlatformHealthController.prototype;
    for (const handler of [
      proto.snapshot,
      proto.check,
      proto.incidents,
      proto.acknowledge,
      proto.resolve,
      proto.recheck,
    ]) {
      expect(reflector.get(REQUIRE_CAPABILITIES, handler)).toEqual(['admin:platform_health']);
    }
  });

  it('returns only aggregate coverage metrics from the guarded health snapshot', async () => {
    const health = {
      snapshot: jest.fn().mockResolvedValue({
        status: 'ready',
        warehouseCoverage: {
          currentStates: { awaiting_finance: 2 },
          currentAvailability: { verified_full: 2 },
          openRechecks: {
            finance_request: 1,
            decision_linked_physical_exception: 1,
          },
          processConflicts: {
            total: 3,
            byCode: { P2034: 1, '40001': 0, '40P01': 1, coverage_conflict: 1 },
            resetAt: '2026-07-25T09:30:00.000Z',
          },
        },
      }),
    };
    const controller = new PlatformHealthController(health as never);

    const response = await controller.snapshot();

    expect(response.warehouseCoverage.processConflicts.total).toBe(3);
    expect(JSON.stringify(response)).not.toMatch(/rollCode|counterparty|orderNumber/u);
  });
});
