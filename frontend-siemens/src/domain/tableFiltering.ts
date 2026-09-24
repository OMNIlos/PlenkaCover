export type TableSortDirection = 'none' | 'asc' | 'desc';

export type TableFilterStateV1 = {
  view: string;
  query: string;
  filters: Record<string, string[]>;
  period?: { from: string; to: string };
  sort: { column: string; direction: TableSortDirection };
  page: number;
  pageSize: number;
};

export type TableFilterOption = {
  id: string;
  label: string;
};

export type TableFilterDefinition<T> = {
  id: string;
  label: string;
  mode: 'single' | 'multi';
  options: TableFilterOption[];
  values: (row: T) => string[];
};

export type TableSystemView<T> = {
  id: string;
  label: string;
  matches: (row: T) => boolean;
};

export type TableFacetOption = TableFilterOption & {
  count: number;
  active: boolean;
};

export type TableActiveFilter = {
  categoryId: string;
  categoryLabel: string;
  valueId: string;
  label: string;
  count: number;
};

export type TableProjection<T> = {
  baseRows: T[];
  viewRows: T[];
  searchedRows: T[];
  filteredRows: T[];
  sortedRows: T[];
  pageRows: T[];
  activeFilters: TableActiveFilter[];
  facets: Record<string, TableFacetOption[]>;
  total: number;
  pageCount: number;
  safePage: number;
};

type TableProjectionInput<T> = {
  rows: T[];
  state: TableFilterStateV1;
  views: TableSystemView<T>[];
  filterDefinitions: TableFilterDefinition<T>[];
  searchText: (row: T) => string;
  sorters?: Partial<Record<string, (left: T, right: T) => number>>;
};

function normalizedQuery(value: string) {
  return value.trim().toLocaleLowerCase('ru');
}

function rowMatchesFilter<T>(
  row: T,
  definition: TableFilterDefinition<T>,
  selectedValues: string[],
) {
  if (selectedValues.length === 0) return true;
  const rowValues = definition.values(row);
  return selectedValues.some((value) => rowValues.includes(value));
}

function applyFilters<T>(
  rows: T[],
  definitions: TableFilterDefinition<T>[],
  filters: Record<string, string[]>,
  ignoredCategoryId?: string,
) {
  return rows.filter((row) =>
    definitions.every((definition) => {
      if (definition.id === ignoredCategoryId) return true;
      return rowMatchesFilter(row, definition, filters[definition.id] ?? []);
    }),
  );
}

export function projectTableRows<T>({
  rows,
  state,
  views,
  filterDefinitions,
  searchText,
  sorters = {},
}: TableProjectionInput<T>): TableProjection<T> {
  const activeView = views.find((view) => view.id === state.view) ?? views[0];
  const viewRows = activeView ? rows.filter(activeView.matches) : [...rows];
  const query = normalizedQuery(state.query);
  const searchedRows = query
    ? viewRows.filter((row) => searchText(row).toLocaleLowerCase('ru').includes(query))
    : [...viewRows];
  const filteredRows = applyFilters(searchedRows, filterDefinitions, state.filters);
  const sorter = sorters[state.sort.column];
  const direction = state.sort.direction === 'desc' ? -1 : 1;
  const sortedRows =
    sorter && state.sort.direction !== 'none'
      ? [...filteredRows].sort((left, right) => sorter(left, right) * direction)
      : [...filteredRows];
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / Math.max(1, state.pageSize)));
  const safePage = Math.min(Math.max(1, state.page), pageCount);
  const startIndex = (safePage - 1) * state.pageSize;
  const pageRows = sortedRows.slice(startIndex, startIndex + state.pageSize);

  const facets = Object.fromEntries(
    filterDefinitions.map((definition) => {
      const rowsForFacet = applyFilters(
        searchedRows,
        filterDefinitions,
        state.filters,
        definition.id,
      );
      const selectedValues = new Set(state.filters[definition.id] ?? []);
      const options = definition.options.map((option) => ({
        ...option,
        count: rowsForFacet.filter((row) => definition.values(row).includes(option.id)).length,
        active: selectedValues.has(option.id),
      }));
      return [definition.id, options];
    }),
  );

  const activeFilters = filterDefinitions.flatMap((definition) => {
    const selectedValues = state.filters[definition.id] ?? [];
    return selectedValues.map((valueId) => {
      const option = definition.options.find((item) => item.id === valueId);
      const facet = facets[definition.id]?.find((item) => item.id === valueId);
      return {
        categoryId: definition.id,
        categoryLabel: definition.label,
        valueId,
        label: option?.label ?? valueId,
        count: facet?.count ?? 0,
      };
    });
  });

  return {
    baseRows: rows,
    viewRows,
    searchedRows,
    filteredRows,
    sortedRows,
    pageRows,
    activeFilters,
    facets,
    total: sortedRows.length,
    pageCount,
    safePage,
  };
}

