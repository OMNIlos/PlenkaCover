import { Prisma } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';

type FailedPrint = {
  id: string;
  kind: 'roll' | 'defect' | 'bigbag' | 'pallet';
  objectId: string;
  gatewayCommandId: string;
  printerId: string;
  postId: string;
  dispatchId: string | null;
};

const PRINT_TABLES = {
  roll: 'label_print_jobs',
  defect: 'defect_bag_label_print_jobs',
  bigbag: 'big_bag_label_print_jobs',
  pallet: 'pallet_print_jobs',
} as const;

const FAILED_EVENTS = {
  roll: 'audit:operator_label_print_failed',
  defect: 'audit:defect_bag_label_print_failed',
  bigbag: 'audit:bigbag_label_print_failed',
  pallet: 'audit:pallet_list_print_failed',
} as const;

// A definitive reconciliation must also release the UUID retained by the browser after an
// uncertain response. Keep the original failure event; append the correction in the caller.
export async function settleReconciledRollPrintOperation(
  tx: Prisma.TransactionClient,
  printJobId: string,
  observed: boolean,
) {
  await tx.operatorRollOperation.updateMany({
    where: {
      action: 'qr_print',
      status: 'failed',
      errorCode: 'OPERATOR_PRINT_DELIVERY_UNKNOWN',
      labelPrintJob: { id: printJobId },
    },
    data: {
      status: observed ? 'succeeded' : 'failed',
      httpStatus: observed ? 200 : 409,
      errorCode: observed ? null : 'OPERATOR_PRINT_NOT_SENT',
      resultStep: observed ? 'qr_check' : null,
      resultRef: printJobId,
    },
  });
}

/** Repair only proven non-delivery. A timeout, missing correlation or successful spooler
 * submission is not proof about a physical label and retains the existing reconciliation gate.
 * The periodic caller also covers a late reply arriving before the job stores its command ID. */
