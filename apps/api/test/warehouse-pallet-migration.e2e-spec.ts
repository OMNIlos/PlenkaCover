import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, Role } from '@prisma/client';

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture(prisma: PrismaClient, label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const [orderA, orderB] = await Promise.all([
    prisma.commercialOrder.create({
      data: {
        orderNumber: `PALLET-A-${suffix}`,
        creatorRole: Role.commercial,
      },
    }),
    prisma.commercialOrder.create({
      data: {
        orderNumber: `PALLET-B-${suffix}`,
        creatorRole: Role.commercial,
      },
    }),
  ]);
  const task = await prisma.warehouseAcceptanceTask.create({
    data: {
      mode: 'receiving',
      status: 'open',
      operationCode: `ПР-${suffix}`,
    },
  });
  const rows = await Promise.all(
    [1, 2, 3].map((position) =>
      prisma.scanRow.create({
        data: {
          taskId: task.id,
          rollCode: `PALLET-ROLL-${position}-${suffix}`,
          scanStatus: 'accepted',
          lastScanAt: new Date(`2026-07-31T12:0${position}:00.000Z`),
        },
      }),
    ),
  );
  return { orderA, orderB, rows, suffix, task };
}

async function createOpenPallet(prisma: PrismaClient, fixture: Fixture, sequenceNo = 1) {
  return prisma.warehousePallet.create({
    data: {
      palletCode: `PAL-${fixture.suffix}-${sequenceNo}`,
      taskId: fixture.task.id,
      orderId: fixture.orderA.id,
      sequenceNo,
    },
  });
}

async function createPhysicalFactGuardFixture(prisma: PrismaClient, label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const order = await prisma.commercialOrder.create({
    data: {
      orderNumber: `PALLET-GUARD-${suffix}`,
      creatorRole: Role.commercial,
      warehouseCoverageWorkflowVersion: 2,
    },
  });
  const position = await prisma.commercialOrderPosition.create({
    data: {
      orderId: order.id,
      rollCount: 1,
      filmType: 'полотно',
      actualThickness: '80',
      accountingThickness: '80',
    },
  });
  const fingerprint = 'a'.repeat(64);
  const calculation = await prisma.warehouseCoverageCalculation.create({
    data: {
      orderId: order.id,
      generation: 1,
      orderVersion: 1,
      positionVersions: [{ positionId: position.id, version: position.version }],
      orderFingerprint: fingerprint,
      inventoryEpoch: 0n,
      inventoryFingerprint: fingerprint,
      inputFingerprint: fingerprint,
      algorithmVersion: 'warehouse-coverage-matching/v1',
      policyVersion: 'warehouse-coverage-policy/v1',
      availability: 'unavailable',
      reasonCodes: ['no_compatible_rolls'],
      requiredRollCount: 1,
      matchedRollCount: 0,
      uncertainRollCount: 0,
      verifiedCandidateRollIds: [],
      uncertainCandidateRollIds: [],
      systemActorKey: 'warehouse_coverage_engine',
    },
  });
  const decisionId = randomUUID();

  await prisma.$executeRawUnsafe('ALTER TABLE "warehouse_coverage_decisions" DISABLE TRIGGER USER');
  await prisma.$executeRawUnsafe('ALTER TABLE "warehouse_acceptance_tasks" DISABLE TRIGGER USER');
  await prisma.$executeRawUnsafe('ALTER TABLE "scan_rows" DISABLE TRIGGER USER');
  try {
    await prisma.warehouseCoverageDecision.create({
      data: {
        id: decisionId,
        orderId: order.id,
        calculationId: calculation.id,
        generation: 1,
        kind: 'auto_produce_all',
        inputFingerprint: fingerprint,
        sourceInventoryEpoch: 0n,
        committedInventoryEpoch: null,
        expectedRollCount: 0,
        actorKind: 'system',
        actorRole: null,
        actorId: null,
        systemActorKey: 'warehouse_coverage_engine',
      },
    });
    const task = await prisma.warehouseAcceptanceTask.create({
      data: {
        mode: 'reserve',
        status: 'open',
        operationCode: `ПР-GUARD-${suffix}`,
        orderId: order.id,
        coverageDecisionId: decisionId,
      },
    });
    const row = await prisma.scanRow.create({
      data: {
        taskId: task.id,
        rollCode: `PALLET-GUARD-ROLL-${suffix}`,
        scanStatus: 'expected',
      },
    });
    return { decisionId, order, row, suffix, task };
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "scan_rows" ENABLE TRIGGER USER');
    await prisma.$executeRawUnsafe('ALTER TABLE "warehouse_acceptance_tasks" ENABLE TRIGGER USER');
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "warehouse_coverage_decisions" ENABLE TRIGGER USER',
    );
  }
}

