import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type OperatorPostSession } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { MACHINE_BREAKDOWN_TYPE_LABELS, type MachineBreakdownRequest } from '@plenka/contracts';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PostDeviceReadinessService } from '../../common/device-readiness/post-device-readiness.service';
import type { OperatorActor } from './operator.service';

/** Operator-safe post fields — excludes agentTokenHash (agent credential, admin-only ТЗ §8). */
const SESSION_POST_SELECT = {
  id: true,
  code: true,
  name: true,
  status: true,
  agentStatus: true,
  lastSeenAt: true,
} as const;

const OPENABLE_ASSIGNMENT_STATUSES = ['planned', 'locked', 'breakdown_reassigned'] as const;

function isOpenableAssignmentStatus(status: string): boolean {
  return (OPENABLE_ASSIGNMENT_STATUSES as readonly string[]).includes(status);
}

type SessionConflictCode =
  | 'OPERATOR_POST_SESSION_OPERATOR_CONFLICT'
  | 'OPERATOR_POST_SESSION_OPEN_BAG_USAGE'
  | 'OPERATOR_POST_SESSION_RACE_CONFLICT'
  | 'OPERATOR_POST_SESSION_ASSIGNMENT_AMBIGUOUS'
  | 'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT';

function sessionConflict(code: SessionConflictCode, message: string): ConflictException {
  return new ConflictException({ code, message });
}

type LockActiveSessionOptions = {
  allowMissing?: boolean;
  allowUnboundShift?: boolean;
  postId?: string;
};

type ActiveSessionLockClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'operatorPostSession'>;

type PostBacklogOwnerSession = Pick<OperatorPostSession, 'id' | 'operatorId' | 'postId'>;

type PostBacklogSuccessor = PostBacklogOwnerSession & {
  shiftId: string;
  postCode: string;
};

/**
 * "Who is at this post right now" (V2 S3). Operators rotate across the 5 fixed posts by
 * shift; an operator holds at most one active session, while a post may host several. The
 * weight capture path depends on requireActive() — no scale reading without a live session.
 */
