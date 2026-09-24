import type { CommercialWorkspaceOrderDetail, CommercialWorkspaceOrderSummary } from './commercial';
import type {
  CommercialWarehouseCoverageProjection,
  WarehouseCoverageProjection,
  WarehouseCoverageTypeProjection,
} from './warehouse-coverage';

type Assert<T extends true> = T;
type IsEqual<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2 ? true : false;
type IsNever<Value> = [Value] extends [never] ? true : false;

type DetailCoverage = NonNullable<CommercialWorkspaceOrderDetail['warehouseCoverage']>;
type SummaryCoverage = NonNullable<CommercialWorkspaceOrderSummary['warehouseCoverage']>;
type PublicTypeCoverageKeys =
  | keyof WarehouseCoverageTypeProjection
  | keyof WarehouseCoverageTypeProjection['requested']
  | keyof WarehouseCoverageTypeProjection['matched'];

type CommercialDetailAcceptsGroupedCoverage = Assert<
  IsEqual<DetailCoverage, CommercialWarehouseCoverageProjection>
>;
type CommercialListSummaryRemainsBaseCoverage = Assert<
  IsEqual<SummaryCoverage, WarehouseCoverageProjection>
>;
type GroupedCoverageExposesNoPhysicalRollIdentifiers = Assert<
  IsNever<Extract<PublicTypeCoverageKeys, 'rollId' | 'rollCode'>>
>;

export type WarehouseCoverageContractTypeAssertions =
  | CommercialDetailAcceptsGroupedCoverage
  | CommercialListSummaryRemainsBaseCoverage
  | GroupedCoverageExposesNoPhysicalRollIdentifiers;
