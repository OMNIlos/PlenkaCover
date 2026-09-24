import { ApiProperty } from '@nestjs/swagger';
import {
  COMMERCIAL_BUCKETS,
  COMMERCIAL_NEXT_ACTION_CODES,
  COMMERCIAL_STAGES,
  COMMERCIAL_COMPLETION_BLOCKERS,
  COMMERCIAL_COMPLETION_STATES,
  PAYMENT_STATUSES,
  PRODUCTION_INDICATORS,
  ROLES,
  SHIPMENT_STATUSES,
  WAREHOUSE_COVER_STATUSES,
  WAREHOUSE_COVER_ROUTES,
  WAREHOUSE_COVERAGE_ACTIONS,
  WAREHOUSE_COVERAGE_AVAILABILITIES,
  WAREHOUSE_COVERAGE_OWNERS,
  WAREHOUSE_COVERAGE_REASON_CODES,
  WAREHOUSE_COVERAGE_STATES,
  type CommercialNextActionCode,
} from '@plenka/contracts';

export class CommercialWorkspaceCounterpartyDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ nullable: true, type: String })
  legalName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  inn!: string | null;
}

export class StockProductionTemplateProvenanceDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  versionId!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;
}

export class CommercialOrderIndicatorsDto {
  @ApiProperty({ enum: PRODUCTION_INDICATORS })
  production!: string;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  warehouseCover!: string;

  @ApiProperty({ enum: PAYMENT_STATUSES })
  payment!: string;

  @ApiProperty({ enum: SHIPMENT_STATUSES })
  shipment!: string;
}

export class CommercialOrderCancellationDto {
  @ApiProperty({ enum: ['active', 'cancelled'] })
  status!: string;

  @ApiProperty({ minimum: 1 })
  version!: number;

  @ApiProperty({ nullable: true, type: String })
  cancelledAt!: string | null;

  @ApiProperty({ nullable: true, type: String })
  reason!: string | null;

  @ApiProperty({ minimum: 0 })
  completedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  remainingCancelledRollCount!: number;
}

export class CommercialCompletionDto {
  @ApiProperty({ enum: COMMERCIAL_COMPLETION_STATES })
  state!: string;

  @ApiProperty()
  requestedQty!: number;

  @ApiProperty()
  fulfilledQty!: number;

  @ApiProperty({ enum: COMMERCIAL_COMPLETION_BLOCKERS, isArray: true })
  blockingReasons!: string[];
}

export class CommercialNextActionDto {
  @ApiProperty({ enum: COMMERCIAL_NEXT_ACTION_CODES })
  code!: CommercialNextActionCode;

  @ApiProperty({ enum: ROLES })
  ownerRole!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty()
  allowed!: boolean;
}

export class CommercialOrderCommentResponseDto {
  @ApiProperty({ nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ minimum: 1 })
  commentVersion!: number;
}

export class WarehouseCoverageProjectionResponseDto {
  @ApiProperty({ enum: [2] })
  workflowVersion!: 2;

  @ApiProperty({ enum: WAREHOUSE_COVERAGE_STATES })
  state!: string;

  @ApiProperty({ minimum: 1 })
  stateVersion!: number;

  @ApiProperty({ nullable: true, type: Number, minimum: 0 })
  generation!: number | null;

  @ApiProperty({ nullable: true, enum: WAREHOUSE_COVERAGE_AVAILABILITIES })
  availability!: string | null;

  @ApiProperty({ enum: WAREHOUSE_COVERAGE_REASON_CODES, isArray: true })
  reasonCodes!: string[];

  @ApiProperty({ enum: WAREHOUSE_COVERAGE_OWNERS })
  nextOwner!: string;

  @ApiProperty({ enum: WAREHOUSE_COVERAGE_ACTIONS, isArray: true })
  availableActions!: string[];

  @ApiProperty({ minimum: 0 })
  requiredRollCount!: number;

  @ApiProperty({ minimum: 0 })
  matchedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  uncertainRollCount!: number;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  calculatedAt!: string | null;