export type TableFilterStateChange =
  | { type: 'view'; view: string }
  | { type: 'query'; query: string }
  | { type: 'filter'; categoryId: string; values: string[] }
  | { type: 'period'; period?: { from: string; to: string } }
  | { type: 'sort'; sort: TableFilterStateV1['sort'] }
  | { type: 'page'; page: number }
  | { type: 'pageSize'; pageSize: number }
  | { type: 'reset'; defaults: TableFilterStateV1 };

export function updateTableFilterState(
  state: TableFilterStateV1,
  change: TableFilterStateChange,
): TableFilterStateV1 {
  if (change.type === 'reset') return cloneTableFilterState(change.defaults);
  if (change.type === 'page') {
    const page = Math.max(1, change.page);
    return page === state.page ? state : { ...state, page };
  }
  if (change.type === 'sort') {
    return state.sort.column === change.sort.column &&
      state.sort.direction === change.sort.direction
      ? state
      : { ...state, sort: change.sort };
  }
  if (change.type === 'pageSize')
    return change.pageSize === state.pageSize && state.page === 1
      ? state
      : { ...state, pageSize: change.pageSize, page: 1 };
  if (change.type === 'view')
    return change.view === state.view && state.page === 1
      ? state
      : { ...state, view: change.view, page: 1 };
  if (change.type === 'query')
    return change.query === state.query && state.page === 1
      ? state
      : { ...state, query: change.query, page: 1 };
  if (change.type === 'period') return { ...state, period: change.period, page: 1 };
  const currentValues = state.filters[change.categoryId] ?? [];
  if (
    state.page === 1 &&
    currentValues.length === change.values.length &&
    currentValues.every((value, index) => value === change.values[index])
  )
    return state;
  return {
    ...state,
    filters: { ...state.filters, [change.categoryId]: [...change.values] },
    page: 1,
  };
}

function cloneTableFilterState(state: TableFilterStateV1): TableFilterStateV1 {
  const clone: TableFilterStateV1 = {
    ...state,
    filters: Object.fromEntries(
      Object.entries(state.filters).map(([key, values]) => [key, [...values]]),
    ),
    sort: { ...state.sort },
  };
  if (state.period) clone.period = { ...state.period };
  else delete clone.period;
  return clone;
}

