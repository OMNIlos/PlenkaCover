const REFERENCE_TIME = Date.parse('2026-08-07T08:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const STATUS_LABELS = {
  awaiting_shipment: 'Ожидает отгрузки',
  available: 'Доступен',
  reserved: 'Зарезервирован',
  in_transit: 'В пути',
  processed: 'Обработан',
};

const PHYSICAL_STATUS_LABELS = {
  received: 'Принят складом',
  delivered: 'Выдан',
};

const NEXT_ROUTE_LABELS = {
  delivery: 'Выдача',
  reserve: 'Складской резерв',
  completed: 'Маршрут завершён',
};

function isoDaysAgo(days) {
  return new Date(REFERENCE_TIME - days * DAY_MS).toISOString();
}

function currentItem(index) {
  const sequence = String(index + 1).padStart(3, '0');
  const origin = index % 5 === 0 ? 'client' : 'reserve';
  let status;
  if (origin === 'client') {
    status = 'awaiting_shipment';
  } else {
    status = index % 4 === 0 ? 'reserved' : 'available';
  }
  const reserved = status === 'reserved';
  const orderNumber = origin === 'client' || reserved ? `A-${index + 1}` : null;
  const nextRoute = origin === 'client' || reserved ? 'delivery' : 'reserve';
  return {
    id: `qa-current-${sequence}`,
    rollCode: index === 0 ? 'R-STOCK-001' : `R-STOCK-${sequence}`,
    origin,
    lifecycleStatus: status,
    lifecycleStatusLabel: STATUS_LABELS[status],
    orderNumber,
    positionId: orderNumber ? `position-${sequence}` : null,
    positionSequence: orderNumber ? index + 1 : null,
    warehouseStatus: 'received',
    warehouseStatusLabel: PHYSICAL_STATUS_LABELS.received,
    nextRoute,
    nextRouteLabel: NEXT_ROUTE_LABELS[nextRoute],
    counterpartyName: origin === 'client' ? 'Контур Пак' : 'Резерв',
    batchCode: index === 0 ? 'STOCK-S-17' : `STOCK-${String((index % 3) + 1)}`,
    weightKg: 37.5 + index / 10,
    specification: index % 2 === 0 ? 'Полотно · 80 мкм · 1700 мм' : 'Рукав · 60 мкм · 1200 мм',
    receivedAt: isoDaysAgo(index + 1),
    processedAt: null,
  };
}

const currentItems = Array.from({ length: 27 }, (_, index) => currentItem(index));
const processedItems = [
  {
    id: 'qa-processed-001',
    rollCode: 'R-PROCESSED-001',
    origin: 'reserve',
    lifecycleStatus: 'processed',
    lifecycleStatusLabel: STATUS_LABELS.processed,
    orderNumber: 'A-PROCESSED-1',
    positionId: 'position-processed-1',
    positionSequence: 1,
    warehouseStatus: 'delivered',
    warehouseStatusLabel: PHYSICAL_STATUS_LABELS.delivered,
    nextRoute: 'completed',
    nextRouteLabel: NEXT_ROUTE_LABELS.completed,
    counterpartyName: 'Резерв',
    batchCode: 'STOCK-ARCHIVE-1',
    weightKg: 39.4,
    specification: 'Полотно · 80 мкм · 1700 мм',
    receivedAt: isoDaysAgo(21),
    processedAt: isoDaysAgo(3),
  },
  {
    id: 'qa-processed-002',
    rollCode: 'R-PROCESSED-002',
    origin: 'reserve',
    lifecycleStatus: 'processed',
    lifecycleStatusLabel: STATUS_LABELS.processed,
    orderNumber: 'A-PROCESSED-2',
    positionId: 'position-processed-2',
    positionSequence: 2,
    warehouseStatus: 'delivered',
    warehouseStatusLabel: PHYSICAL_STATUS_LABELS.delivered,
    nextRoute: 'completed',
    nextRouteLabel: NEXT_ROUTE_LABELS.completed,
    counterpartyName: 'Резерв',
    batchCode: 'STOCK-ARCHIVE-2',
    weightKg: 41.2,
    specification: 'Рукав · 60 мкм · 1200 мм',
    receivedAt: isoDaysAgo(18),
    processedAt: isoDaysAgo(2),
  },
];

