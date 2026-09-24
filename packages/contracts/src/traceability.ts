export const TRACEABILITY_OBJECT_TYPES = [
  'order',
  'position',
  'roll',
  'big_bag',
  'pallet',
  'warehouse_task',
  'warehouse_operation',
] as const;
export type TraceabilityObjectType = (typeof TRACEABILITY_OBJECT_TYPES)[number];

export const TRACEABILITY_MATCH_KINDS = ['exact', 'prefix', 'contains'] as const;
export type TraceabilityMatchKind = (typeof TRACEABILITY_MATCH_KINDS)[number];

export type TraceabilitySearchItem = {
  objectType: TraceabilityObjectType;
  objectId: string;
  displayName: string;
  secondaryLabel: string | null;
  matchKind: TraceabilityMatchKind;
};

export type TraceabilitySearchPage = {
  items: TraceabilitySearchItem[];
  nextCursor: string | null;
};

export type TraceabilityStatus = {
  title: string;
  valueLabel: string;
};

export type TraceabilityLink = {
  objectType: TraceabilityObjectType;
  objectId: string;
  displayName: string;
  relationLabel: string;
};

export type TraceabilityTimelineItem = {
  eventId: string;
  actionLabel: string;
  reason: string | null;
  actor: {
    displayName: string;
    roleLabel: string;
  };
  occurredAt: string;
};

export type TraceabilityProblem = {
  id: string;
  title: string;
  statusLabel: string;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type TraceabilityDefect = {
  id: string;
  statusLabel: string;
  reason: string;
  weightKg: number | null;
  recordedAt: string;
};

export type TraceabilityProductionFact = {
  title: string;
  valueLabel: string;
  recordedAt: string;
  isCurrent: boolean | null;
};

export type TraceabilityWarehouseFact = TraceabilityProductionFact;

export type TraceabilityContext = {
  objectType: TraceabilityObjectType;
  objectId: string;
  displayName: string;
  statuses: TraceabilityStatus[];
  links: TraceabilityLink[];
  timeline: TraceabilityTimelineItem[];
  problems: TraceabilityProblem[];
  defects: TraceabilityDefect[];
  productionFacts: TraceabilityProductionFact[];
  warehouseFacts: TraceabilityWarehouseFact[];
};
