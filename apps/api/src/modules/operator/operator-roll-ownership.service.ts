import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockRollDispatchItems } from '../../common/prisma/roll-dispatch-lock';
import type { OperatorActor } from './operator.service';
import { OperatorSessionService } from './operator-session.service';

const OWNED_LINE_INCLUDE = {
  rollDispatchItem: {
    include: {
      productionOrder: { include: { commercialOrder: { include: { counterparty: true } } } },
    },
  },
} as const;

function activeSessionRequired() {
  return new ConflictException({
    code: 'OPERATOR_ACTIVE_SESSION_REQUIRED',
    message: 'Откройте активную сессию производственного поста.',
  });
}

function activeSessionShiftRequired() {
  return new ConflictException({
    code: 'OPERATOR_ACTIVE_SESSION_SHIFT_REQUIRED',
    message: 'Active operator session is not bound to a production shift.',
  });
}

function openShiftBagUsageRequired() {
  return new ConflictException({
    code: 'OPERATOR_SHIFT_BAG_USAGE_REQUIRED',
    message: 'Откройте смену с производственным биг-бэгом до начала работы с рулоном.',
  });
}

function rollNotFound() {
  return new NotFoundException({
    code: 'OPERATOR_ROLL_NOT_FOUND',
    message: 'Рулон не найден в очереди этого оператора и поста.',
  });
}

@Injectable()
export class OperatorRollOwnershipService {
  constructor(private readonly sessions: OperatorSessionService) {}

  async lockOwned(client: Prisma.TransactionClient, actor: OperatorActor, rollCode: string) {
    if (!actor.userId) {
      throw new UnauthorizedException('Для операции требуется полная пользовательская сессия.');
    }
    const operatorId = actor.userId;
    // Physical mutations must enter the global shop-floor order at Post before locking
    // Session/Roll. KEY SHARE allows concurrent FK-backed operation journals while every
    // topology command (FOR UPDATE) still waits until this short transaction commits.
    const [lockedPost] = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT post."id"
      FROM "posts" AS post
      JOIN "operator_post_sessions" AS session ON session."postId" = post."id"
      WHERE session."operatorId" = ${operatorId}
        AND session."status" = 'active'
        AND post."status" = 'active'
      ORDER BY session."id"
      LIMIT 1
      FOR KEY SHARE OF post
    `);
    if (!lockedPost) throw activeSessionRequired();
    const active = await this.sessions.lockActiveInTransaction(client, operatorId, {
      allowMissing: true,
      allowUnboundShift: true,
    });
    if (!active) throw activeSessionRequired();
    if (active.postId !== lockedPost.id) throw activeSessionRequired();
    if (!active.shiftId) throw activeSessionShiftRequired();
    const session = await client.operatorPostSession.findFirst({
      where: {
        id: active.id,
        operatorId,
        postId: active.postId,
        status: 'active',
        post: { status: 'active' },
      },
    });
    if (!session) throw activeSessionRequired();
    if (!session.shiftId) throw activeSessionShiftRequired();
    const openBagUsage = await client.shiftBagUsage.findFirst({
      where: { sessionId: session.id, closedAt: null },
      select: { id: true },
    });
    if (!openBagUsage) throw openShiftBagUsageRequired();

    const ownership = {
      rollCode,
      assignedOperatorId: operatorId,
      postId: session.postId,
      plannedShiftId: session.shiftId,
      status: { not: 'new' },
    } as const;
    const candidate = await client.operatorRollLine.findFirst({
      where: { rollDispatchItem: ownership },
      include: OWNED_LINE_INCLUDE,
    });
    if (!candidate) throw rollNotFound();

    await lockRollDispatchItems(client, [candidate.rollDispatchItemId]);
    const line = await client.operatorRollLine.findFirst({
      where: { id: candidate.id, rollDispatchItem: ownership },
      include: OWNED_LINE_INCLUDE,
    });
    if (!line) throw rollNotFound();
    return { session, line };
  }
}
