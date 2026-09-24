import { ServiceUnavailableException } from '@nestjs/common';
import { OperatorDeviceBindingService } from './operator-device-binding.service';

describe('OperatorDeviceBindingService', () => {
  const postId = 'post-1';

  it.each([
    ['scale', 'operator.weight.capture'],
    ['printer', 'operator.roll-label.print'],
    ['scanner', 'operator.qr.verify'],
  ] as const)('resolves %s through the centralized %s workflow', async (kind, workflow) => {
    const device = { id: `${kind}-1`, kind, status: 'ready' };
    const readiness = {
      require: jest.fn().mockResolvedValue({
        ready: true,
        code: 'READY',
        devices: [device],
      }),
    };
    const service = new OperatorDeviceBindingService(readiness as never);

    await expect(service.resolve(postId, kind)).resolves.toEqual(device);
    expect(readiness.require).toHaveBeenCalledWith(postId, workflow, undefined);
  });

  it('propagates an actionable readiness failure before adapter access', async () => {
    const failure = new ServiceUnavailableException({
      code: 'POST_AGENT_HEARTBEAT_STALE',
      message: 'Нет свежего подтверждения связи с физическим постом.',
    });
    const readiness = { require: jest.fn().mockRejectedValue(failure) };
    const service = new OperatorDeviceBindingService(readiness as never);

    await expect(service.resolve(postId, 'scale')).rejects.toBe(failure);
  });
});