  @ApiProperty()
  stale!: boolean;
}

export class WarehouseCoverageIngredientResponseDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ minimum: 1, maximum: 10_000 })
  shareBasisPoints!: number;
}

export class WarehouseCoverageTypeSpecificationResponseDto {
  @ApiProperty({ nullable: true, type: String })
  filmType!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  actualThicknessMicron!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  accountingThicknessMicron!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  widthMm!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedLengthM!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  weightKg!: number | null;

  @ApiProperty({ nullable: true, type: String })
  spoolType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  birka!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeName!: string | null;

  @ApiProperty({ type: [WarehouseCoverageIngredientResponseDto] })
  ingredients!: WarehouseCoverageIngredientResponseDto[];
}

export class WarehouseCoverageWeightRangeResponseDto {
  @ApiProperty()
  min!: number;

  @ApiProperty()
  max!: number;

  @ApiProperty()
  total!: number;
}

export class WarehouseCoverageMatchedTypeSpecificationResponseDto {
  @ApiProperty({ nullable: true, type: String })
  filmType!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  actualThicknessMicron!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  accountingThicknessMicron!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  widthMm!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedLengthM!: number | null;

  @ApiProperty({ nullable: true, type: WarehouseCoverageWeightRangeResponseDto })
  weightKg!: WarehouseCoverageWeightRangeResponseDto | null;

  @ApiProperty({ nullable: true, type: String })
  spoolType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  birka!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeName!: string | null;

  @ApiProperty({ type: [WarehouseCoverageIngredientResponseDto] })
  ingredients!: WarehouseCoverageIngredientResponseDto[];
}

export class WarehouseCoverageTypeComparisonResponseDto {
  @ApiProperty()
  filmType!: boolean;

  @ApiProperty()
  actualThickness!: boolean;

  @ApiProperty()
  accountingThickness!: boolean;

  @ApiProperty()
  width!: boolean;

  @ApiProperty()
  plannedLength!: boolean;

  @ApiProperty()
  weightTolerance!: boolean;

  @ApiProperty()
  spoolType!: boolean;

  @ApiProperty()
  birka!: boolean;

  @ApiProperty()
  ingredients!: boolean;
}

export class WarehouseCoverageTypeResponseDto {
  @ApiProperty()
  positionId!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ minimum: 0 })
  requiredRollCount!: number;

  @ApiProperty({ minimum: 0 })
  matchedRollCount!: number;

  @ApiProperty({ minimum: 0 })
  uncertainRollCount!: number;

  @ApiProperty({ type: WarehouseCoverageTypeSpecificationResponseDto })
  requested!: WarehouseCoverageTypeSpecificationResponseDto;

  @ApiProperty({ type: WarehouseCoverageMatchedTypeSpecificationResponseDto })
  matched!: WarehouseCoverageMatchedTypeSpecificationResponseDto;

  @ApiProperty({ type: WarehouseCoverageTypeComparisonResponseDto })
  comparison!: WarehouseCoverageTypeComparisonResponseDto;
}

export class CommercialWarehouseCoverageProjectionResponseDto extends WarehouseCoverageProjectionResponseDto {
  @ApiProperty({ type: [WarehouseCoverageTypeResponseDto] })
  typeCoverage!: WarehouseCoverageTypeResponseDto[];
}

