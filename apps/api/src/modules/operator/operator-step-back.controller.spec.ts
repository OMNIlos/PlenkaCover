import { OperatorController } from './operator.controller';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';

describe('OperatorController step back', () => {
  it('forwards the authenticated actor, roll code and idempotency key', async () => {
    const stepBack = {
      stepBack: jest.fn().mockResolvedValue({
        rollCode: 'ROLL-001',
        previousStep: 'qr_print',
        step: 'roll_weight',
      }),
    };
    const controller = new (OperatorController as any)(
      {},
      {},
      {},
      {},
      {},
      {},
      stepBack,
    ) as OperatorController;
    const actor = {
      userId: 'operator-a',
      role: 'operator' as const,
      capabilities: [],
      sessionId: 'auth-session-a',
    };
    const dto = {
      operationKey: '9a88f1d4-c13a-4e85-88b1-a2f6cad67976',
    };

    await expect(controller.stepBack(actor, 'ROLL-001', dto)).resolves.toEqual({
      rollCode: 'ROLL-001',
      previousStep: 'qr_print',
      step: 'roll_weight',
    });
    expect(stepBack.stepBack).toHaveBeenCalledWith(
      { userId: 'operator-a', role: 'operator' },
      'ROLL-001',
      dto,
    );
  });

  it('returns an explicit 200 response for an idempotent state correction', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, OperatorController.prototype.stepBack),
    ).toBe(200);
  });
});
