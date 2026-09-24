import type { PrismaService } from '../src/common/prisma/prisma.service';
import { assertSchemaDestructionTarget } from './e2e-database';

export interface OwnedOperatorFixtureGraph {
  actorIds?: readonly string[];
  bigBagIds?: readonly string[];
  commercialOrderIds?: readonly string[];
  counterpartyIds?: readonly string[];
  deviceIds?: readonly string[];
  dispatchItemIds?: readonly string[];
  postIds?: readonly string[];
  productionOrderIds?: readonly string[];
  shiftIds?: readonly string[];
}

const APPEND_ONLY_TABLES = [
  'domain_events',
  'operator_shift_close_commands',
  'shift_bag_usage_episodes',
] as const;

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function assertIsolatedE2eSchema(): void {
  const schema = process.env.PLENKA_E2E_SCHEMA;
  const databaseUrl = process.env.DATABASE_URL;
  if (!schema || !databaseUrl) {
    throw new Error('Operator fixture cleanup requires an isolated e2e database schema');
  }
  assertSchemaDestructionTarget(schema, databaseUrl);
}

/**
 * Removes only the graph explicitly owned by one operator e2e suite. Application assertions run
 * against the real append-only guards; this test-only teardown bypass is entered afterwards and
 * is protected by the same exact isolated-schema assertion as global schema destruction.
 */
