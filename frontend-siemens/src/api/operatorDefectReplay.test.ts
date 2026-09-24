import { describe, expect, it, vi } from 'vitest';

import { ApiError } from './client';
import { IdempotentOperationGate } from './idempotentOperation';
import {
  clearOperatorDefectRetry,
  operatorDefectCommentForAttempt,
  operatorDefectIntent,
  updateOperatorDefectRetry,
  type OperatorDefectRetryComments,
} from './operatorDefectReplay';

describe('operator defect replay payload', () => {
  it('uses the backend idempotency intent identity for the roll defect', () => {
    expect(operatorDefectIntent('A-9-roll-1')).toBe(
      'operator:A-9-roll-1:operator-defect',
    );
  });

  it('replays the same UUID and comment after a TypeError even if the draft changes', async () => {
    const createKey = vi
      .fn()
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    const gate = new IdempotentOperationGate(createKey);
    const transport = vi
      .fn<(payload: { operationKey: string; comment: string }) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(undefined);
    const intent = operatorDefectIntent('A-9-roll-1');
    let retryComments: OperatorDefectRetryComments = {};

    const attempt = async (draftComment: string) => {
      const comment = operatorDefectCommentForAttempt(retryComments, intent, draftComment);
      const request = gate.start(intent, (operationKey) => transport({ operationKey, comment }));
      if (!request) throw new Error('unexpected pending operation');
      try {
        await request;
        retryComments = clearOperatorDefectRetry(retryComments, intent);
      } catch (error) {
        retryComments = updateOperatorDefectRetry(retryComments, intent, comment, error);
        throw error;
      }
    };

    await expect(attempt('Разрыв полотна')).rejects.toThrow('Failed to fetch');
    expect(retryComments[intent]).toBe('Разрыв полотна');
    await expect(attempt('Другой комментарий')).resolves.toBeUndefined();

    expect(transport.mock.calls.map(([payload]) => payload)).toEqual([
      {
        operationKey: '11111111-1111-4111-8111-111111111111',
        comment: 'Разрыв полотна',
      },
      {
        operationKey: '11111111-1111-4111-8111-111111111111',
        comment: 'Разрыв полотна',
      },
    ]);
    expect(retryComments).toEqual({});
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  it('releases the frozen comment after a definitive 4xx response', () => {
    const intent = operatorDefectIntent('A-9-roll-1');
    const frozen = { [intent]: 'Разрыв полотна' };

    const next = updateOperatorDefectRetry(
      frozen,
      intent,
      frozen[intent],
      new ApiError(409, 'conflict'),
    );

    expect(next).toEqual({});
    expect(operatorDefectCommentForAttempt(next, intent, 'Новая причина')).toBe('Новая причина');
  });

  it.each([
    new ApiError(408, 'timeout'),
    new ApiError(503, 'unavailable'),
    new ApiError(409, 'still running', 'OPERATOR_OPERATION_IN_PROGRESS'),
    new ApiError(409, 'unknown result', 'OPERATOR_DEFECT_DELIVERY_UNKNOWN'),
  ])('keeps the comment for uncertain API delivery: %s', (error) => {
    const intent = operatorDefectIntent('A-9-roll-1');

    const next = updateOperatorDefectRetry({}, intent, 'Разрыв полотна', error);

    expect(next).toEqual({ [intent]: 'Разрыв полотна' });
  });
});