@Injectable()
export class OperatorSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deviceReadiness: PostDeviceReadinessService,
  ) {}

  async open(operator: OperatorActor, postCode: string) {
    try {
      return await this.prisma.$transaction((tx) => this.openInTransaction(tx, operator, postCode));
    } catch (error) {
      if (!(error instanceof PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
    }

    // The partial operator-unique constraint may race with another opener. Retry the
    // full locked path: never reuse an unlocked
    // snapshot that could now point at a broken post or a changed assignment.
    try {
      return await this.prisma.$transaction((tx) => this.openInTransaction(tx, operator, postCode));
    } catch (error) {
      if (error instanceof PrismaClientKnownRequestError && error.code === 'P2002') {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_RACE_CONFLICT',
          'Post session state changed concurrently; retry with the current assignment',
        );
      }
      throw error;
    }
  }

  /** Internal transaction-aware seam used by the atomic shift + Big-bag opening flow. */
  async openInTransaction(tx: Prisma.TransactionClient, operator: OperatorActor, postCode: string) {
    if (!operator.userId) {
      throw new ConflictException('Post sessions require a logged-in operator account.');
    }
    const operatorId = operator.userId;
    const post = await tx.post.findUnique({ where: { code: postCode } });
    if (!post) throw new NotFoundException(`Post ${postCode} not found`);

    const assignment = await this.currentAssignment(tx, operatorId);
    const shift = assignment.shift;
    if (post.status !== 'active') {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        `Post ${postCode} is not active`,
      );
    }
    if (assignment.postId !== post.id) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        `Operator is assigned to another post for shift ${shift.label}`,
      );
    }
    await this.lockOpenTopology(tx, post.id, shift.id, assignment.id);
    const [lockedPost, lockedShift, lockedAssignment] = await Promise.all([
      tx.post.findUnique({ where: { id: post.id } }),
      tx.shift.findUnique({ where: { id: shift.id } }),
      tx.operatorShiftMachineAssignment.findUnique({ where: { id: assignment.id } }),
    ]);
    const revalidatedAt = new Date();
    if (!lockedPost || lockedPost.status !== 'active') {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        `Post ${postCode} changed before the session could open`,
      );
    }
    if (
      !lockedShift ||
      !['planned', 'open'].includes(lockedShift.status) ||
      (lockedShift.plannedStartAt !== null && lockedShift.plannedStartAt > revalidatedAt) ||
      (lockedShift.plannedEndAt !== null && lockedShift.plannedEndAt <= revalidatedAt)
    ) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'The current shift changed before the session could open',
      );
    }
    if (
      !lockedAssignment ||
      lockedAssignment.shiftId !== lockedShift.id ||
      lockedAssignment.operatorId !== operatorId ||
      lockedAssignment.postId !== lockedPost.id ||
      !isOpenableAssignmentStatus(lockedAssignment.status)
    ) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'The machine assignment changed before the session could open',
      );
    }
    const activeAfterLock = await this.lockActiveInTransaction(tx, operatorId, {
      allowMissing: true,
      postId: lockedPost.id,
    });
    if (activeAfterLock) {
      if (!activeAfterLock.shiftId) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
          'Active operator session is not bound to a production shift',
        );
      }
      if (activeAfterLock.postId === lockedPost.id && activeAfterLock.shiftId === lockedShift.id) {
        if (
          lockedShift.status !== 'open' ||
          !['locked', 'breakdown_reassigned'].includes(lockedAssignment.status)
        ) {
          throw sessionConflict(
            'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
            'Active operator session has not been committed to an open shift assignment',
          );
        }
        return activeAfterLock;
      }
      throw sessionConflict(
        'OPERATOR_POST_SESSION_OPERATOR_CONFLICT',
        activeAfterLock.shiftId !== lockedShift.id
          ? 'Operator already has an active session in another shift'
          : 'Operator already has an active session at another post',
      );
    }
    await this.deviceReadiness.require(lockedPost.id, 'operator.shift.open', tx);
    const now = new Date();
    if (lockedShift.status === 'planned') {
      const openedShift = await tx.shift.updateMany({
        where: { id: lockedShift.id, status: 'planned' },
        data: { status: 'open', startedAt: now },
      });
      if (openedShift.count !== 1) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
          'The current shift changed before the session could open',
        );
      }
    }
    if (lockedAssignment.status === 'planned') {
      const locked = await tx.operatorShiftMachineAssignment.updateMany({
        where: {
          id: lockedAssignment.id,
          shiftId: lockedShift.id,
          operatorId,
          postId: lockedPost.id,
          status: 'planned',
        },
        data: { status: 'locked', lockedAt: now },
      });
      if (locked.count !== 1) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
          'The machine assignment changed before the session could open',
        );
      }
    }
    const session = await tx.operatorPostSession.create({
      data: {
        operatorId,
        postId: lockedPost.id,
        shiftId: lockedShift.id,
        status: 'active',
      },
    });
    await this.claimPostBacklog(tx, operator, session, lockedShift.id, lockedPost.code);
    await this.audit.record(
      {
        type: 'audit:operator_post_session_opened',
        actorRole: operator.role,
        actorId: operatorId,
        objectId: lockedPost.code,
        detail: {
          postId: lockedPost.id,
          sessionId: session.id,
          shiftId: lockedShift.id,
        },
      },
      tx,
    );
    return session;
  }

  /**
   * The caller already holds the post row lock. The first valid session opened after the
   * predecessor is the only successor; PostgreSQL resolves equal timestamps by the stable id.
   */
  async handoffPostBacklogAfterCloseInTransaction(
    tx: Prisma.TransactionClient,
    actor: OperatorActor,
    closedSession: Pick<OperatorPostSession, 'id' | 'postId' | 'startedAt'>,
  ): Promise<string | null> {
    const [successor] = await tx.$queryRaw<PostBacklogSuccessor[]>(Prisma.sql`
      SELECT candidate."id",
             candidate."operatorId",
             candidate."postId",
             candidate."shiftId",
             post."code" AS "postCode"
      FROM "operator_post_sessions" AS candidate
      JOIN "shifts" AS shift
        ON shift."id" = candidate."shiftId" AND shift."status" = 'open'
      JOIN "operator_shift_machine_assignments" AS assignment
        ON assignment."shiftId" = candidate."shiftId"
       AND assignment."operatorId" = candidate."operatorId"
       AND assignment."postId" = candidate."postId"
       AND assignment."status" IN ('locked', 'breakdown_reassigned')
      JOIN "posts" AS post
        ON post."id" = candidate."postId" AND post."status" = 'active'
      WHERE candidate."postId" = ${closedSession.postId}
        AND candidate."id" <> ${closedSession.id}
        AND candidate."status" = 'active'
        AND candidate."startedAt" > ${closedSession.startedAt}
      ORDER BY candidate."startedAt" ASC, candidate."id" ASC
      LIMIT 1
      FOR UPDATE OF candidate
    `);
    if (!successor) return null;

    await this.claimPostBacklog(
      tx,
      actor,
      successor,
      successor.shiftId,
      successor.postCode,
      closedSession.id,
    );
    return successor.id;
  }

  private async claimPostBacklog(
    tx: Prisma.TransactionClient,
    operator: OperatorActor,
    session: PostBacklogOwnerSession,
    shiftId: string,
    postCode: string,
    sourceSessionId?: string,
  ): Promise<void> {
    const preparedRoll = await tx.rollDispatchItem.findFirst({
      where: {
        assignedOperatorId: session.operatorId,
        plannedShiftId: shiftId,
        status: { notIn: ['done', 'ready_for_warehouse'] },
      },
      select: { id: true },
    });
    if (preparedRoll) return;

    const rolls = await tx.rollDispatchItem.findMany({
      where: {
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: session.postId,
        status: { in: ['assigned', 'deferred'] },
      },
      select: { id: true, rollCode: true },
      orderBy: [{ queueRank: 'asc' }, { id: 'asc' }],
    });
    if (rolls.length === 0) return;

    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "roll_dispatch_items"
        WHERE "id" IN (${Prisma.join(rolls.map(({ id }) => id).sort())})
        ORDER BY "id" FOR UPDATE`,
    );
    const moved = await tx.rollDispatchItem.updateMany({
      where: {
        id: { in: rolls.map(({ id }) => id) },
        assignedOperatorId: null,
        plannedShiftId: null,
        postId: session.postId,
        status: { in: ['assigned', 'deferred'] },
      },
      data: {
        assignedOperatorId: session.operatorId,
        plannedShiftId: shiftId,
        workplaceId: session.postId,
        machineId: postCode,
      },
    });
    if (moved.count !== rolls.length) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'Post roll backlog changed while the new shift was opening',
      );
    }

    await this.audit.record(
      {
        type: 'audit:roll_dispatch_bulk_assigned',
        actorRole: operator.role,
        actorId: operator.userId,
        objectId: shiftId,
        oldValue: { operatorId: null, shiftId: null, postId: session.postId },
        newValue: {
          operatorId: session.operatorId,
          shiftId,
          postId: session.postId,
          machineId: postCode,
        },
        reason: 'Автоматическая передача незавершённых рулонов следующему оператору поста',
        detail: {
          count: moved.count,
          rollCodes: rolls.map(({ rollCode }) => rollCode),
          sessionId: session.id,
          ...(sourceSessionId
            ? {
                sourceSessionId,
                selectionRule: 'first_active_session_after_predecessor',
              }
            : {}),
          automaticPostHandover: true,
        },
      },
      tx,
    );
  }

  async close(operator: OperatorActor) {
    if (!operator.userId) return { ok: true as const };
    const operatorId = operator.userId;
    await this.prisma.$transaction(async (tx) => {
      const active = await this.lockActiveInTransaction(tx, operatorId, {
        allowMissing: true,
        allowUnboundShift: true,
      });
      if (!active) return;
      const openBagUsage = await tx.shiftBagUsage.findFirst({
        where: { sessionId: active.id, closedAt: null },
        select: { id: true },
      });
      if (openBagUsage) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_OPEN_BAG_USAGE',
          'Close the operator shift with final bag weights before closing the post session',
        );
      }
      const claimed = await tx.operatorPostSession.updateMany({
        where: { id: active.id, status: 'active' },
        data: { status: 'closed', endedAt: new Date() },
      });
      if (claimed.count !== 1) return;
      await this.audit.record(
        {
          type: 'audit:operator_post_session_closed',
          actorRole: operator.role,
          actorId: operatorId,
          objectId: active.postId,
          detail: { sessionId: active.id },
        },
        tx,
      );
    });
    return { ok: true as const };
  }

  getCurrent(operatorId: string) {
    return this.prisma.operatorPostSession.findFirst({
      where: { operatorId, status: 'active' },
      // Whitelist the post fields the operator may see — never the per-post agentTokenHash,
      // which is an agent credential (raw device/agent secrets are admin-only, ТЗ §8).
      include: {
        post: { select: SESSION_POST_SELECT },
        operator: { select: { displayName: true } },
      },
    });
  }

  /**
   * «Станок сломался» с поста оператора (дизайн 2026-07-14): пост сразу broken
   * (fail-safe — назначить на заявленный станок никого нельзя), заявка уходит
   * завпроизводства проблемой machine_breakdown. Повторное нажатие идемпотентно.
   */
  async reportMachineBreakdown(operator: OperatorActor, dto: MachineBreakdownRequest) {
    const label = MACHINE_BREAKDOWN_TYPE_LABELS[dto.type];
    if (!label) throw new ConflictException('Выберите тип поломки станка');
    const details = dto.details?.trim() || null;
    const reason = details ? `${label} — ${details}` : label;
    const session = await this.requireActive(operator.userId);
    return this.prisma.$transaction(async (tx) => {
      // The Post row is the shared serialization boundary for operator reports,
      // production-lead reports and breakdown reassignment. Keep it first in the
      // lock order so all three paths observe one authoritative machine state.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${session.postId} FOR UPDATE`,
      );
      const lockedSession = await this.lockActiveInTransaction(tx, operator.userId, {
        allowMissing: true,
        postId: session.postId,
      });
      if (
        !lockedSession ||
        lockedSession.id !== session.id ||
        lockedSession.postId !== session.postId ||
        lockedSession.shiftId !== session.shiftId
      ) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
          'Operator post session changed before the breakdown could be reported',
        );
      }
      const post = await tx.post.findUnique({ where: { id: session.postId } });
      if (!post) throw new NotFoundException(`Post ${session.postId} not found`);
      const existing = await tx.productionProblem.findFirst({
        where: { postId: post.id, type: 'machine_breakdown', status: 'open' },
      });
      if (existing) {
        if (post.status !== 'broken') {
          throw sessionConflict(
            'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
            `Post ${post.code} has an inconsistent open breakdown state`,
          );
        }
        return existing;
      }
      if (!['active', 'broken'].includes(post.status)) {
        throw sessionConflict(
          'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
          `Post ${post.code} is not available for a breakdown report (${post.status})`,
        );
      }
      if (post.status !== 'broken') {
        await tx.post.update({ where: { id: post.id }, data: { status: 'broken' } });
      }
      const problem = await tx.productionProblem.create({
        data: {
          type: 'machine_breakdown',
          machineBreakdownType: dto.type,
          postId: post.id,
          actorRole: operator.role,
          reason,
        },
      });
      await this.audit.record(
        {
          type: 'problem:machine_breakdown_reported',
          actorRole: operator.role,
          actorId: operator.userId,
          objectId: post.id,
          reason,
          detail: {
            problemId: problem.id,
            machineId: post.code,
            sessionId: lockedSession.id,
            machineBreakdownType: dto.type,
            machineBreakdownDetails: details,
          },
        },
        tx,
      );
      await this.audit.record(
        {
          type: 'notification:production_problem_received',
          actorRole: operator.role,
          actorId: operator.userId,
          objectId: post.id,
          label: 'Оператор сообщил о поломке станка',
          reason,
          detail: {
            problemId: problem.id,
            machineId: post.code,
            machineBreakdownType: dto.type,
            machineBreakdownDetails: details,
          },
        },
        tx,
      );
      return problem;
    });
  }

  /** The active session for this operator, or 409 — gates scale capture (no session, no weight). */
  async requireActive(operatorId: string | null) {
    const session = operatorId
      ? await this.prisma.operatorPostSession.findFirst({
          where: { operatorId, status: 'active' },
        })
      : null;
    if (!session) {
      throw new ConflictException('No active post session — open a post session before weighing.');
    }
    if (!session.shiftId) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'Active operator session is not bound to a production shift',
      );
    }
    return session;
  }

  async lockActiveInTransaction(
    tx: ActiveSessionLockClient,
    operatorId: string | null,
  ): Promise<OperatorPostSession>;
  async lockActiveInTransaction(
    tx: ActiveSessionLockClient,
    operatorId: string | null,
    options: LockActiveSessionOptions & { allowMissing: true },
  ): Promise<OperatorPostSession | null>;
  async lockActiveInTransaction(
    tx: ActiveSessionLockClient,
    operatorId: string | null,
    options: LockActiveSessionOptions = {},
  ): Promise<OperatorPostSession | null> {
    if (!operatorId) {
      if (options.allowMissing) return null;
      throw new ConflictException('Post sessions require a logged-in operator account.');
    }

    const sessionScope = options.postId
      ? Prisma.sql`("operatorId" = ${operatorId} OR "postId" = ${options.postId})`
      : Prisma.sql`"operatorId" = ${operatorId}`;
    await tx.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "operator_post_sessions"
        WHERE "status" = 'active' AND ${sessionScope}
        ORDER BY "id"
        FOR UPDATE
      `,
    );

    const session = await tx.operatorPostSession.findFirst({
      where: { operatorId, status: 'active' },
    });
    if (!session) {
      if (options.allowMissing) return null;
      throw new ConflictException('No active post session — open a post session before weighing.');
    }
    if (!session.shiftId && !options.allowUnboundShift) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'Active operator session is not bound to a production shift',
      );
    }
    return session;
  }

  private async lockOpenTopology(
    client: Prisma.TransactionClient,
    postId: string,
    shiftId: string,
    assignmentId: string,
  ): Promise<void> {
    await client.$queryRaw(Prisma.sql`SELECT "id" FROM "posts" WHERE "id" = ${postId} FOR UPDATE`);
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "shifts" WHERE "id" = ${shiftId} FOR UPDATE`,
    );
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "operator_shift_machine_assignments" WHERE "id" = ${assignmentId} FOR UPDATE`,
    );
  }

  private async currentAssignment(
    client: Pick<Prisma.TransactionClient, 'operatorShiftMachineAssignment'>,
    operatorId: string,
  ) {
    const assignments = await client.operatorShiftMachineAssignment.findMany({
      where: {
        operatorId,
        status: { in: [...OPENABLE_ASSIGNMENT_STATUSES] },
        shift: {
          status: { in: ['planned', 'open'] },
        },
      },
      include: { shift: true },
      orderBy: [{ shift: { createdAt: 'desc' } }, { createdAt: 'desc' }],
      take: 2,
    });
    if (assignments.length > 1) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_ASSIGNMENT_AMBIGUOUS',
        'Operator has multiple current shift assignments',
      );
    }
    const assignment = assignments[0];
    if (!assignment) {
      throw sessionConflict(
        'OPERATOR_POST_SESSION_TOPOLOGY_CONFLICT',
        'No machine is assigned to this operator for the current shift',
      );
    }
    return assignment;
  }
}