function includes(value, query) {
  return String(value ?? '')
    .toLocaleLowerCase('ru-RU')
    .includes(query.toLocaleLowerCase('ru-RU'));
}

function ageDays(item) {
  return item.receivedAt
    ? Math.floor((REFERENCE_TIME - Date.parse(item.receivedAt)) / DAY_MS)
    : Number.POSITIVE_INFINITY;
}

function filteredItems(url) {
  const view = url.searchParams.get('view') === 'processed' ? 'processed' : 'current';
  const query = url.searchParams.get('q')?.trim() ?? '';
  const batch = url.searchParams.get('batch')?.trim() ?? '';
  const counterparty = url.searchParams.get('counterparty')?.trim() ?? '';
  const status = url.searchParams.get('status')?.trim() ?? '';
  const minAgeDays = Number(url.searchParams.get('minAgeDays'));
  const maxAgeDays = Number(url.searchParams.get('maxAgeDays'));
  const hasMinAge = url.searchParams.has('minAgeDays') && Number.isFinite(minAgeDays);
  const hasMaxAge = url.searchParams.has('maxAgeDays') && Number.isFinite(maxAgeDays);
  const sort = url.searchParams.get('sort') === 'rollCode' ? 'rollCode' : 'receivedAt';
  const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1;

  return (view === 'processed' ? processedItems : currentItems)
    .filter(
      (item) =>
        !query ||
        [item.rollCode, item.batchCode, item.counterpartyName, item.specification].some((value) =>
          includes(value, query),
        ),
    )
    .filter((item) => !batch || includes(item.batchCode, batch))
    .filter((item) => !counterparty || includes(item.counterpartyName, counterparty))
    .filter((item) => view === 'processed' || !status || item.lifecycleStatus === status)
    .filter((item) => !hasMinAge || ageDays(item) >= minAgeDays)
    .filter((item) => !hasMaxAge || ageDays(item) <= maxAgeDays)
    .toSorted((left, right) => {
      const leftValue = sort === 'rollCode' ? left.rollCode : left.receivedAt;
      const rightValue = sort === 'rollCode' ? right.rollCode : right.receivedAt;
      return direction * String(leftValue).localeCompare(String(rightValue), 'ru');
    });
}

function detailFor(item) {
  return {
    ...item,
    specificationDetails: {
      filmType: item.specification.startsWith('Рукав') ? 'Рукав' : 'Полотно',
      actualThicknessMicron: item.specification.includes('60 мкм') ? 60 : 80,
      accountingThicknessMicron: item.specification.includes('60 мкм') ? 58 : 78,
      widthMm: item.specification.includes('1200 мм') ? 1200 : 1700,
      plannedLengthM: 275,
      netKg: item.weightKg,
      spoolType: 'Шпуля 76 мм',
      birka: 'ГОСТ',
      recipeName: 'ПВД 70/30',
      ingredients: ['ПВД 15803-020 · 70%', 'ПВД 10803-020 · 30%'],
    },
    provenance: {
      kind: item.origin === 'client' ? 'client_order' : 'stock_reserve',
      orderNumber: item.origin === 'client' ? 'A-5' : null,
      batchCode: item.batchCode,
    },
  };
}

export function warehouseInventoryFixtureResponse(requestUrl) {
  const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
  const listPath = '/api/warehouse/inventory/rolls';
  if (url.pathname === listPath) {
    const items = filteredItems(url);
    const requestedLimit = Number(url.searchParams.get('limit'));
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 25;
    const cursorMatch = /^qa-inventory-(\d+)$/u.exec(url.searchParams.get('cursor') ?? '');
    const offset = cursorMatch ? Number(cursorMatch[1]) : 0;
    const pageItems = items.slice(offset, offset + limit);
    const nextOffset = offset + pageItems.length;
    return {
      items: pageItems,
      nextCursor: nextOffset < items.length ? `qa-inventory-${nextOffset}` : null,
    };
  }

  if (url.pathname.startsWith(`${listPath}/`)) {
    const id = decodeURIComponent(url.pathname.slice(listPath.length + 1));
    const item = [...currentItems, ...processedItems].find((candidate) => candidate.id === id);
    return item ? detailFor(item) : null;
  }

  return undefined;
}