export class CommercialOrderSummaryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty({ nullable: true, type: String })
  title!: string | null;

  @ApiProperty()
  version!: number;

  @ApiProperty({ nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ minimum: 1 })
  commentVersion!: number;

  @ApiProperty({ enum: COMMERCIAL_BUCKETS })
  bucket!: string;

  @ApiProperty()
  requestType!: string;

  @ApiProperty({ type: CommercialWorkspaceCounterpartyDto })
  counterparty!: CommercialWorkspaceCounterpartyDto;

  @ApiProperty({ nullable: true, type: StockProductionTemplateProvenanceDto })
  stockProductionTemplate!: StockProductionTemplateProvenanceDto | null;

  @ApiProperty()
  positionCount!: number;

  @ApiProperty()
  requestedQty!: number;

  @ApiProperty({ type: CommercialOrderIndicatorsDto })
  indicators!: CommercialOrderIndicatorsDto;

  @ApiProperty({ type: CommercialOrderCancellationDto })
  cancellation!: CommercialOrderCancellationDto;

  @ApiProperty({ type: CommercialCompletionDto })
  commercialCompletion!: CommercialCompletionDto;

  @ApiProperty({ type: CommercialNextActionDto })
  nextAction!: CommercialNextActionDto;

  @ApiProperty()
  actionPriority!: number;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  @ApiProperty({ required: false, enum: [2] })
  warehouseCoverageWorkflowVersion?: 2;

  @ApiProperty({ required: false, type: WarehouseCoverageProjectionResponseDto })
  warehouseCoverage?: WarehouseCoverageProjectionResponseDto;
}

export class CommercialOrderPageResponseDto {
  @ApiProperty({ type: [CommercialOrderSummaryDto] })
  items!: CommercialOrderSummaryDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}

export class WarehouseCoverRequestOrderResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderNumber!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  warehouseCoverStatus!: string;
}

export class WarehouseCoverRequestCaseResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty({ enum: ['open'] })
  state!: 'open';

  @ApiProperty({ enum: ['warehouse'] })
  ownerRole!: 'warehouse';

  @ApiProperty({ type: [String] })
  affectedPositionIds!: string[];

  @ApiProperty({ format: 'date-time' })
  requestedAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class WarehouseCoverRequestResponseDto {
  @ApiProperty({ type: WarehouseCoverRequestOrderResponseDto })
  order!: WarehouseCoverRequestOrderResponseDto;

  @ApiProperty({ type: WarehouseCoverRequestCaseResponseDto })
  case!: WarehouseCoverRequestCaseResponseDto;
}

export class CommercialRecipeIngredientDto {
  @ApiProperty()
  rawMaterialDefinitionId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  shareBasisPoints!: number;
}

export class CommercialRecipeSnapshotDto {
  @ApiProperty({ nullable: true, type: String })
  recipeDefinitionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeDefinitionVersionId!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  recipeVersionNumber!: number | null;

  @ApiProperty({ nullable: true, type: String })
  recipeName!: string | null;

  @ApiProperty({ nullable: true, type: [CommercialRecipeIngredientDto] })
  ingredients!: CommercialRecipeIngredientDto[] | null;
}

export class CommercialWorkspacePositionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty()
  rollCount!: number;

  @ApiProperty()
  filmType!: string;

  @ApiProperty()
  actualThickness!: string;

  @ApiProperty()
  accountingThickness!: string;

  @ApiProperty({ nullable: true, type: String })
  rawMaterialId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  baseRawMaterialDefinitionId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recipeDefinitionVersionId!: string | null;

  @ApiProperty({ nullable: true, type: CommercialRecipeSnapshotDto })
  recipe!: CommercialRecipeSnapshotDto | null;

  @ApiProperty({ nullable: true, type: String })
  spoolType!: string | null;

  @ApiProperty({ nullable: true, type: String })
  birka!: string | null;

  @ApiProperty({ nullable: true, type: String })
  comment!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  plannedWeightKg!: number | null;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  warehouseCoverStatus!: string;

  @ApiProperty()
  coveredQty!: number;

  @ApiProperty()
  productionQty!: number;

  @ApiProperty()
  fulfilledQty!: number;

  @ApiProperty({ enum: COMMERCIAL_COMPLETION_BLOCKERS, isArray: true })
  blockingReasons!: string[];

  @ApiProperty({ type: () => [WarehouseCoverProposalResponseDto] })
  coverProposals!: WarehouseCoverProposalResponseDto[];
}

