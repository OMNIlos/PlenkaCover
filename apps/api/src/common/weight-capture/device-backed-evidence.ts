export type OperatorWeightEvidenceAction = 'roll_weight' | 'roll_reweigh' | 'defect';

type OperatorOperationFact = {
  id: string;
  action: string;
  status: string;
  deviceId: string | null;
  postId: string;
  postSessionId: string;
  resultRef: string | null;
};

type WarehouseOperationFact = {
  id: string;
  kind: string;
  status: string;
  taskId: string;
  rollCode: string;
  deviceId: string | null;
  postId: string | null;
  safeResult: unknown;
};

export type WeightEvidenceFact = {
  id: string;
  kind?: string;
  deviceId: string | null;
  deviceStatus: string;
  stable: boolean;
  grossKg: number | null;
  spoolKg: number | null;
  netKg: number | null;
  postId: string | null;
  postSessionId: string | null;
  operationId: string | null;
  operation: OperatorOperationFact | null;
  warehouseOperationId: string | null;
  warehouseOperation: WarehouseOperationFact | null;
};

export type WeightEvidenceProvenance =
  | {
      source: 'operator';
      allowedActions: readonly OperatorWeightEvidenceAction[];
      defectRecordId?: string;
    }
  | {
      source: 'warehouse';
      expectedRollCode: string;
    };

type VerifiedWeightEvidence = WeightEvidenceFact & {
  deviceId: string;
  grossKg: number;
  spoolKg: number;
  netKg: number;
};

function nonBlank(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

function sameWeight(left: unknown, right: number): boolean {
  return typeof left === 'number' && Number.isFinite(left) && Math.abs(left - right) <= 0.02;
}

function hasConsistentWeightValues(
  evidence: WeightEvidenceFact | null | undefined,
): evidence is VerifiedWeightEvidence {
  if (
    !evidence ||
    !nonBlank(evidence.deviceId) ||
    evidence.deviceStatus !== 'ready' ||
    !evidence.stable ||
    !Number.isFinite(evidence.grossKg) ||
    !Number.isFinite(evidence.spoolKg) ||
    !Number.isFinite(evidence.netKg)
  ) {
    return false;
  }
  const grossKg = evidence.grossKg as number;
  const spoolKg = evidence.spoolKg as number;
  const netKg = evidence.netKg as number;
  return (
    grossKg > 0 &&
    spoolKg >= 0 &&
    netKg > 0 &&
    grossKg > spoolKg &&
    Math.abs(grossKg - spoolKg - netKg) <= 0.02
  );
}

function hasSuccessfulOperatorProvenance(
  evidence: VerifiedWeightEvidence,
  provenance: Extract<WeightEvidenceProvenance, { source: 'operator' }>,
): boolean {
  const operation = evidence.operation;
  if (
    !operation ||
    !nonBlank(evidence.operationId) ||
    evidence.operationId !== operation.id ||
    evidence.warehouseOperationId !== null ||
    evidence.warehouseOperation !== null ||
    operation.status !== 'succeeded' ||
    !provenance.allowedActions.includes(operation.action as OperatorWeightEvidenceAction) ||
    operation.deviceId !== evidence.deviceId ||
    !nonBlank(evidence.postId) ||
    operation.postId !== evidence.postId ||
    !nonBlank(evidence.postSessionId) ||
    operation.postSessionId !== evidence.postSessionId
  ) {
    return false;
  }
  if (operation.action === 'defect') {
    return nonBlank(provenance.defectRecordId) && operation.resultRef === provenance.defectRecordId;
  }
  return operation.resultRef === evidence.id;
}

function hasSuccessfulWarehouseProvenance(
  evidence: VerifiedWeightEvidence,
  provenance: Extract<WeightEvidenceProvenance, { source: 'warehouse' }>,
): boolean {
  const operation = evidence.warehouseOperation;
  if (
    !operation ||
    !nonBlank(evidence.warehouseOperationId) ||
    evidence.warehouseOperationId !== operation.id ||
    evidence.operationId !== null ||
    evidence.operation !== null ||
    operation.kind !== 'control_weight' ||
    operation.status !== 'succeeded' ||
    operation.rollCode !== provenance.expectedRollCode ||
    operation.deviceId !== evidence.deviceId ||
    !nonBlank(evidence.postId) ||
    operation.postId !== evidence.postId ||
    !nonBlank(provenance.expectedRollCode) ||
    !operation.safeResult ||
    typeof operation.safeResult !== 'object' ||
    Array.isArray(operation.safeResult)
  ) {
    return false;
  }
  const safeResult = operation.safeResult as Record<string, unknown>;
  return (
    safeResult.operationId === operation.id &&
    safeResult.taskId === operation.taskId &&
    safeResult.rollCode === provenance.expectedRollCode &&
    sameWeight(safeResult.grossKg, evidence.grossKg) &&
    sameWeight(safeResult.spoolKg, evidence.spoolKg) &&
    sameWeight(safeResult.netKg, evidence.netKg)
  );
}

export function isDeviceBackedWeightEvidence(
  evidence: WeightEvidenceFact | null | undefined,
  provenance: WeightEvidenceProvenance,
): evidence is VerifiedWeightEvidence {
  if (!hasConsistentWeightValues(evidence)) return false;
  return provenance.source === 'operator'
    ? hasSuccessfulOperatorProvenance(evidence, provenance)
    : hasSuccessfulWarehouseProvenance(evidence, provenance);
}

export function isDeviceBackedSpoolEvidence(evidence: WeightEvidenceFact): boolean {
  return (
    evidence.kind === 'spool' &&
    evidence.stable &&
    evidence.deviceId !== null &&
    evidence.deviceStatus === 'ready' &&
    evidence.spoolKg !== null &&
    Number.isFinite(evidence.spoolKg) &&
    evidence.spoolKg > 0
  );
}
