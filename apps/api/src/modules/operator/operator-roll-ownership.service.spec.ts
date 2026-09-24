import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { OperatorRollOwnershipService } from './operator-roll-ownership.service';
import { OperatorSessionService } from './operator-session.service';

const actor = { userId: 'operator-a', role: 'operator' as const };
const session = {
  id: 'session-a',
  operatorId: actor.userId,
  postId: 'post-a',
  shiftId: 'shift-a',
  status: 'active',
};
const line = {
  id: 'line-a',
  rollDispatchItemId: 'dispatch-a',
  step: 'assigned',
  rollDispatchItem: {
    rollCode: 'ROLL-A',
    assignedOperatorId: actor.userId,
    postId: session.postId,
    plannedShiftId: session.shiftId,
    status: 'assigned',
    productionOrder: { approvalState: 'pending' },
  },
};

function setup({ active = session, owned = line }: { active?: unknown; owned?: unknown } = {}) {
  const tx = {
    $queryRaw: jest
      .fn()
      .mockImplementation((query: { strings?: string[] }) =>
        Promise.resolve(
          query.strings?.join(' ').includes('FROM "posts" AS post')
            ? [{ id: session.postId }]
            : [{ id: 'dispatch-a' }],
        ),
      ),
    operatorPostSession: { findFirst: jest.fn().mockResolvedValue(active) },
    shiftBagUsage: { findFirst: jest.fn().mockResolvedValue({ id: 'usage-a' }) },
    operatorRollLine: { findFirst: jest.fn().mockResolvedValue(owned) },
  } as any;
  const sessions = Object.create(OperatorSessionService.prototype) as OperatorSessionService;
  return { tx, service: new OperatorRollOwnershipService(sessions) };
}

describe('OperatorRollOwnershipService', () => {
  it('requires a full bearer actor', async () => {
    const { tx, service } = setup();
    await expect(
      service.lockOwned(tx, { userId: null, role: 'operator' }, 'ROLL-A'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.operatorPostSession.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a missing active session before looking up a roll', async () => {
    const { tx, service } = setup({ active: null });
    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_REQUIRED' }),
    });
    expect(tx.operatorRollLine.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    ['another operator', null],
    ['another post', null],
  ])('returns the same projection-safe 404 for %s', async (_case, owned) => {
    const { tx, service } = setup({ owned });
    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ROLL_NOT_FOUND' }),
    });
  });

  it('locks and revalidates a published roll even while its order remains pending', async () => {
    const { tx, service } = setup();
    await expect(service.lockOwned(tx, actor, 'ROLL-A')).resolves.toEqual({ session, line });

    expect(tx.operatorPostSession.findFirst).toHaveBeenNthCalledWith(1, {
      where: { operatorId: actor.userId, status: 'active' },
    });
    expect(tx.operatorPostSession.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        id: session.id,
        operatorId: actor.userId,
        postId: session.postId,
        status: 'active',
        post: { status: 'active' },
      },
    });
    expect(tx.operatorRollLine.findFirst).toHaveBeenCalledTimes(2);
    expect(tx.operatorRollLine.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: line.id,
          rollDispatchItem: expect.objectContaining({
            rollCode: 'ROLL-A',
            assignedOperatorId: actor.userId,
            postId: session.postId,
            plannedShiftId: session.shiftId,
            status: { not: 'new' },
          }),
        }),
      }),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.operatorRollLine.findFirst.mock.invocationCallOrder[0],
    );
    const postLock = tx.$queryRaw.mock.calls[0][0];
    expect(postLock.strings.join(' ')).toContain('posts');
    expect(postLock.strings.join(' ')).toContain('FOR KEY SHARE');
    const sessionLock = tx.$queryRaw.mock.calls[1][0];
    expect(sessionLock.strings.join(' ')).toContain('operator_post_sessions');
  });

  it('fails closed when the active session post is broken', async () => {
    const { tx, service } = setup({ active: null });
    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_REQUIRED' }),
    });
    expect(tx.operatorPostSession.findFirst).toHaveBeenCalledWith({
      where: { operatorId: actor.userId, status: 'active' },
    });
  });

  it('fails closed when a legacy active session has no shift binding', async () => {
    const { tx, service } = setup({ active: { ...session, shiftId: null } });

    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_SHIFT_REQUIRED' }),
    });
    expect(tx.operatorRollLine.findFirst).not.toHaveBeenCalled();
  });

  it('returns a stable 409 before roll lookup when the active shift session has no open bag', async () => {
    const { tx, service } = setup();
    tx.shiftBagUsage.findFirst.mockResolvedValue(null);

    await expect(service.lockOwned(tx, actor, 'ROLL-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_SHIFT_BAG_USAGE_REQUIRED' }),
    });
    expect(tx.shiftBagUsage.findFirst).toHaveBeenCalledWith({
      where: { sessionId: session.id, closedAt: null },
      select: { id: true },
    });
    expect(tx.operatorRollLine.findFirst).not.toHaveBeenCalled();
  });

  it('turns a session closed while acquiring its row lock into a stable 409 before roll lookup', async () => {
    const { tx, service } = setup();
    tx.operatorPostSession.findFirst.mockResolvedValueOnce(session).mockResolvedValueOnce(null);

    const result = service.lockOwned(tx, actor, 'ROLL-A');
    await expect(result).rejects.toBeInstanceOf(ConflictException);
    await expect(result).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'OPERATOR_ACTIVE_SESSION_REQUIRED' }),
    });
    expect(tx.operatorRollLine.findFirst).not.toHaveBeenCalled();
  });
});