export class WarehouseCoverCriterionResponseDto {
  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }] })
  expected!: string | number | null;

  @ApiProperty({ nullable: true, oneOf: [{ type: 'string' }, { type: 'number' }] })
  actual!: string | number | null;

  @ApiProperty()
  matches!: boolean;
}

export class WarehouseCoverMatchResponseDto {
  @ApiProperty()
  rollId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  compatible!: boolean;

  @ApiProperty({ type: Object })
  criteria!: Record<string, WarehouseCoverCriterionResponseDto>;
}

export class WarehouseCoverProposalResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  orderId!: string;

  @ApiProperty()
  positionId!: string;

  @ApiProperty()
  version!: number;

  @ApiProperty({ enum: WAREHOUSE_COVER_ROUTES })
  route!: string;

  @ApiProperty({ enum: WAREHOUSE_COVER_STATUSES })
  status!: string;

  @ApiProperty()
  coverQty!: number;

  @ApiProperty()
  reserveQty!: number;

  @ApiProperty()
  productionQty!: number;

  @ApiProperty()
  sourceCapturedAt!: string;

  @ApiProperty({ nullable: true, type: String })
  expiresAt!: string | null;

  @ApiProperty()
  stale!: boolean;

  @ApiProperty()
  commercialApproved!: boolean;

  @ApiProperty()
  technicalApproved!: boolean;

  @ApiProperty({ type: [WarehouseCoverMatchResponseDto] })
  matches!: WarehouseCoverMatchResponseDto[];
}

export class CommercialCorrectionCandidateRollDto {
  @ApiProperty()
  rollId!: string;

  @ApiProperty()
  rollCode!: string;

  @ApiProperty()
  positionSequence!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  eligible!: boolean;
}

export class CommercialProductionProblemResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  type!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: String })
  recovery!: string | null;

  @ApiProperty()
  positionId!: string;

  @ApiProperty()
  reportedRollId!: string;

  @ApiProperty()
  currentRollSequence!: number;

  @ApiProperty()
  completedRolls!: number;

  @ApiProperty()
  totalRolls!: number;

  @ApiProperty({ enum: ['commercial'] })
  ownerRole!: 'commercial';

  @ApiProperty({ type: Object })
  currentRecipe!: {
    snapshotId: string;
    version: string;
    parameters: Array<{ label: string; value: string }>;
  };

  @ApiProperty({ type: [CommercialCorrectionCandidateRollDto] })
  candidateRolls!: CommercialCorrectionCandidateRollDto[];

  @ApiProperty()
  createdAt!: string;
}

export class CommercialOrderDetailResponseDto extends CommercialOrderSummaryDto {
  @ApiProperty({ required: false, type: CommercialWarehouseCoverageProjectionResponseDto })
  declare warehouseCoverage?: CommercialWarehouseCoverageProjectionResponseDto;

  @ApiProperty({
    required: false,
    nullable: true,
    type: String,
    description: 'Только для коммерции, финансов и директора.',
  })
  commercialFinanceNote?: string | null;

  @ApiProperty({ enum: ROLES })
  creatorRole!: string;

  @ApiProperty({ enum: COMMERCIAL_STAGES })
  commercialStage!: string;

  @ApiProperty({ enum: ROLES })
  ownerRole!: string;

  @ApiProperty({ nullable: true, type: String })
  productionOrderId!: string | null;

  @ApiProperty({ nullable: true, type: Object })
  financeSummary!: { invoiceStatus: string; paymentStatus: string } | null;

  @ApiProperty({ type: Object })
  edit!: {
    parametersAllowed: boolean;
    parametersAmendable: boolean;
    parametersLockReason: 'invoice_issued' | null;
    promoteDraftAllowed: boolean;
    lockedAt: string | null;
  };

  @ApiProperty({ type: [CommercialWorkspacePositionDto] })
  positions!: CommercialWorkspacePositionDto[];

  @ApiProperty({ type: [CommercialProductionProblemResponseDto] })
  productionProblems!: CommercialProductionProblemResponseDto[];
}
