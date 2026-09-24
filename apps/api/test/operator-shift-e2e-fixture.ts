import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../src/common/prisma/prisma.service';

type AuthHeaders = Record<string, string>;

type AvailableBigBag = {
  id: string;
  code: string;
  currentKg: number | null;
  warehouseKg: number | null;
  status: string;
};

export type OperatorShiftBagFixture = {
  sessionId: string;
  bigBagId: string;
  startKg: number;
};

export type AssignedOperatorShiftFixture = {
  shiftId: string;
  assignmentId: string;
  post: {
    id: string;
    code: string;
    status: string;
  };
};

/** Represent a completed physical defect-bag handoff in e2e scenarios testing other close rules. */
export async function prepareReadyDefectBagFixture(
  prisma: PrismaService,
  operatorId: string,
): Promise<void> {
  const session = await prisma.operatorPostSession.findFirstOrThrow({
    where: { operatorId, status: 'active' },
    select: { id: true, postId: true },
  });
  const existing = await prisma.defectBag.findFirst({ where: { postSessionId: session.id } });
  if (existing) {
    if (['ready_for_warehouse', 'received', 'shipped'].includes(existing.status)) return;
    throw new Error(`E2E defect bag for session ${session.id} is not ready`);
  }

  const now = new Date();
  await prisma.defectBag.create({
    data: {
      code: `DEF-${randomUUID()}`,
      postSessionId: session.id,
      status: 'ready_for_warehouse',
      weightKg: 0,
      recordedDefectKg: 0,
      differenceKg: 0,
      scaleDeviceId: `e2e-scale-${session.id}`,
      scaleStatus: 'ready',
      scaleStable: true,
      weighOperationKey: randomUUID(),
      scanToken: { create: {} },
      labelPrintJobs: {
        create: {
          operationKey: randomUUID(),
          printerId: `e2e-printer-${session.id}`,
          status: 'submitted',
          actorId: operatorId,
          postSessionId: session.id,
          postId: session.postId,
          leaseToken: randomUUID(),
          leaseExpiresAt: now,
          completedAt: now,
        },
      },
    },
  });
}

export async function createAvailableBigBagFixture(
  prisma: PrismaService,
  input: { code: string; material?: string; weightKg?: number },
): Promise<string> {
  const weightKg = input.weightKg ?? 500;
  const bag = await prisma.bigBagUnit.create({
    data: {
      code: input.code,
      material: input.material ?? 'ПВД Первичное',
      initialKg: weightKg,
      currentKg: weightKg,
      lastMeasuredKg: weightKg,
      status: 'available',
      registrationStatus: 'registered',
      location: 'production',
      createdByRole: 'warehouse',
    },
    select: { id: true },
  });
  return bag.id;
}

/**
 * Exercise the real Big-Bag registration and warehouse→production transitions with the opaque
 * label token. Reading the token is allowed only inside this isolated test fixture.
 */
export async function registerAndSendBigBagToProduction(
  app: INestApplication,
  prisma: PrismaService,
  warehouseAuth: AuthHeaders,
  bigBagId: string,
): Promise<void> {
  const scanToken = await prisma.bigBagScanToken.findUnique({
    where: { bigBagId },
    select: { token: true },
  });
  if (!scanToken) throw new Error(`E2E Big-Bag ${bigBagId} has no scan token`);

  for (const destination of ['warehouse', 'production'] as const) {
    await request(app.getHttpServer())
      .post('/api/warehouse/big-bags/scans')
      .set(warehouseAuth)
      .send({
        operationKey: randomUUID(),
        qrCode: scanToken.token,
        destination,
      })
      .expect(200);
  }

  await expect(
    prisma.bigBagUnit.findUnique({
      where: { id: bigBagId },
      select: { registrationStatus: true, location: true, status: true },
    }),
  ).resolves.toEqual({
    registrationStatus: 'registered',
    location: 'production',
    status: 'available',
  });
}

/**
 * Release a session created by another e2e fixture without leaving an open bag usage behind.
 * This is test cleanup, so the neutral end weight is the captured start weight (zero usage).
 */
export async function closeOperatorSessionFixture(
  prisma: PrismaService,
  sessionId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const session = await tx.operatorPostSession.findUnique({ where: { id: sessionId } });
    if (!session || session.status !== 'active') return;
    const openUsages = await tx.shiftBagUsage.findMany({
      where: { sessionId, closedAt: null },
      select: { id: true, bigBagId: true, startKg: true },
    });
    const closedAt = new Date();
    for (const usage of openUsages) {
      await tx.bigBagUnit.update({
        where: { id: usage.bigBagId },
        data: {
          status: 'available',
          currentKg: usage.startKg,
          lastMeasuredKg: usage.startKg,
        },
      });
      await tx.shiftBagUsage.update({
        where: { id: usage.id },
        data: { endKg: usage.startKg, closedAt },
      });
    }
    await tx.operatorPostSession.update({
      where: { id: sessionId },
      data: { status: 'closed', endedAt: closedAt },
    });
  });
}

/**
 * Create one current planned shift for the exact operator/post pair used by an e2e flow.
 *
 * Suites must not borrow the demo seed shift or session: an earlier failed suite can leave the
 * shared post occupied, while production still correctly refuses a second operator session.
 */
