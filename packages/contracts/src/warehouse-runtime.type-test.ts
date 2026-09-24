import type { WarehouseIntakeRollView } from './warehouse-runtime';

type Assert<Condition extends true> = Condition;
type IsEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type IntakeRollExposesRequiredScanRowId = Assert<
  IsEqual<WarehouseIntakeRollView['scanRowId'], string>
>;

type IntakeRollExposesStableOrderLineIdentity = Assert<
  IsEqual<WarehouseIntakeRollView['orderLineId'], string | null>
>;

export type WarehouseRuntimeContractTypeAssertions =
  | IntakeRollExposesRequiredScanRowId
  | IntakeRollExposesStableOrderLineIdentity;
