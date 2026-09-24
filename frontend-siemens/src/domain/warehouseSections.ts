import type { WarehouseInventoryCategory } from './types';

export type WarehouseInventoryView = 'rolls' | 'processed';

type WarehouseSectionAlias = Readonly<{
  label: string;
  inventoryView?: WarehouseInventoryView | 'legacy-stock-bucket';
}>;

type WarehouseSectionDefinition = Readonly<{
  id:
    | 'receiving'
    | 'defect-receiving'
    | 'defect-shipping'
    | 'stock'
    | 'delivery'
    | 'raw'
    | 'consumables'
    | 'movements';
  label: string;
  categoryId: WarehouseInventoryCategory | null;
  aliases: readonly WarehouseSectionAlias[];
}>;

export const WAREHOUSE_STOCK_SECTION = 'Все рулоны';

export const WAREHOUSE_SECTIONS = [
  {
    id: 'receiving',
    label: 'Приемка',
    categoryId: null,
    aliases: [],
  },
  {
    id: 'defect-receiving',
    label: 'Прием брака',
    categoryId: null,
    aliases: [],
  },
  {
    id: 'defect-shipping',
    label: 'Отгрузка брака',
    categoryId: null,
    aliases: [],
  },
  {
    id: 'stock',
    label: WAREHOUSE_STOCK_SECTION,
    categoryId: 'rolls',
    aliases: [
      { label: 'Запасы и сырьё' },
      { label: 'Склад рулонов', inventoryView: 'rolls' },
      { label: 'Запасы / резерв', inventoryView: 'legacy-stock-bucket' },
    ],
  },
  {
    id: 'delivery',
    label: 'Выдача',
    categoryId: null,
    aliases: [{ label: 'Отгрузка' }],
  },
  {
    id: 'raw',
    label: 'Сырье',
    categoryId: 'raw',
    aliases: [{ label: 'Сырьё' }],
  },
  {
    id: 'consumables',
    label: 'Расходники',
    categoryId: 'consumables',
    aliases: [],
  },
  {
    id: 'movements',
    label: 'Движения',
    categoryId: 'movements',
    aliases: [],
  },
] as const satisfies readonly WarehouseSectionDefinition[];

export const WAREHOUSE_SECTION_REGISTRY = WAREHOUSE_SECTIONS;
export const WAREHOUSE_VISIBLE_SECTIONS = Object.freeze(
  WAREHOUSE_SECTIONS.filter(({ id }) => id !== 'consumables' && id !== 'movements').map(
    ({ label }) => label,
  ),
);

export type WarehouseSectionResolution = Readonly<{
  section: string;
  inventoryView: WarehouseInventoryView | null;
  categoryId: WarehouseInventoryCategory | null;
}>;

const STOCK_LEGACY_QUERY_KEYS = ['stockBucket', 'availability'] as const;
const STOCK_NOTIFICATION_QUERY_KEYS = [
  ...STOCK_LEGACY_QUERY_KEYS,
  'view',
  'q',
  'batch',
  'minAgeDays',
  'maxAgeDays',
  'status',
  'counterparty',
  'sort',
  'direction',
  'dir',
  'cursor',
  'limit',
  'page',
  'size',
  'table',
  'from',
  'to',
] as const;

function asSearchParams(searchParams?: URLSearchParams | null): URLSearchParams {
  return searchParams ?? new URLSearchParams();
}

function stockResolution(inventoryView: WarehouseInventoryView): WarehouseSectionResolution {
  return {
    section: WAREHOUSE_STOCK_SECTION,
    inventoryView,
    categoryId: inventoryView === 'processed' ? 'reserve' : 'rolls',
  };
}

export function resolveWarehouseSection(
  section: string,
  searchParams?: URLSearchParams | null,
): WarehouseSectionResolution {
  const params = asSearchParams(searchParams);
  const definition = WAREHOUSE_SECTIONS.find(
    ({ label, aliases }) =>
      label === section || aliases.some(({ label: alias }) => alias === section),
  );

  if (!definition) {
    return { section, inventoryView: null, categoryId: null };
  }

  if (definition.id !== 'stock') {
    return {
      section: definition.label,
      inventoryView: null,
      categoryId: definition.categoryId,
    };
  }

  const alias = definition.aliases.find(({ label }) => label === section);
  const aliasView = alias && 'inventoryView' in alias ? alias.inventoryView : undefined;
  if (aliasView === 'rolls') return stockResolution('rolls');
  if (aliasView === 'legacy-stock-bucket') {
    return stockResolution(params.get('stockBucket') === 'processed' ? 'processed' : 'rolls');
  }

  return stockResolution(params.get('view') === 'processed' ? 'processed' : 'rolls');
}

export function warehouseInventoryCategoryForSection(
  section: string,
  searchParams?: URLSearchParams | null,
): WarehouseInventoryCategory | null {
  return resolveWarehouseSection(section, searchParams).categoryId;
}

export const warehouseCategoryForSection = warehouseInventoryCategoryForSection;

export function warehouseSectionForCategory(category: WarehouseInventoryCategory): string {
  if (category === 'rolls' || category === 'reserve') return WAREHOUSE_STOCK_SECTION;
  return (
    WAREHOUSE_SECTIONS.find(({ categoryId }) => categoryId === category)?.label ??
    WAREHOUSE_STOCK_SECTION
  );
}

export function warehouseViewForCategory(
  category: WarehouseInventoryCategory,
): WarehouseInventoryView | null {
  if (category === 'rolls') return 'rolls';
  if (category === 'reserve') return 'processed';
  return null;
}

export function isWarehouseInventorySection(
  section: string,
  searchParams?: URLSearchParams | null,
): boolean {
  return warehouseInventoryCategoryForSection(section, searchParams) !== null;
}

export function isWarehouseStockSection(
  section: string,
  searchParams?: URLSearchParams | null,
): boolean {
  return resolveWarehouseSection(section, searchParams).section === WAREHOUSE_STOCK_SECTION;
}

function asUrl(href: string | URL): URL {
  return href instanceof URL ? new URL(href.toString()) : new URL(href);
}

export function normalizeWarehouseSectionUrl(
  href: string | URL,
  requestedSection?: string | null,
): URL {
  const url = asUrl(href);
  const sourceSection = requestedSection ?? url.searchParams.get('section');
  if (!sourceSection) return url;

  const resolution = resolveWarehouseSection(sourceSection, url.searchParams);
  url.searchParams.set('section', resolution.section);

  for (const key of STOCK_LEGACY_QUERY_KEYS) url.searchParams.delete(key);
  if (resolution.section === WAREHOUSE_STOCK_SECTION) {
    if (resolution.inventoryView === 'processed') url.searchParams.set('view', 'processed');
    else url.searchParams.delete('view');
  } else url.searchParams.delete('view');

  return url;
}

export const normalizeWarehouseNavigationUrl = normalizeWarehouseSectionUrl;

export function normalizeWarehouseNotificationUrl(href: string | URL): URL {
  const url = asUrl(href);
  const sourceSection = url.searchParams.get('section');
  if (!sourceSection || !isWarehouseStockSection(sourceSection, url.searchParams)) {
    return normalizeWarehouseSectionUrl(url);
  }

  url.searchParams.set('section', WAREHOUSE_STOCK_SECTION);
  for (const key of STOCK_NOTIFICATION_QUERY_KEYS) url.searchParams.delete(key);
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('f.')) url.searchParams.delete(key);
  }
  return url;
}
