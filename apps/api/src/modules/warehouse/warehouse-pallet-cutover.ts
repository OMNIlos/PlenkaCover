import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export type WarehousePalletCutoverIssue = {
  taskId: string;
  code:
    | 'MISSING_ORDER'
    | 'MULTIPLE_UNPRINTED_ORDERS'
    | 'AMBIGUOUS_DOCUMENT_TASK'
    | 'ROLL_IN_MULTIPLE_PRINTED_DOCUMENTS';
  safeDetail: Record<string, string | number | string[]>;
};

export type WarehousePalletCutoverPlan = {
  tasksInspected: number;
  palletsToCreate: Array<{
    taskId: string;
    orderId: string;
    rollCodes: string[];
  }>;
  documentLinks: Array<{ documentId: string; taskId: string }>;
  issues: WarehousePalletCutoverIssue[];
};

export type WarehousePalletCutoverInput = {
  tasks: Array<{
    id: string;
    operationCode: string | null;
    rows: Array<{
      id: string;
      rollCode: string;
      orderId: string | null;
      lastScanAt: string | null;
      acceptedAt?: string;
      orderNumber?: string | null;
    }>;
  }>;
  documents: Array<{
    id: string;
    palletId: string;
    acceptanceTaskId: string | null;
    rollIds: string[];
    printStatuses: string[];
  }>;
};

const LOGICALLY_PRINTED_STATUSES = new Set(['submitted', 'delivery_unknown']);

export type WarehousePalletCutoverReport = WarehousePalletCutoverPlan & {
  mode: 'dry-run' | 'apply';
  applied: boolean;
  documentsLinked: number;
  palletsCreated: number;
  itemsCreated: number;
};

export class WarehousePalletCutoverBlockedError extends Error {
  constructor(readonly report: WarehousePalletCutoverReport) {
    super('Warehouse pallet cutover is blocked by ambiguous legacy data');
    this.name = 'WarehousePalletCutoverBlockedError';
  }
}

export function parseWarehousePalletCutoverMode(argv: string[]): 'dry-run' | 'apply' {
  const dryRun = argv.length === 1 && argv[0] === '--dry-run';
  const apply = argv.length === 1 && argv[0] === '--apply';
  if (!dryRun && !apply) {
    throw new Error('Use exactly one of --dry-run or --apply');
  }
  return apply ? 'apply' : 'dry-run';
}

type CutoverClient = Prisma.TransactionClient | PrismaService;

