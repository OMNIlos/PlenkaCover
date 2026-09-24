import type {
  CommercialCompletion,
  CommercialCompletionBlocker,
  ShipmentStatus,
  WarehouseCoverageAvailability,
  WarehouseCoverageDecisionKind,
  WarehouseCoverageState,
  WarehouseCoverageWorkflowVersion,
} from '@plenka/contracts';

export type FulfillmentCoverProposal = {
  id: string;
  status: string;
  coverQty: number;
  reserveQty: number;
  commercialApprovedAt: Date | null;
  technicalApprovedAt: Date | null;
  reservedRolls: Array<{
    id: string;
    rollCode: string;
    reservedForOrderId: string | null;
    reservedForPositionId: string | null;
    reservedByProposalId: string | null;
  }>;
};

export type FulfillmentDispatchItem = {
  rollCode: string;
  orderLineId: string | null;
  status: string;
  operatorLine: null | { warehouseState: string };
};

export type FulfillmentV1Order = {
  id: string;
  orderNumber: string;
  positions: Array<{
    id: string;
    rollCount: number;
    warehouseCoverStatus: string;
    coverProposals: FulfillmentCoverProposal[];
  }>;
  problems: Array<{ positionId: string | null; status: string }>;
  resolutionCases: Array<{ status: string }>;
  productionOrder: null | { dispatchItems: FulfillmentDispatchItem[] };
};

export type FulfillmentCoverageMatch = {
  orderId: string;
  generation: number;
  positionId: string;
  rollId: string;
  coverageFactId: string;
  slotIndex: number;
  roll: {
    id: string;
    rollCode: string;
    warehouseStatus: string;
    currentCoverageFactId: string | null;
    reservedForOrderId: string | null;
    reservedForPositionId: string | null;
    reservedByProposalId: string | null;
    reservedByCoverageDecisionId: string | null;
    reservedAt: Date | null;
  };
};

export type WarehouseCoverageCalculationInput = {
  id: string;
  orderId: string;
  generation: number;
  inputFingerprint: string;
  availability: WarehouseCoverageAvailability;
  requiredRollCount: number;
  matchedRollCount: number;
  matches: FulfillmentCoverageMatch[];
};

export type WarehouseCoverageDecisionInput = {
  id: string;
  orderId: string;
  calculationId: string;
  generation: number;
  kind: WarehouseCoverageDecisionKind;
  inputFingerprint: string;
  expectedRollCount: number;
};

export type FulfillmentCoverageState = {
  state: WarehouseCoverageState;
  stateVersion: number;
  generation: number;
  currentCalculationId: string | null;
  currentDecisionId: string | null;
  currentCalculation: WarehouseCoverageCalculationInput | null;
  currentDecision: WarehouseCoverageDecisionInput | null;
};

export type FulfillmentProductionOrder = {
  commercialOrderId: string;
  sourceCoverageCalculationId: string | null;
  sourceCoverageDecisionId: string | null;
  sourceCoverageInputFingerprint: string | null;
  sourceCoverageGeneration: number | null;
  dispatchItems: FulfillmentDispatchItem[];
};

export type FulfillmentV2Order = {
  id: string;
  orderNumber: string;
  positions: Array<{ id: string; rollCount: number }>;
  coverageState: FulfillmentCoverageState | null;
  productionOrder: FulfillmentProductionOrder | null;
  problems: Array<{ positionId: string | null; status: string }>;
  resolutionCases: Array<{ status: string }>;
};

export type FulfillmentOrder =
  | ({
      warehouseCoverageWorkflowVersion: Extract<WarehouseCoverageWorkflowVersion, 1>;
    } & FulfillmentV1Order)
  | ({
      warehouseCoverageWorkflowVersion: Extract<WarehouseCoverageWorkflowVersion, 2>;
    } & FulfillmentV2Order);

export type FulfillmentTask = {
  id: string;
  orderId: string | null;
  positionId: string | null;
  proposalId: string | null;
  coverageDecisionId?: string | null;
  mode: string;
  status: string;
  rows: Array<{ rollCode: string; fromOrderId?: string | null; scanStatus: string }>;
};

export type FulfillmentPositionResult = {
  positionId: string;
  coveredQty: number;
  productionQty: number;
  fulfilledQty: number;
  fulfilledRollCodes: string[];
  blockingReasons: CommercialCompletionBlocker[];
};

export type OrderFulfillmentResult = {
  completion: CommercialCompletion;
  positions: FulfillmentPositionResult[];
  fulfilledRollCodes: string[];
  shipment: ShipmentStatus;
};
