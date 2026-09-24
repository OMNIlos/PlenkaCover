export type WarehouseBusinessStatus = 'awaiting_shipment' | 'reserve' | 'processing';

export type WarehouseBusinessRowKind = 'client_order' | 'reserve';

export type WarehouseBusinessTemplate = {
  fingerprint: string;
  filmType: string;
  actualThicknessMicron: number;
  accountingThicknessMicron: number;
  widthMm: number;
  plannedLengthM: number;
  birka: string;
  spoolType: string;
  plannedWeightKg: number;
  recipeVersion: string | null;
};

export type WarehouseBusinessRow = {
  kind: WarehouseBusinessRowKind;
  id: string;
  templates: WarehouseBusinessTemplate[];
  status: WarehouseBusinessStatus;
  orderNumber: string | null;
  counterpartyName: string | null;
};

export type WarehouseBusinessPage = {
  items: WarehouseBusinessRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type WarehouseBusinessQuery = {
  page?: number;
  pageSize?: number;
};

export type BigBagRegisterLocationKind =
  | 'warehouse'
  | 'production'
  | 'post'
  | 'consumed'
  | 'unknown';

export type BigBagRegisterLocation = {
  kind: BigBagRegisterLocationKind;
  postCode: string | null;
  postName: string | null;
};

export type BigBagRegisterRow = {
  id: string;
  code: string;
  material: string;
  batch: string | null;
  createdAt: string;
  status: 'available' | 'in_use' | 'consumed';
  location: BigBagRegisterLocation;
  operatorName: string | null;
  currentWeightKg: number | null;
  totalKopecks: number | null;
};

export type BigBagRegisterPage = {
  items: BigBagRegisterRow[];
  page: number;
  pageSize: number;
  total: number;
};

export type BigBagRegisterQuery = {
  q?: string;
  view?: 'all' | 'current';
  page?: number;
  pageSize?: number;
};