export async function createAssignedOperatorShiftFixture(
  prisma: PrismaService,
  input: {
    operatorId: string;
    postCode: string;
    label: string;
  },
): Promise<AssignedOperatorShiftFixture> {
  const post = await prisma.post.findUnique({
    where: { code: input.postCode },
    select: { id: true, code: true, status: true },
  });
  if (!post || post.status !== 'active') {
    throw new Error(`E2E fixture requires active post ${input.postCode}`);
  }

  const occupiedSessions = await prisma.operatorPostSession.findMany({
    where: {
      status: 'active',
      OR: [{ operatorId: input.operatorId }, { postId: post.id }],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const session of occupiedSessions) {
    await closeOperatorSessionFixture(prisma, session.id);
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const conflictingAssignments = await tx.operatorShiftMachineAssignment.findMany({
      where: {
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        shift: { status: { in: ['planned', 'open'] } },
        OR: [{ operatorId: input.operatorId }, { postId: post.id }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    if (conflictingAssignments.length > 0) {
      await tx.operatorShiftMachineAssignment.updateMany({
        where: { id: { in: conflictingAssignments.map(({ id }) => id) } },
        data: { status: 'completed' },
      });
    }

    const shift = await tx.shift.create({
      data: {
        label: input.label,
        plannedStartAt: new Date(now.getTime() - 60_000),
        plannedEndAt: new Date(now.getTime() + 60 * 60_000),
        status: 'planned',
      },
      select: { id: true },
    });
    const assignment = await tx.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: input.operatorId,
        postId: post.id,
        status: 'planned',
      },
      select: { id: true },
    });
    const usableAssignments = await tx.operatorShiftMachineAssignment.findMany({
      where: {
        status: { in: ['planned', 'locked', 'breakdown_reassigned'] },
        shift: { status: { in: ['planned', 'open'] } },
        OR: [{ operatorId: input.operatorId }, { postId: post.id }],
      },
      select: { id: true, operatorId: true, postId: true, shiftId: true },
      orderBy: { id: 'asc' },
    });
    if (
      usableAssignments.length !== 1 ||
      usableAssignments[0]?.id !== assignment.id ||
      usableAssignments[0].operatorId !== input.operatorId ||
      usableAssignments[0].postId !== post.id ||
      usableAssignments[0].shiftId !== shift.id
    ) {
      throw new Error(`E2E fixture failed to isolate operator/post topology for ${post.code}`);
    }
    return {
      shiftId: shift.id,
      assignmentId: assignment.id,
      post,
    };
  });
}

/** Attach a real open bag usage to an already-open operator post session. */
export async function attachAvailableBagToOperatorShift(
  app: INestApplication,
  prisma: PrismaService,
  auth: AuthHeaders,
  postCode: string,
  bigBagId?: string,
): Promise<OperatorShiftBagFixture> {
  const currentResponse = await request(app.getHttpServer())
    .get('/api/operator/post-sessions/current')
    .set(auth)
    .expect(200);
  const current = currentResponse.body as {
    id?: string;
    operatorId?: string;
    postId?: string;
    shiftId?: string | null;
    status?: string;
    post?: { code?: string };
  } | null;
  if (
    !current?.id ||
    !current.operatorId ||
    !current.postId ||
    !current.shiftId ||
    current.status !== 'active' ||
    current.post?.code !== postCode
  ) {
    throw new Error(`E2E fixture has no exact active session for post ${postCode}`);
  }
  const [shift, assignment, existingUsages] = await Promise.all([
    prisma.shift.findUnique({ where: { id: current.shiftId } }),
    prisma.operatorShiftMachineAssignment.findUnique({
      where: {
        shiftId_operatorId: {
          shiftId: current.shiftId,
          operatorId: current.operatorId,
        },
      },
    }),
    prisma.shiftBagUsage.findMany({
      where: { sessionId: current.id, closedAt: null },
      include: { bigBag: true },
    }),
  ]);
  if (
    shift?.status !== 'open' ||
    assignment?.postId !== current.postId ||
    !['locked', 'breakdown_reassigned'].includes(assignment.status)
  ) {
    throw new Error(`E2E fixture session topology changed for post ${postCode}`);
  }
  if (existingUsages.length > 0) {
    if (
      existingUsages.length !== 1 ||
      existingUsages[0]!.bigBag.status !== 'in_use' ||
      existingUsages[0]!.startKg <= 0
    ) {
      throw new Error(`E2E fixture found an incoherent open Big-bag usage on post ${postCode}`);
    }
    return {
      sessionId: current.id,
      bigBagId: existingUsages[0]!.bigBagId,
      startKg: existingUsages[0]!.startKg,
    };
  }

  const response = await request(app.getHttpServer())
    .get('/api/operator/big-bags')
    .set(auth)
    .expect(200);
  const bag = (response.body as AvailableBigBag[]).find(
    (candidate) =>
      candidate.status === 'available' && (bigBagId === undefined || candidate.id === bigBagId),
  );
  if (!bag) {
    throw new Error(
      bigBagId
        ? `E2E fixture requires available Big-bag ${bigBagId}`
        : 'E2E fixture requires one available Big-bag',
    );
  }
  const startKg = bag.currentKg ?? bag.warehouseKg;
  if (startKg == null || !Number.isFinite(startKg) || startKg <= 0) {
    throw new Error(`E2E Big-bag ${bag.code} has no positive start weight`);
  }
  await request(app.getHttpServer())
    .post('/api/operator/shift/open')
    .set(auth)
    .send({ postCode, bigBagId: bag.id, startKg })
    .expect(201);
  const createdUsages = await prisma.shiftBagUsage.findMany({
    where: { sessionId: current.id, bigBagId: bag.id, closedAt: null },
    include: { bigBag: true },
  });
  if (
    createdUsages.length !== 1 ||
    createdUsages[0]!.bigBag.status !== 'in_use' ||
    createdUsages[0]!.startKg !== startKg
  ) {
    throw new Error(`E2E fixture failed to persist the claimed Big-bag ${bag.code}`);
  }
  return { sessionId: current.id, bigBagId: bag.id, startKg };
}
