import type { Role } from './roles';
import type {
  BigBagLocation,
  BigBagPrintStatus,
  BigBagRegistrationStatus,
  BigBagStatus,
} from './statuses';

export const BIG_BAG_MATERIAL_PRESETS = [
  { id: 'secondary', label: 'Вторичка' },
  { id: 'aika', label: 'Айка' },
  { id: 'primary_tape', label: 'Первичка ленты' },
  { id: 'pvd_tsp', label: 'ПВД ТСП' },
  { id: 'danaflex', label: 'Данафлекс' },
  { id: 'stretch', label: 'Стрейч' },
] as const;

export type BigBagMaterialPresetId = (typeof BIG_BAG_MATERIAL_PRESETS)[number]['id'];

export type BigBagMaterialSelectionKind = 'legacy' | 'material' | 'recipe' | 'preset';

export type BigBagCompositionItem = {
  rawMaterialDefinitionId: string | null;
  materialId: string;
  name: string;
  shareBasisPoints: number;
  initialKg: number;
};

export type WarehouseBigBagView = {
  id: string;
  code: string;
  material: string;
  materialId: string | null;
  materialSelectionKind: BigBagMaterialSelectionKind;
  materialPreset: BigBagMaterialPresetId | null;
  baseRawMaterialDefinitionId: string | null;
  recipeDefinitionVersionId: string | null;
  recipeName: string | null;
  recipeVersionNumber: number | null;
  supplierName: string | null;
  receivedAt: string | null;
  composition: BigBagCompositionItem[];
  status: BigBagStatus;
  registrationStatus: BigBagRegistrationStatus;
  location: BigBagLocation;
  locationRevision: number;
  initialKg: number | null;
  currentKg: number | null;
  lastMeasuredKg: number | null;
  lastActorRole: Role | null;
  lastMeasuredAt: string | null;
  machineId: string | null;
  lastWarehouseMeasuredKg: number | null;
  lastWarehouseMeasuredAt: string | null;
  priceKopecksPerKg: number | null;
  totalKopecks: number | null;
  priceSource: string | null;
  priceEffectiveAt: string | null;
  createdByRole: Role | null;
  createdAt: string;
  latestLabelPrint: BigBagLabelPrintView | null;
};

export type BigBagWeightComparison = {
  operatorReportedKg: number;
  warehouseMeasuredKg: number;
  differenceKg: number;
  differencePercent: number | null;
};

export type BigBagMovementResult = {
  bag: WarehouseBigBagView;
  movement: {
    kind: 'registration' | 'to_production' | 'to_warehouse';
    fromLocation: BigBagLocation | null;
    toLocation: BigBagLocation;
    locationRevision: number;
    createdAt: string;
  };
  weightComparison: BigBagWeightComparison | null;
};

export type BigBagLabelPrintView = {
  id: string;
  requestId: string;
  bigBagId: string;
  printerId: string | null;
  channel: 'gateway' | 'browser_system_print';
  status: BigBagPrintStatus;
  reason: string | null;
  replacesPrintJobId: string | null;
  gatewayCommandId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProductionBigBagClassification =
  | 'in_use'
  | 'idle_required'
  | 'idle_not_required'
  | 'idle_unclassified';

export type ProductionBigBagSummaryItem = {
  id: string;
  code: string;
  material: string;
  materialDefinitionId: string | null;
  status: BigBagStatus;
  currentKg: number | null;
  classification: ProductionBigBagClassification;
};

export type ProductionBigBagSummary = {
  counts: {
    total: number;
    inUse: number;
    idle: number;
    notRequired: number;
  };
  bags: ProductionBigBagSummaryItem[];
  returnCandidates: ProductionBigBagSummaryItem[];
  generatedAt: string;
};