async function hasCurrentPhysicalFacts(prisma: PrismaClient, decisionId: string) {
  const rows = await prisma.$queryRaw<Array<{ value: boolean }>>`
    SELECT "warehouse_coverage_decision_has_physical_facts"(${decisionId}::uuid) AS value
  `;
  return rows[0]?.value;
}

async function serializable<T>(
  prisma: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034' &&
        attempt < 2
      ) {
        continue;
      }
      throw error;
    }
  }
  throw new Error('Serializable pallet race did not converge');
}

describe('warehouse physical pallet migration (e2e, real PostgreSQL)', () => {
  jest.setTimeout(120_000);

  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('enforces one open pallet per task', async () => {
    const fixture = await createFixture(prisma, 'one-open');
    await createOpenPallet(prisma, fixture);

    await expect(createOpenPallet(prisma, fixture, 2)).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('rejects an item whose order differs from its pallet order', async () => {
    const fixture = await createFixture(prisma, 'order-fk');
    const pallet = await createOpenPallet(prisma, fixture);

    await expect(
      prisma.warehousePalletItem.create({
        data: {
          palletId: pallet.id,
          scanRowId: fixture.rows[0].id,
          orderId: fixture.orderB.id,
          rollCode: fixture.rows[0].rollCode,
          position: 1,
          acceptedAt: fixture.rows[0].lastScanAt!,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('allows one scan row to belong to exactly one pallet', async () => {
    const fixture = await createFixture(prisma, 'scan-unique');
    const first = await createOpenPallet(prisma, fixture);
    await prisma.warehousePalletItem.create({
      data: {
        palletId: first.id,
        scanRowId: fixture.rows[0].id,
        orderId: fixture.orderA.id,
        rollCode: fixture.rows[0].rollCode,
        position: 1,
        acceptedAt: fixture.rows[0].lastScanAt!,
      },
    });
    await prisma.warehousePallet.update({
      where: { id: first.id },
      data: {
        status: 'sealed',
        closeRequestId: randomUUID(),
        sealedAt: new Date(),
      },
    });
    const second = await createOpenPallet(prisma, fixture, 2);

    await expect(
      prisma.warehousePalletItem.create({
        data: {
          palletId: second.id,
          scanRowId: fixture.rows[0].id,
          orderId: fixture.orderA.id,
          rollCode: fixture.rows[0].rollCode,
          position: 1,
          acceptedAt: fixture.rows[0].lastScanAt!,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('serializes scan assignment with sealing so the raced roll belongs to one pallet', async () => {
    const fixture = await createFixture(prisma, 'scan-seal-race');
    const initial = await createOpenPallet(prisma, fixture);
    await prisma.warehousePalletItem.create({
      data: {
        palletId: initial.id,
        scanRowId: fixture.rows[0].id,
        orderId: fixture.orderA.id,
        rollCode: fixture.rows[0].rollCode,
        position: 1,
        acceptedAt: fixture.rows[0].lastScanAt!,
      },
    });
    const scanner = new PrismaClient();
    const sealer = new PrismaClient();

    try {
      await Promise.all([
        serializable(scanner, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${fixture.task.id} FOR UPDATE`;
          let pallet = await tx.warehousePallet.findFirst({
            where: { taskId: fixture.task.id, status: 'open' },
            orderBy: { sequenceNo: 'desc' },
          });
          if (!pallet) {
            const latest = await tx.warehousePallet.findFirst({
              where: { orderId: fixture.orderA.id },
              orderBy: { sequenceNo: 'desc' },
              select: { sequenceNo: true },
            });
            const sequenceNo = (latest?.sequenceNo ?? 0) + 1;
            pallet = await tx.warehousePallet.create({
              data: {
                palletCode: `PAL-${fixture.suffix}-${sequenceNo}`,
                taskId: fixture.task.id,
                orderId: fixture.orderA.id,
                sequenceNo,
              },
            });
          }
          const position = await tx.warehousePalletItem.count({
            where: { palletId: pallet.id },
          });
          await tx.warehousePalletItem.create({
            data: {
              palletId: pallet.id,
              scanRowId: fixture.rows[1].id,
              orderId: fixture.orderA.id,
              rollCode: fixture.rows[1].rollCode,
              position: position + 1,
              acceptedAt: fixture.rows[1].lastScanAt!,
            },
          });
        }),
        serializable(sealer, async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${fixture.task.id} FOR UPDATE`;
          const pallet = await tx.warehousePallet.findFirstOrThrow({
            where: { taskId: fixture.task.id, status: 'open' },
          });
          await tx.warehousePallet.update({
            where: { id: pallet.id },
            data: {
              status: 'sealed',
              closeRequestId: randomUUID(),
              sealedAt: new Date(),
            },
          });
        }),
      ]);

      const memberships = await prisma.warehousePalletItem.findMany({
        where: { scanRowId: fixture.rows[1].id },
        include: { pallet: { select: { status: true } } },
      });
      expect(memberships).toHaveLength(1);
      expect(['open', 'sealed']).toContain(memberships[0].pallet.status);
    } finally {
      await scanner.$disconnect();
      await sealer.$disconnect();
    }
  });

  it('counts only active non-voided pallet facts in the order-change guard', async () => {
    const fixture = await createPhysicalFactGuardFixture(prisma, 'current-facts');
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(false);

    const first = await prisma.warehousePallet.create({
      data: {
        palletCode: `PAL-GUARD-${fixture.suffix}-1`,
        taskId: fixture.task.id,
        orderId: fixture.order.id,
        sequenceNo: 1,
      },
    });
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(true);

    await prisma.warehousePallet.update({
      where: { id: first.id },
      data: {
        status: 'sealed',
        closeRequestId: randomUUID(),
        sealedAt: new Date(),
      },
    });
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(true);

    await prisma.warehousePallet.update({
      where: { id: first.id },
      data: {
        status: 'voided',
        voidedAt: new Date(),
        voidReason: 'other',
      },
    });
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(false);

    await prisma.warehousePalletItem.create({
      data: {
        palletId: first.id,
        scanRowId: fixture.row.id,
        orderId: fixture.order.id,
        rollCode: fixture.row.rollCode,
        position: 1,
        acceptedAt: new Date(),
        releasedAt: new Date(),
        releaseReason: 'voided_pallet',
      },
    });
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(false);

    const second = await prisma.warehousePallet.create({
      data: {
        palletCode: `PAL-GUARD-${fixture.suffix}-2`,
        taskId: fixture.task.id,
        orderId: fixture.order.id,
        sequenceNo: 2,
      },
    });
    await prisma.warehousePalletItem.create({
      data: {
        palletId: second.id,
        scanRowId: fixture.row.id,
        orderId: fixture.order.id,
        rollCode: fixture.row.rollCode,
        position: 1,
        acceptedAt: new Date(),
      },
    });
    expect(await hasCurrentPhysicalFacts(prisma, fixture.decisionId)).toBe(true);
  });
});