export async function reconcileFailedGatewayPrints(prisma: PrismaService, audit: AuditService) {
  const jobs = await prisma.$queryRaw<FailedPrint[]>(Prisma.sql`
    WITH jobs AS (
      SELECT j.id, 'roll' AS kind, r."rollCode" AS "objectId", j."gatewayCommandId",
             j."printerId", j."postId", r.id AS "dispatchId",
             'roll_label' AS "labelKind", 'rollCode' AS "objectKey", r."rollCode" AS "objectCode"
      FROM label_print_jobs j
      JOIN operator_roll_lines l ON l.id = j."operatorRollLineId"
      JOIN roll_dispatch_items r ON r.id = l."rollDispatchItemId"
      WHERE j.status = 'delivery_unknown'
        AND l."labelState" = 'delivery_unknown' AND l."warehouseState" = 'not_ready'
        AND l.step IN ('qr_print', 'qr_check', 'handover')
        AND r."postId" = j."postId" AND r."assignedOperatorId" = j."actorId"
        AND r.status NOT IN ('cancelled', 'defect', 'ready_for_warehouse', 'done')
      UNION ALL
      SELECT j.id, 'defect', b.id, j."gatewayCommandId", j."printerId", j."postId", NULL,
             'big_bag_label', 'bigBagCode', b.code
      FROM defect_bag_label_print_jobs j JOIN defect_bags b ON b.id = j."defectBagId"
      WHERE j.status = 'delivery_unknown'
      UNION ALL
      SELECT j.id, 'bigbag', b.code, j."gatewayCommandId", j."printerId", NULL, NULL,
             'big_bag_label', 'bigBagCode', b.code
      FROM big_bag_label_print_jobs j JOIN big_bag_units b ON b.id = j."bigBagId"
      WHERE j.status = 'uncertain' AND j.channel = 'gateway'
      UNION ALL
      SELECT j.id, 'pallet', j."palletListDocumentId", j."gatewayCommandId", j."printerId", NULL, NULL,
             'pallet_label', 'documentId', j."palletListDocumentId"
      FROM pallet_print_jobs j WHERE j.status = 'delivery_unknown'
    )
    SELECT j.id, j.kind, j."objectId", j."gatewayCommandId", j."printerId",
           g."postId", j."dispatchId"
    FROM jobs j JOIN gateway_commands g ON g.id = j."gatewayCommandId"
    WHERE g.kind = 'print' AND g.status = 'failed'
      AND g.result @> '{"ok":false,"status":"failed"}'::jsonb
      AND (j."postId" IS NULL OR j."postId" = g."postId")
      AND g.payload->>'printerId' = j."printerId"
      AND g.payload->>'kind' = j."labelKind"
      AND g.payload->>j."objectKey" = j."objectCode"
    ORDER BY j.id LIMIT 32
  `);
  for (const job of jobs) {
    await prisma.$transaction(
      async (tx) => {
        // Same lock order as operator finalization/admin reconciliation: Post -> Roll -> Job -> Line.
        await tx.$queryRaw`SELECT id FROM posts WHERE id = ${job.postId} FOR UPDATE`;
        if (job.dispatchId) {
          await tx.$queryRaw`SELECT id FROM roll_dispatch_items WHERE id = ${job.dispatchId} FOR UPDATE`;
        }
        const rollJob =
          job.kind === 'roll'
            ? await tx.labelPrintJob.findUnique({
                where: { id: job.id },
                include: { line: { include: { rollDispatchItem: true } } },
              })
            : null;
        if (
          job.kind === 'roll' &&
          (!rollJob ||
            rollJob.line.labelState !== 'delivery_unknown' ||
            rollJob.line.warehouseState !== 'not_ready' ||
            !['qr_print', 'qr_check', 'handover'].includes(rollJob.line.step) ||
            rollJob.line.rollDispatchItem.postId !== job.postId ||
            rollJob.line.rollDispatchItem.assignedOperatorId !== rollJob.actorId ||
            ['cancelled', 'defect', 'ready_for_warehouse', 'done'].includes(
              rollJob.line.rollDispatchItem.status,
            ))
        )
          return;
        const priorStatus = job.kind === 'bigbag' ? 'uncertain' : 'delivery_unknown';
        const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE ${Prisma.raw(PRINT_TABLES[job.kind])}
        SET status = 'failed', "failureReason" = 'gateway_confirmed_not_printed',
            ${Prisma.raw(job.kind === 'bigbag' ? '"updatedAt"' : '"completedAt"')} = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE id = ${job.id} AND status = ${priorStatus}
          AND "gatewayCommandId" = ${job.gatewayCommandId} AND "printerId" = ${job.printerId}
      `);
        if (changed !== 1) return;
        let lineUpdated = false;
        if (rollJob) {
          const current = rollJob;
          const prior = await tx.labelPrintJob.findFirst({
            where: {
              operatorRollLineId: current.operatorRollLineId,
              status: { in: ['submitted', 'printed'] },
            },
            select: { id: true },
          });
          const updated = await tx.operatorRollLine.updateMany({
            where: {
              id: current.operatorRollLineId,
              labelState: 'delivery_unknown',
              step: { in: ['qr_print', 'qr_check', 'handover'] },
              warehouseState: 'not_ready',
              rollDispatchItem: {
                postId: job.postId,
                assignedOperatorId: current.actorId,
                status: { notIn: ['cancelled', 'defect', 'ready_for_warehouse', 'done'] },
              },
              labelJobs: {
                none: { status: { in: ['delivery_unknown', 'queued', 'reprint_requested'] } },
              },
            },
            data: { labelState: prior ? 'reprint_requested' : 'not_printed' },
          });
          lineUpdated = updated.count === 1;
          await settleReconciledRollPrintOperation(tx, job.id, false);
        }
        await audit.record(
          {
            type: FAILED_EVENTS[job.kind],
            actorRole: 'admin',
            objectId: job.objectId,
            oldValue: { printStatus: priorStatus },
            newValue: { printStatus: 'failed' },
            reason: 'Пост подтвердил, что этикетка не была отправлена в принтер.',
            detail: {
              printJobId: job.id,
              gatewayCommandId: job.gatewayCommandId,
              postId: job.postId,
              reasonCode: 'gateway_confirmed_not_printed',
              lineUpdated,
            },
          },
          tx,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
}