export type TableFilterUrlContract = {
  views: string[];
  filters: Record<string, string[]>;
  sortColumns: string[];
  pageSizes: number[];
};

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function validDate(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function tablePeriodsEqual(
  left: TableFilterStateV1['period'],
  right: TableFilterStateV1['period'],
) {
  return left?.from === right?.from && left?.to === right?.to;
}

export function reconcileTableFilterState(
  state: TableFilterStateV1,
  defaults: TableFilterStateV1,
  contract: TableFilterUrlContract,
) {
  const pageSize = contract.pageSizes.includes(state.pageSize) ? state.pageSize : defaults.pageSize;
  const view = contract.views.includes(state.view) ? state.view : defaults.view;
  const sortColumn = contract.sortColumns.includes(state.sort.column)
    ? state.sort.column
    : defaults.sort.column;
  const filters = Object.fromEntries(
    Object.entries(state.filters).flatMap(([categoryId, values]) => {
      const allowed = contract.filters[categoryId];
      if (!allowed) return [];
      const validValues = values.filter((value) => allowed.includes(value));
      return validValues.length > 0 ? [[categoryId, validValues]] : [];
    }),
  );
  const changed =
    pageSize !== state.pageSize ||
    view !== state.view ||
    sortColumn !== state.sort.column ||
    JSON.stringify(filters) !== JSON.stringify(state.filters);
  if (!changed) return state;
  return {
    ...state,
    view,
    filters,
    sort: { ...state.sort, column: sortColumn },
    page: pageSize !== state.pageSize ? 1 : state.page,
    pageSize,
  };
}

export function serializeTableFilterState(scope: string, state: TableFilterStateV1) {
  const params = new URLSearchParams();
  params.set('table', scope);
  params.set('view', state.view);
  if (state.query.trim()) params.set('q', state.query.trim());
  for (const categoryId of Object.keys(state.filters).sort()) {
    for (const value of state.filters[categoryId] ?? []) params.append(`f.${categoryId}`, value);
  }
  if (state.period?.from) params.set('from', state.period.from);
  if (state.period?.to) params.set('to', state.period.to);
  params.set('sort', state.sort.column);
  params.set('dir', state.sort.direction);
  params.set('page', String(state.page));
  params.set('size', String(state.pageSize));
  return params;
}

const tableStateParamNames = new Set([
  'table',
  'view',
  'q',
  'from',
  'to',
  'sort',
  'dir',
  'page',
  'size',
]);

export function mergeTableFilterSearchParams(
  current: URLSearchParams,
  scope: string,
  state: TableFilterStateV1,
) {
  const next = new URLSearchParams();
  current.forEach((value, key) => {
    if (tableStateParamNames.has(key) || key.startsWith('f.')) return;
    next.append(key, value);
  });
  serializeTableFilterState(scope, state).forEach((value, key) => next.append(key, value));
  return next;
}

export function parseTableFilterState(
  scope: string,
  params: URLSearchParams,
  defaults: TableFilterStateV1,
  contract: TableFilterUrlContract,
): TableFilterStateV1 {
  if (params.get('table') !== scope) return cloneTableFilterState(defaults);
  const viewParam = params.get('view');
  const sortParam = params.get('sort');
  const directionParam = params.get('dir');
  const sizeParam = positiveInt(params.get('size'), defaults.pageSize);
  const filters = Object.fromEntries(
    Object.entries(contract.filters).flatMap(([categoryId, allowedValues]) => {
      const values = params
        .getAll(`f.${categoryId}`)
        .filter((value) => allowedValues.includes(value));
      return values.length > 0 ? [[categoryId, Array.from(new Set(values))]] : [];
    }),
  );
  const from = validDate(params.get('from'));
  const to = validDate(params.get('to'));

  return {
    view: viewParam && contract.views.includes(viewParam) ? viewParam : defaults.view,
    query: params.get('q') ?? defaults.query,
    filters,
    period:
      from && to && from <= to
        ? { from, to }
        : defaults.period
          ? { ...defaults.period }
          : undefined,
    sort: {
      column:
        sortParam && contract.sortColumns.includes(sortParam) ? sortParam : defaults.sort.column,
      direction:
        directionParam === 'desc' || directionParam === 'asc' || directionParam === 'none'
          ? directionParam
          : defaults.sort.direction,
    },
    page: positiveInt(params.get('page'), defaults.page),
    pageSize: contract.pageSizes.includes(sizeParam) ? sizeParam : defaults.pageSize,
  };
}
