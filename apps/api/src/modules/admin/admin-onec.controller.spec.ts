import { Reflector } from '@nestjs/core';
import { UnauthorizedException } from '@nestjs/common';
import { REQUIRE_CAPABILITIES } from '../../common/auth/require-capabilities.decorator';
import { AdminOneCController } from './admin-onec.controller';

describe('AdminOneCController', () => {
  const proto = AdminOneCController.prototype;

  it('gates safe control routes with admin:onec', () => {
    const reflector = new Reflector();
    for (const handler of [
      proto.overview,
      proto.check,
      proto.import,
      proto.retry,
      proto.snapshots,
      proto.sourceHealth,
      proto.retrySource,
      proto.syncPreview,
      proto.syncRun,
      proto.syncRuns,
      proto.syncRunById,
      proto.reconciliation,
    ]) {
      expect(reflector.get(REQUIRE_CAPABILITIES, handler)).toEqual(['admin:onec']);
    }
  });

  it('rejects direct unauthenticated access to every full-sync route', () => {
    const controller = new AdminOneCController({} as never);

    for (const call of [
      () => controller.syncPreview(undefined),
      () => controller.syncRun(undefined),
      () => controller.syncRuns(undefined, {}),
      () => controller.syncRunById(undefined, 'run-1'),
      () => controller.reconciliation(undefined),
    ]) {
      expect(call).toThrow(UnauthorizedException);
    }
  });

  it('gates raw snapshots separately and marks them no-store', async () => {
    const onec = { rawSnapshot: jest.fn().mockResolvedValue({ rawPayload: { frame: 'raw' } }) };
    const controller = new AdminOneCController(onec as never);
    const response = { setHeader: jest.fn() };

    await controller.rawSnapshot('snap-1', response as never);

    expect(new Reflector().get(REQUIRE_CAPABILITIES, proto.rawSnapshot)).toEqual([
      'admin:diagnostics',
    ]);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
});