export async function cleanupOwnedOperatorFixtureGraph(
  prisma: PrismaService,
  graph: OwnedOperatorFixtureGraph,
): Promise<void> {
  assertIsolatedE2eSchema();

  const actorIds = unique(graph.actorIds);
  const bigBagIds = unique(graph.bigBagIds);
  const commercialOrderIds = unique(graph.commercialOrderIds);
  const counterpartyIds = unique(graph.counterpartyIds);
  const deviceIds = unique(graph.deviceIds);
  const dispatchItemIds = unique(graph.dispatchItemIds);
  const postIds = unique(graph.postIds);
  const productionOrderIds = unique(graph.productionOrderIds);
  const shiftIds = unique(graph.shiftIds);
  const baseObjectIds = unique([
    ...bigBagIds,
    ...commercialOrderIds,
    ...counterpartyIds,
    ...deviceIds,
    ...dispatchItemIds,
    ...postIds,
    ...productionOrderIds,
    ...shiftIds,
  ]);

  await prisma.$transaction(
    async (tx) => {
      const usageIds = new Set<string>();
      const sessionIds = new Set<string>();
      const assignmentIds = new Set<string>();
      const lineIds = new Set<string>();

      if (bigBagIds.length > 0) {
        const usages = await tx.shiftBagUsage.findMany({
          where: { bigBagId: { in: bigBagIds } },
          select: { id: true },
        });
        usages.forEach(({ id }) => usageIds.add(id));
      }
      if (actorIds.length > 0) {
        const [usages, sessions, assignments] = await Promise.all([
          tx.shiftBagUsage.findMany({
            where: { session: { operatorId: { in: actorIds } } },
            select: { id: true },
          }),
          tx.operatorPostSession.findMany({
            where: { operatorId: { in: actorIds } },
            select: { id: true },
          }),
          tx.operatorShiftMachineAssignment.findMany({
            where: { operatorId: { in: actorIds } },
            select: { id: true },
          }),
        ]);
        usages.forEach(({ id }) => usageIds.add(id));
        sessions.forEach(({ id }) => sessionIds.add(id));
        assignments.forEach(({ id }) => assignmentIds.add(id));
      }
      if (shiftIds.length > 0 || postIds.length > 0) {
        const sessionFilters = [
          ...(shiftIds.length > 0 ? [{ shiftId: { in: shiftIds } }] : []),
          ...(postIds.length > 0 ? [{ postId: { in: postIds } }] : []),
        ];
        const assignmentFilters = [
          ...(shiftIds.length > 0 ? [{ shiftId: { in: shiftIds } }] : []),
          ...(postIds.length > 0 ? [{ postId: { in: postIds } }] : []),
        ];
        const [sessions, assignments] = await Promise.all([
          tx.operatorPostSession.findMany({
            where: { OR: sessionFilters },
            select: { id: true },
          }),
          tx.operatorShiftMachineAssignment.findMany({
            where: { OR: assignmentFilters },
            select: { id: true },
          }),
        ]);
        sessions.forEach(({ id }) => sessionIds.add(id));
        assignments.forEach(({ id }) => assignmentIds.add(id));
      }
      if (sessionIds.size > 0) {
        const usages = await tx.shiftBagUsage.findMany({
          where: { sessionId: { in: [...sessionIds] } },
          select: { id: true },
        });
        usages.forEach(({ id }) => usageIds.add(id));
      }
      const defectBagIds =
        sessionIds.size === 0
          ? []
          : (
              await tx.defectBag.findMany({
                where: { postSessionId: { in: [...sessionIds] } },
                select: { id: true },
              })
            ).map(({ id }) => id);
      const objectIds = unique([...baseObjectIds, ...defectBagIds]);
      if (dispatchItemIds.length > 0) {
        const lines = await tx.operatorRollLine.findMany({
          where: { rollDispatchItemId: { in: dispatchItemIds } },
          select: { id: true },
        });
        lines.forEach(({ id }) => lineIds.add(id));
      }

      for (const table of APPEND_ONLY_TABLES) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
      }

      if (actorIds.length > 0) {
        await tx.domainEvent.deleteMany({ where: { actorId: { in: actorIds } } });
      }
      if (objectIds.length > 0) {
        await tx.domainEvent.deleteMany({ where: { objectId: { in: objectIds } } });
      }
      if (actorIds.length > 0 || shiftIds.length > 0 || postIds.length > 0) {
        await tx.operatorShiftCloseCommand.deleteMany({
          where: {
            OR: [
              ...(actorIds.length > 0 ? [{ operatorId: { in: actorIds } }] : []),
              ...(shiftIds.length > 0 ? [{ shiftId: { in: shiftIds } }] : []),
              ...(postIds.length > 0 ? [{ postId: { in: postIds } }] : []),
            ],
          },
        });
      }

      const problemFilters = [
        ...(commercialOrderIds.length > 0 ? [{ orderId: { in: commercialOrderIds } }] : []),
        ...(postIds.length > 0 ? [{ postId: { in: postIds } }] : []),
      ];
      if (problemFilters.length > 0) {
        const problems = await tx.productionProblem.findMany({
          where: { OR: problemFilters },
          select: { id: true },
        });
        const problemIds = problems.map(({ id }) => id);
        if (problemIds.length > 0) {
          await tx.orderResolutionCase.deleteMany({ where: { problemId: { in: problemIds } } });
          await tx.productionProblem.deleteMany({ where: { id: { in: problemIds } } });
        }
      }

      if (lineIds.size > 0 || actorIds.length > 0) {
        await tx.operatorRollOperation.deleteMany({
          where: {
            OR: [
              ...(lineIds.size > 0 ? [{ operatorRollLineId: { in: [...lineIds] } }] : []),
              ...(actorIds.length > 0 ? [{ actorId: { in: actorIds } }] : []),
            ],
          },
        });
      }
      if (usageIds.size > 0) {
        await tx.shiftBagUsageEpisode.deleteMany({ where: { usageId: { in: [...usageIds] } } });
        await tx.shiftBagUsage.deleteMany({ where: { id: { in: [...usageIds] } } });
      }
      if (defectBagIds.length > 0) {
        await tx.defectBagMovement.deleteMany({ where: { defectBagId: { in: defectBagIds } } });
        await tx.defectBagLabelPrintJob.deleteMany({
          where: { defectBagId: { in: defectBagIds } },
        });
        await tx.defectBagScanToken.deleteMany({ where: { defectBagId: { in: defectBagIds } } });
        await tx.defectBag.deleteMany({ where: { id: { in: defectBagIds } } });
      }
      if (sessionIds.size > 0) {
        await tx.operatorPostSession.deleteMany({ where: { id: { in: [...sessionIds] } } });
      }
      if (assignmentIds.size > 0) {
        await tx.operatorShiftMachineAssignmentCancellationCommand.deleteMany({
          where: { assignmentId: { in: [...assignmentIds] } },
        });
        await tx.operatorMachineChange.deleteMany({
          where: { assignmentId: { in: [...assignmentIds] } },
        });
        await tx.operatorShiftMachineAssignment.deleteMany({
          where: { id: { in: [...assignmentIds] } },
        });
      }
      if (lineIds.size > 0) {
        await tx.operatorRollLine.deleteMany({ where: { id: { in: [...lineIds] } } });
      }
      if (dispatchItemIds.length > 0) {
        await tx.rollDispatchItem.deleteMany({ where: { id: { in: dispatchItemIds } } });
      }
      if (productionOrderIds.length > 0) {
        await tx.productionOrder.deleteMany({ where: { id: { in: productionOrderIds } } });
      }
      if (commercialOrderIds.length > 0) {
        await tx.commercialOrder.deleteMany({ where: { id: { in: commercialOrderIds } } });
      }
      if (counterpartyIds.length > 0) {
        await tx.counterparty.deleteMany({ where: { id: { in: counterpartyIds } } });
      }
      if (bigBagIds.length > 0) {
        await tx.bigBagUnit.deleteMany({ where: { id: { in: bigBagIds } } });
      }
      if (deviceIds.length > 0) {
        await tx.deviceRuntime.deleteMany({ where: { id: { in: deviceIds } } });
      }
      if (actorIds.length > 0) {
        await tx.session.deleteMany({ where: { userId: { in: actorIds } } });
      }
      if (shiftIds.length > 0) {
        await tx.shift.deleteMany({ where: { id: { in: shiftIds } } });
      }
      if (postIds.length > 0) {
        await tx.post.deleteMany({ where: { id: { in: postIds } } });
      }
      if (actorIds.length > 0) {
        await tx.user.deleteMany({ where: { id: { in: actorIds } } });
      }

      for (const table of [...APPEND_ONLY_TABLES].reverse()) {
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
      }
    },
    { timeout: 30_000 },
  );
}