@Injectable()
export class WarehousePalletCutoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async dryRun(): Promise<WarehousePalletCutoverReport> {
    const plan = await this.inspect(this.prisma);
    return this.report('dry-run', false, plan, 0, 0, 0);
  }

  async apply(): Promise<WarehousePalletCutoverReport> {
    const preflight = await this.inspect(this.prisma);
    if (preflight.issues.length > 0) {
      throw new WarehousePalletCutoverBlockedError(this.report('apply', false, preflight, 0, 0, 0));
    }

    return this.prisma.$transaction(
      async (tx) => {
        const taskIds = await tx.warehouseAcceptanceTask.findMany({
          where: { mode: 'receiving', status: { not: 'closed' } },
          orderBy: { id: 'asc' },
          select: { id: true },
        });
        for (const task of taskIds) {
          await tx.$queryRaw`SELECT "id" FROM "warehouse_acceptance_tasks" WHERE "id" = ${task.id} FOR UPDATE`;
        }

        const input = await this.loadInput(tx);
        const lockedPlan = planWarehousePalletCutover(input);
        if (lockedPlan.issues.length > 0) {
          throw new WarehousePalletCutoverBlockedError(
            this.report('apply', false, lockedPlan, 0, 0, 0),
          );
        }
        if (JSON.stringify(lockedPlan) !== JSON.stringify(preflight)) {
          throw new Error('Warehouse pallet cutover facts changed after preflight; run it again');
        }

        let documentsLinked = 0;
        for (const link of lockedPlan.documentLinks) {
          const updated = await tx.palletListDocument.updateMany({
            where: {
              id: link.documentId,
              origin: 'legacy',
              acceptanceTaskId: null,
            },
            data: { acceptanceTaskId: link.taskId },
          });
          if (updated.count !== 1) {
            throw new Error('Warehouse pallet cutover document link changed concurrently');
          }
          documentsLinked += 1;
        }

        let palletsCreated = 0;
        let itemsCreated = 0;
        for (const plannedPallet of lockedPlan.palletsToCreate) {
          const existingOpen = await tx.warehousePallet.findFirst({
            where: { taskId: plannedPallet.taskId, status: 'open' },
            select: { id: true },
          });
          if (existingOpen) {
            throw new Error('Warehouse pallet cutover found a concurrent open pallet');
          }

          const latest = await tx.warehousePallet.findFirst({
            where: { orderId: plannedPallet.orderId },
            orderBy: { sequenceNo: 'desc' },
            select: { sequenceNo: true },
          });
          const sequenceNo = (latest?.sequenceNo ?? 0) + 1;
          const task = input.tasks.find((candidate) => candidate.id === plannedPallet.taskId);
          if (!task) throw new Error('Warehouse pallet cutover task disappeared');
          const rowsByRollCode = new Map(task.rows.map((row) => [row.rollCode, row] as const));
          if (rowsByRollCode.size !== task.rows.length) {
            throw new Error('Warehouse pallet cutover found duplicate accepted roll codes');
          }
          const orderNumber =
            task.rows.find((row) => row.orderId === plannedPallet.orderId)?.orderNumber ??
            plannedPallet.orderId;
          const pallet = await tx.warehousePallet.create({
            data: {
              palletCode: cutoverPalletCode(orderNumber, plannedPallet.orderId, sequenceNo),
              taskId: plannedPallet.taskId,
              orderId: plannedPallet.orderId,
              sequenceNo,
              status: 'open',
            },
            select: { id: true, palletCode: true },
          });
          const itemData = plannedPallet.rollCodes.map((rollCode, index) => {
            const row = rowsByRollCode.get(rollCode);
            if (!row) throw new Error('Warehouse pallet cutover accepted row disappeared');
            return {
              palletId: pallet.id,
              scanRowId: row.id,
              orderId: plannedPallet.orderId,
              rollCode,
              position: index + 1,
              acceptedAt: new Date(row.acceptedAt ?? row.lastScanAt ?? 0),
            };
          });
          const createdItems = await tx.warehousePalletItem.createMany({ data: itemData });
          if (createdItems.count !== itemData.length) {
            throw new Error('Warehouse pallet cutover did not persist every planned item');
          }
          palletsCreated += 1;
          itemsCreated += createdItems.count;
        }

        if (documentsLinked + palletsCreated + itemsCreated > 0) {
          await this.audit.record(
            {
              type: 'audit:warehouse_pallet_cutover_applied',
              actor: {
                kind: 'system',
                systemActorKey: 'warehouse-pallet-cutover',
              },
              detail: {
                tasksInspected: lockedPlan.tasksInspected,
                documentsLinked,
                palletsCreated,
                itemsCreated,
              },
            },
            tx,
          );
        }

        return this.report(
          'apply',
          true,
          lockedPlan,
          documentsLinked,
          palletsCreated,
          itemsCreated,
        );
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  private inspect(client: CutoverClient): Promise<WarehousePalletCutoverPlan> {
    return this.loadInput(client).then(planWarehousePalletCutover);
  }

  private async loadInput(client: CutoverClient): Promise<WarehousePalletCutoverInput> {
    const tasks = await client.warehouseAcceptanceTask.findMany({
      where: { mode: 'receiving', status: { not: 'closed' } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        operationCode: true,
        updatedAt: true,
        rows: {
          where: {
            scanStatus: 'accepted',
            palletItems: { none: {} },
          },
          orderBy: [{ lastScanAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            rollCode: true,
            lastScanAt: true,
          },
        },
      },
    });
    const rollCodes = [
      ...new Set(tasks.flatMap((task) => task.rows.map((row) => row.rollCode))),
    ].sort();
    const lines =
      rollCodes.length === 0
        ? []
        : await client.operatorRollLine.findMany({
            where: { rollDispatchItem: { rollCode: { in: rollCodes } } },
            select: {
              rollDispatchItem: {
                select: {
                  rollCode: true,
                  productionOrder: {
                    select: {
                      commercialOrder: {
                        select: { id: true, orderNumber: true },
                      },
                    },
                  },
                },
              },
            },
          });
    const orderCandidatesByRollCode = new Map<
      string,
      Map<string, { id: string; orderNumber: string }>
    >();
    for (const line of lines) {
      const rollCode = line.rollDispatchItem.rollCode;
      const order = line.rollDispatchItem.productionOrder.commercialOrder;
      const candidates = orderCandidatesByRollCode.get(rollCode) ?? new Map();
      candidates.set(order.id, order);
      orderCandidatesByRollCode.set(rollCode, candidates);
    }

    const legacyIdentifiers = [
      ...new Set(
        tasks.flatMap((task) => (task.operationCode ? [task.id, task.operationCode] : [task.id])),
      ),
    ];
    const taskIds = tasks.map((task) => task.id);
    const documents =
      taskIds.length === 0
        ? []
        : await client.palletListDocument.findMany({
            where: {
              origin: 'legacy',
              OR: [
                { acceptanceTaskId: { in: taskIds } },
                {
                  acceptanceTaskId: null,
                  palletId: { in: legacyIdentifiers },
                },
              ],
            },
            orderBy: { id: 'asc' },
            select: {
              id: true,
              palletId: true,
              acceptanceTaskId: true,
              rollIds: true,
              printJobs: {
                select: { status: true },
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              },
            },
          });

    return {
      tasks: tasks.map((task) => ({
        id: task.id,
        operationCode: task.operationCode,
        rows: task.rows.map((row) => {
          const orderCandidates = orderCandidatesByRollCode.get(row.rollCode);
          const order = orderCandidates?.size === 1 ? [...orderCandidates.values()][0] : null;
          const acceptedAt = row.lastScanAt ?? task.updatedAt;
          return {
            id: row.id,
            rollCode: row.rollCode,
            orderId: order?.id ?? null,
            orderNumber: order?.orderNumber ?? null,
            lastScanAt: row.lastScanAt?.toISOString() ?? null,
            acceptedAt: acceptedAt.toISOString(),
          };
        }),
      })),
      documents: documents.map((document) => ({
        id: document.id,
        palletId: document.palletId,
        acceptanceTaskId: document.acceptanceTaskId,
        rollIds: jsonStrings(document.rollIds),
        printStatuses: document.printJobs.map((job) => job.status),
      })),
    };
  }

  private report(
    mode: WarehousePalletCutoverReport['mode'],
    applied: boolean,
    plan: WarehousePalletCutoverPlan,
    documentsLinked: number,
    palletsCreated: number,
    itemsCreated: number,
  ): WarehousePalletCutoverReport {
    return {
      mode,
      applied,
      ...plan,
      documentsLinked,
      palletsCreated,
      itemsCreated,
    };
  }
}

export function planWarehousePalletCutover(
  input: WarehousePalletCutoverInput,
): WarehousePalletCutoverPlan {
  const tasks = input.tasks.slice().sort((left, right) => left.id.localeCompare(right.id));
  const taskIds = new Set(tasks.map((task) => task.id));
  const taskIdsByLegacyPalletId = new Map<string, Set<string>>();
  for (const task of tasks) {
    addCandidate(taskIdsByLegacyPalletId, task.id, task.id);
    if (task.operationCode) {
      addCandidate(taskIdsByLegacyPalletId, task.operationCode, task.id);
    }
  }

  const documentLinks: WarehousePalletCutoverPlan['documentLinks'] = [];
  const issues: WarehousePalletCutoverIssue[] = [];
  const documentsByTaskId = new Map<string, WarehousePalletCutoverInput['documents']>();

  for (const document of input.documents
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))) {
    const candidateTaskIds = resolveDocumentTaskIds(document, taskIds, taskIdsByLegacyPalletId);
    if (candidateTaskIds.length !== 1) {
      if (document.acceptanceTaskId || candidateTaskIds.length > 1) {
        issues.push({
          taskId: document.acceptanceTaskId ?? candidateTaskIds[0] ?? 'unresolved',
          code: 'AMBIGUOUS_DOCUMENT_TASK',
          safeDetail: {
            candidateTaskIds,
            documentId: document.id,
          },
        });
      }
      continue;
    }

    const taskId = candidateTaskIds[0];
    if (!document.acceptanceTaskId) {
      documentLinks.push({ documentId: document.id, taskId });
    }
    const documents = documentsByTaskId.get(taskId) ?? [];
    documents.push(document);
    documentsByTaskId.set(taskId, documents);
  }

  const palletsToCreate: WarehousePalletCutoverPlan['palletsToCreate'] = [];
  for (const task of tasks) {
    const printedDocumentIdsByRoll = new Map<string, string[]>();
    for (const document of documentsByTaskId.get(task.id) ?? []) {
      if (!document.printStatuses.some((status) => LOGICALLY_PRINTED_STATUSES.has(status))) {
        continue;
      }
      for (const rollCode of [...new Set(document.rollIds)].sort()) {
        const documentIds = printedDocumentIdsByRoll.get(rollCode) ?? [];
        documentIds.push(document.id);
        printedDocumentIdsByRoll.set(rollCode, documentIds);
      }
    }

    for (const [rollCode, documentIds] of [...printedDocumentIdsByRoll.entries()].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (documentIds.length < 2) continue;
      issues.push({
        taskId: task.id,
        code: 'ROLL_IN_MULTIPLE_PRINTED_DOCUMENTS',
        safeDetail: {
          documentIds: documentIds.slice().sort(),
          rollCode,
        },
      });
    }

    const unprintedRows = task.rows
      .filter((row) => !printedDocumentIdsByRoll.has(row.rollCode))
      .sort(compareRows);
    if (unprintedRows.length === 0) continue;

    const missingOrderRollCodes = unprintedRows
      .filter((row) => !row.orderId)
      .map((row) => row.rollCode)
      .sort();
    if (missingOrderRollCodes.length > 0) {
      issues.push({
        taskId: task.id,
        code: 'MISSING_ORDER',
        safeDetail: { rollCodes: missingOrderRollCodes },
      });
      continue;
    }

    const orderIds = [
      ...new Set(
        unprintedRows.map((row) => row.orderId).filter((value): value is string => !!value),
      ),
    ].sort();
    if (orderIds.length > 1) {
      issues.push({
        taskId: task.id,
        code: 'MULTIPLE_UNPRINTED_ORDERS',
        safeDetail: {
          orderIds,
          rollCodes: unprintedRows.map((row) => row.rollCode).sort(),
        },
      });
      continue;
    }

    palletsToCreate.push({
      taskId: task.id,
      orderId: orderIds[0],
      rollCodes: unprintedRows.map((row) => row.rollCode),
    });
  }

  return {
    tasksInspected: tasks.length,
    palletsToCreate: palletsToCreate.sort((left, right) => left.taskId.localeCompare(right.taskId)),
    documentLinks: documentLinks.sort(
      (left, right) =>
        left.taskId.localeCompare(right.taskId) || left.documentId.localeCompare(right.documentId),
    ),
    issues: issues.sort(
      (left, right) =>
        left.taskId.localeCompare(right.taskId) ||
        left.code.localeCompare(right.code) ||
        JSON.stringify(left.safeDetail).localeCompare(JSON.stringify(right.safeDetail)),
    ),
  };
}

function addCandidate(
  candidatesByPalletId: Map<string, Set<string>>,
  palletId: string,
  taskId: string,
): void {
  const candidates = candidatesByPalletId.get(palletId) ?? new Set<string>();
  candidates.add(taskId);
  candidatesByPalletId.set(palletId, candidates);
}

function resolveDocumentTaskIds(
  document: WarehousePalletCutoverInput['documents'][number],
  taskIds: Set<string>,
  candidatesByPalletId: Map<string, Set<string>>,
): string[] {
  if (document.acceptanceTaskId) {
    return taskIds.has(document.acceptanceTaskId) ? [document.acceptanceTaskId] : [];
  }
  return [...(candidatesByPalletId.get(document.palletId) ?? [])].sort();
}

function compareRows(
  left: WarehousePalletCutoverInput['tasks'][number]['rows'][number],
  right: WarehousePalletCutoverInput['tasks'][number]['rows'][number],
): number {
  const byScanTime = (left.lastScanAt ?? '').localeCompare(right.lastScanAt ?? '');
  return byScanTime || left.id.localeCompare(right.id);
}

function jsonStrings(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function cutoverPalletCode(orderNumber: string, orderId: string, sequenceNo: number): string {
  const normalized =
    orderNumber
      .normalize('NFKC')
      .trim()
      .toUpperCase()
      .replace(/[^A-ZА-ЯЁ0-9]+/giu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) ||
    orderId
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '')
      .slice(0, 16);
  return `PAL-${normalized}-${String(sequenceNo).padStart(2, '0')}`;
}
