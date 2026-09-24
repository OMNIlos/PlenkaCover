import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OperatorShiftService } from '../src/modules/operator/operator-shift.service';
import { initializeE2eApp } from './e2e-app';
import { runE2eWithCleanup } from './e2e-database';

describe('operator shift BigBag episodes (e2e, real PostgreSQL)', () => {
  jest.setTimeout(60_000);

  const suffix = randomUUID();
  const operatorId = `episode-operator-${suffix}`;
  const postId = `episode-post-${suffix}`;
  const shiftId = `episode-shift-${suffix}`;
  const sessionId = `episode-session-${suffix}`;
  const firstBagId = `episode-first-bag-${suffix}`;
  const secondBagId = `episode-second-bag-${suffix}`;
  const firstBagCode = `EPISODE-FIRST-${suffix}`;
  const secondBagCode = `EPISODE-SECOND-${suffix}`;
  const actor = { userId: operatorId, role: 'operator' as const };

  let app: INestApplication;
  let prisma: PrismaService;
  let shifts: OperatorShiftService;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = moduleRef.get(PrismaService);
    shifts = moduleRef.get(OperatorShiftService);
    await initializeE2eApp(app);

    await prisma.user.create({
      data: {
        id: operatorId,
        externalId: operatorId,
        login: `${operatorId}@test.local`,
        displayName: 'Episode operator',
        role: Role.operator,
      },
    });
    await prisma.post.create({
      data: { id: postId, code: `EPISODE-POST-${suffix}`, name: 'Episode test post' },
    });
    await prisma.shift.create({
      data: { id: shiftId, label: 'Episode test shift', status: 'open' },
    });
    await prisma.operatorShiftMachineAssignment.create({
      data: {
        id: `episode-assignment-${suffix}`,
        shiftId,
        operatorId,
        postId,
        status: 'locked',
      },
    });
    await prisma.operatorPostSession.create({
      data: {
        id: sessionId,
        operatorId,
        postId,
        shiftId,
        status: 'active',
      },
    });
    await prisma.bigBagUnit.createMany({
      data: [
        {
          id: firstBagId,
          code: firstBagCode,
          material: 'ПВД',
          initialKg: 500,
          currentKg: 500,
          status: 'in_use',
          registrationStatus: 'registered',
          location: 'production',
          createdByRole: Role.warehouse,
        },
        {
          id: secondBagId,
          code: secondBagCode,
          material: 'ПВД',
          initialKg: 300,
          currentKg: 300,
          status: 'available',
          registrationStatus: 'registered',
          location: 'production',
          createdByRole: Role.warehouse,
        },
      ],
    });
    await prisma.shiftBagUsage.create({
      data: {
        id: `episode-usage-${suffix}`,
        sessionId,
        bigBagId: firstBagId,
        startKg: 500,
        sequence: 1,
        episodes: { create: { sequence: 1, startKg: 500 } },
      },
    });
  });

  afterAll(async () => {
    await runE2eWithCleanup(
      async () => undefined,
      [{ label: 'operator shift BigBag episode app', run: async () => app?.close() }],
    );
  });

  it('returns without a reason, re-adds atomically and replays a concurrent double submit', async () => {
    const releaseOperationKey = randomUUID();
    const released = await shifts.releaseBag(actor, firstBagId, {
      operationKey: releaseOperationKey,
      endKg: 450,
    });
    const replay = await shifts.releaseBag(actor, firstBagId, {
      operationKey: releaseOperationKey,
      endKg: 450,
    });
    expect(replay).toEqual(released);
    expect(released).toMatchObject({ bagId: firstBagId, endKg: 450, status: 'available' });

    const [releasedBag, releaseMovements, availableBags] = await Promise.all([
      prisma.bigBagUnit.findUniqueOrThrow({
        where: { id: firstBagId },
        select: { currentKg: true, lastMeasuredKg: true, status: true },
      }),
      prisma.bigBagMovement.count({
        where: { operationKey: releaseOperationKey, kind: 'operator_shift_release' },
      }),
      shifts.listBigBags(),
    ]);
    expect(releasedBag).toEqual({ currentKg: 450, lastMeasuredKg: 450, status: 'available' });
    expect(releaseMovements).toBe(1);
    expect(availableBags).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstBagId, currentKg: 450 })]),
    );

    const releaseEvents = await prisma.domainEvent.findMany({
      where: {
        objectId: firstBagCode,
        type: { in: ['audit:bigbag_weight_recorded', 'audit:operator_shift_bag_released'] },
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(releaseEvents).toHaveLength(2);
    expect(releaseEvents.every(({ reason }) => reason === null)).toBe(true);

    await shifts.addBag(actor, { bigBagId: firstBagId, startKg: 450 });
    const firstUsage = await prisma.shiftBagUsage.findUniqueOrThrow({
      where: { sessionId_bigBagId: { sessionId, bigBagId: firstBagId } },
      include: { episodes: { orderBy: { sequence: 'asc' } } },
    });
    expect(firstUsage).toMatchObject({
      startKg: 450,
      endKg: null,
      closedAt: null,
      releasedReason: null,
    });
    expect(firstUsage.episodes).toEqual([
      expect.objectContaining({
        sequence: 1,
        startKg: 500,
        endKg: 450,
        closeKind: 'released',
      }),
      expect.objectContaining({ sequence: 2, startKg: 450, endKg: null, closeKind: null }),
    ]);

    const addEventsBeforeDoubleSubmit = await prisma.domainEvent.count({
      where: { objectId: sessionId, type: 'audit:operator_shift_bag_added' },
    });

    await expect(
      Promise.all([
        shifts.addBag(actor, { bigBagId: secondBagId, startKg: 300 }),
        shifts.addBag(actor, { bigBagId: secondBagId, startKg: 300 }),
      ]),
    ).resolves.toHaveLength(2);

    const [secondLinks, secondEpisodes, secondAddEvents] = await Promise.all([
      prisma.shiftBagUsage.count({ where: { sessionId, bigBagId: secondBagId } }),
      prisma.shiftBagUsageEpisode.count({ where: { usage: { sessionId, bigBagId: secondBagId } } }),
      prisma.domainEvent.count({
        where: { objectId: sessionId, type: 'audit:operator_shift_bag_added' },
      }),
    ]);
    expect({
      secondLinks,
      secondEpisodes,
      secondAddEvents: secondAddEvents - addEventsBeforeDoubleSubmit,
    }).toEqual({
      secondLinks: 1,
      secondEpisodes: 1,
      secondAddEvents: 1,
    });
  });
});
