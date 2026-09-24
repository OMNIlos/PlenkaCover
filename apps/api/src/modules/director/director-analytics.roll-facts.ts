import type { DirectorRollProvenance } from '@plenka/contracts';
import { resolveCanonicalRollCaptures } from '../../common/weight-capture/canonical-roll-capture';
import { payrollBirkaFromSnapshot } from '../../common/payroll-tariffs/payroll-tariff-engine';
import {
  isDeviceBackedSpoolEvidence,
  type WeightEvidenceFact,
} from '../../common/weight-capture/device-backed-evidence';

export type DirectorRollFactSource = {
  id: string;
  operatorRollLineId: string;
  kind: string;
  stable: boolean;
  grossKg: number | null;
  spoolKg: number | null;
  netKg: number | null;
  deviceId: string | null;
  deviceStatus: string;
  actorId: string | null;
  postSessionId: string | null;
  supersedesCaptureId: string | null;
  createdAt: Date;
  postSession: {
    operator: { id: string; displayName: string };
  } | null;
  operation: {
    status: string;
    actor: { id: string; displayName: string };
  } | null;
  line: {
    id: string;
    planKg: number | null;
    defects?: Array<{ createdAt: Date }>;
    rollDispatchItem: {
      id: string;
      rollCode: string;
      characteristicsSnapshot?: unknown;
      productionOrder: {
        commercialOrder: { id: string; orderNumber: string };
      };
    };
  };
};

export type DirectorRollFact = {
  lineId: string;
  rollId: string;
  rollCode: string;
  orderId: string;
  orderNumber: string;
  plannedKg: number | null;
  actualKg: number;
  producedAt: Date;
  actualCapturedAt: Date;
  rootCaptureId: string;
  leafCaptureId: string;
  rootSessionId: string | null;
  operatorId: string | null;
  operatorName: string | null;
  provenance: DirectorRollProvenance;
  spoolTareKg: number | null;
  birka: string | null;
  defectAt: Date | null;
};

type DirectorRollProducer = {
  operatorId: string | null;
  operatorName: string | null;
  provenance: Exclude<DirectorRollProvenance, 'plan_missing'>;
};

function resolveRootCapture(
  leaf: DirectorRollFactSource,
  capturesById: ReadonlyMap<string, DirectorRollFactSource>,
): DirectorRollFactSource | null {
  let current = leaf;
  const visited = new Set<string>();

  while (true) {
    if (visited.has(current.id)) return null;
    visited.add(current.id);

    if (current.supersedesCaptureId === null) return current;

    const predecessor = capturesById.get(current.supersedesCaptureId);
    if (!predecessor || predecessor.operatorRollLineId !== leaf.operatorRollLineId) return null;
    current = predecessor;
  }
}

function resolveProducer(root: DirectorRollFactSource): DirectorRollProducer {
  if (root.postSession !== null) {
    return {
      operatorId: root.postSession.operator.id,
      operatorName: root.postSession.operator.displayName,
      provenance: 'post_session',
    };
  }

  if (root.operation?.status === 'succeeded') {
    return {
      operatorId: root.operation.actor.id,
      operatorName: root.operation.actor.displayName,
      provenance: 'operation_actor',
    };
  }

  return {
    operatorId: null,
    operatorName: null,
    provenance: 'actor_missing',
  };
}

function asSpoolEvidence(row: DirectorRollFactSource): WeightEvidenceFact {
  return {
    id: row.id,
    kind: row.kind,
    deviceId: row.deviceId,
    deviceStatus: row.deviceStatus,
    stable: row.stable,
    grossKg: row.grossKg,
    spoolKg: row.spoolKg,
    netKg: row.netKg,
    postId: null,
    postSessionId: row.postSessionId,
    operationId: null,
    operation: null,
    warehouseOperationId: null,
    warehouseOperation: null,
  };
}

function compareCapturedAt(left: DirectorRollFactSource, right: DirectorRollFactSource): number {
  const createdAtDifference = left.createdAt.getTime() - right.createdAt.getTime();
  return createdAtDifference === 0 ? left.id.localeCompare(right.id) : createdAtDifference;
}

function latestSpoolTare(rows: readonly DirectorRollFactSource[], producedAt: Date): number | null {
  let latest: DirectorRollFactSource | null = null;

  for (const row of rows) {
    if (row.createdAt.getTime() > producedAt.getTime()) continue;
    if (latest === null || compareCapturedAt(row, latest) > 0) latest = row;
  }

  return latest?.spoolKg ?? null;
}

export function buildDirectorRollFacts(
  rows: readonly DirectorRollFactSource[],
): DirectorRollFact[] {
  const leaves = resolveCanonicalRollCaptures(rows);
  const capturesById = new Map(rows.map((row) => [row.id, row]));
  const spoolEvidenceByLine = new Map<string, DirectorRollFactSource[]>();

  for (const row of rows) {
    if (!isDeviceBackedSpoolEvidence(asSpoolEvidence(row))) continue;
    const lineRows = spoolEvidenceByLine.get(row.operatorRollLineId) ?? [];
    lineRows.push(row);
    spoolEvidenceByLine.set(row.operatorRollLineId, lineRows);
  }

  const facts: DirectorRollFact[] = [];
  for (const leaf of leaves) {
    const root = resolveRootCapture(leaf, capturesById);
    if (root === null || leaf.netKg === null) continue;

    const producer = resolveProducer(root);
    const roll = root.line.rollDispatchItem;
    const order = roll.productionOrder.commercialOrder;
    facts.push({
      lineId: root.line.id,
      rollId: roll.id,
      rollCode: roll.rollCode,
      orderId: order.id,
      orderNumber: order.orderNumber,
      birka: payrollBirkaFromSnapshot(roll.characteristicsSnapshot),
      defectAt:
        root.line.defects?.reduce<Date | null>(
          (first, { createdAt }) => (first === null || createdAt < first ? createdAt : first),
          null,
        ) ?? null,
      plannedKg: root.line.planKg,
      actualKg: leaf.netKg,
      producedAt: root.createdAt,
      actualCapturedAt: leaf.createdAt,
      rootCaptureId: root.id,
      leafCaptureId: leaf.id,
      rootSessionId: root.postSessionId,
      operatorId: producer.operatorId,
      operatorName: producer.operatorName,
      provenance: root.line.planKg === null ? 'plan_missing' : producer.provenance,
      spoolTareKg: latestSpoolTare(
        spoolEvidenceByLine.get(root.operatorRollLineId) ?? [],
        leaf.createdAt,
      ),
    });
  }

  return facts.sort((left, right) => {
    const producedAtDifference = right.producedAt.getTime() - left.producedAt.getTime();
    return producedAtDifference === 0
      ? left.rollId.localeCompare(right.rollId)
      : producedAtDifference;
  });
}
