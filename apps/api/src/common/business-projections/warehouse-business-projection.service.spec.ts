import { Prisma, PrismaClient } from '@prisma/client';
import { CommercialPerformanceController } from '../../modules/commercial/commercial-performance.controller';
import { DirectorController } from '../../modules/director/director.controller';
import { fingerprintRollFact } from '../../modules/warehouse-coverage/warehouse-coverage-canonical';
import { WarehouseBusinessProjectionService } from './warehouse-business-projection.service';

type FixtureOrder = {
  id: string;
  orderNumber: string;
  requestType: 'client_order' | 'stock_reserve';
  warehouseCoverageWorkflowVersion: 1 | 2;
  shipmentStatus: string;
  counterpartyId: string | null;
  counterparty: { displayName: string } | null;
};

type RollLinks = {
  ownerCounterpartyId?: string | null;
  producedForStockOrderId?: string | null;
  producedForOrderId?: string | null;
  producedForOrder?: { id: string } | null;
  producedForPositionId?: string | null;
  producedForPosition?: { id: string; orderId: string } | null;
  producedByCoverageDecisionId?: string | null;
  producedByCoverageDecision?: {
    id: string;
    orderId: string;
    kind: 'produce_all' | 'auto_produce_all';
  } | null;
  reservedForOrderId?: string | null;
  reservedForPositionId?: string | null;
  reservedForPosition?: { orderId: string } | null;
  reservedByProposalId?: string | null;
  reservedByProposal?: { orderId: string; positionId: string } | null;
  reservedByCoverageDecisionId?: string | null;
  reservedByCoverageDecision?: { orderId: string } | null;
  reservedAt?: Date | null;
};

const CLIENT_ORDER: FixtureOrder = {
  id: 'order-client',
  orderNumber: 'ЗК-101',
  requestType: 'client_order',
  warehouseCoverageWorkflowVersion: 2,
  shipmentStatus: 'not_shipped',
  counterpartyId: 'counterparty-1',
  counterparty: { displayName: 'Контур Пак' },
};

const CLIENT_ORDER_2: FixtureOrder = {
  ...CLIENT_ORDER,
  id: 'order-client-2',
  orderNumber: 'ЗК-102',
  counterpartyId: 'counterparty-2',
  counterparty: { displayName: 'Плёнка Юг' },
};

const RESERVE_ORDER: FixtureOrder = {
  id: 'order-reserve',
  orderNumber: 'РЗ-17',
  requestType: 'stock_reserve',
  warehouseCoverageWorkflowVersion: 1,
  shipmentStatus: 'not_applicable',
  counterpartyId: null,
  counterparty: null,
};

const LEGACY_CLIENT_ORDER: FixtureOrder = {
  ...CLIENT_ORDER,
  id: 'order-client-v1',
  orderNumber: 'ЗК-100',
  warehouseCoverageWorkflowVersion: 1,
};

function coverageSpec(
  rollCode: string,
  order: FixtureOrder,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    rollCode,
    sourceOrderId: order.id,
    sourcePositionId: `${order.id}-position`,
    ownerCounterpartyId: order.requestType === 'client_order' ? 'counterparty-1' : null,
    filmType: 'Термоусадочная плёнка',
    actualThicknessMilliMicron: 35_000,
    accountingThicknessMilliMicron: 40_000,
    widthMilliMm: 500_000,
    plannedLengthMilliM: 1_200_000,
    birka: 'Белая',
    spoolType: '76 мм',
    actualWeightMilliKg: 18_700,
    plannedWeightMilliKg: 19_000,
    ingredients: [{ rawMaterialDefinitionId: 'material-pe', shareBasisPoints: 10_000 }],
    recipeId: 'recipe-1',
    recipeVersion: 'v3',
    recipeDefinitionId: 'recipe-definition-1',
    recipeDefinitionVersionId: 'recipe-definition-version-3',
    recipeVersionNumber: 3,
    policyVersion: 'warehouse-coverage-policy/v2',
    ...overrides,
  };
}

function roll(
  id: string,
  sourceOrder: FixtureOrder | null,
  warehouseStatus = 'received',
  specOverrides: Partial<Record<string, unknown>> = {},
  links: RollLinks = {},
) {
  const rollCode = `ROLL-${id}`;
  const spec = sourceOrder ? coverageSpec(rollCode, sourceOrder, specOverrides) : null;
  const sourcePositionId = spec?.sourcePositionId as string | undefined;
  const isV2Client =
    sourceOrder?.requestType === 'client_order' &&
    sourceOrder.warehouseCoverageWorkflowVersion === 2;
  const producedForOrderId =
    'producedForOrderId' in links ? links.producedForOrderId : isV2Client ? sourceOrder.id : null;
  const producedForPositionId =
    'producedForPositionId' in links
      ? links.producedForPositionId
      : isV2Client
        ? sourcePositionId
        : null;
  const producedByCoverageDecisionId =
    'producedByCoverageDecisionId' in links
      ? links.producedByCoverageDecisionId
      : isV2Client
        ? `${sourceOrder.id}-production-decision`
        : null;
  return {
    id,
    rollCode,
    warehouseStatus,
    ownerCounterpartyId:
      links.ownerCounterpartyId ??
      (sourceOrder?.requestType === 'client_order' ? sourceOrder.counterpartyId : null),
    producedForStockOrderId:
      'producedForStockOrderId' in links
        ? links.producedForStockOrderId
        : sourceOrder?.requestType === 'stock_reserve'
          ? sourceOrder.id
          : null,
    producedForOrderId,
    producedForOrder:
      'producedForOrder' in links
        ? links.producedForOrder
        : producedForOrderId
          ? { id: producedForOrderId }
          : null,
    producedForPositionId,
    producedForPosition:
      'producedForPosition' in links
        ? links.producedForPosition
        : producedForPositionId && sourceOrder
          ? { id: producedForPositionId, orderId: sourceOrder.id }
          : null,
    producedByCoverageDecisionId,
    producedByCoverageDecision:
      'producedByCoverageDecision' in links
        ? links.producedByCoverageDecision
        : producedByCoverageDecisionId && sourceOrder
          ? {
              id: producedByCoverageDecisionId,
              orderId: sourceOrder.id,
              kind: 'produce_all' as const,
            }
          : null,
    reservedForOrderId:
      'reservedForOrderId' in links
        ? links.reservedForOrderId
        : sourceOrder?.requestType === 'client_order' &&
            sourceOrder.warehouseCoverageWorkflowVersion === 1
          ? sourceOrder.id
          : null,
    reservedForPositionId: links.reservedForPositionId ?? null,
    reservedForPosition: links.reservedForPosition ?? null,
    reservedByProposalId: links.reservedByProposalId ?? null,
    reservedByProposal: links.reservedByProposal ?? null,
    reservedByCoverageDecisionId: links.reservedByCoverageDecisionId ?? null,
    reservedByCoverageDecision: links.reservedByCoverageDecision ?? null,
    reservedAt: links.reservedAt ?? null,
    positionSnapshot: { rawPayload: 'must-not-leak' },
    currentCoverageFactId: sourceOrder ? `fact-${id}` : null,
    currentCoverageFact: sourceOrder
      ? {
          id: `fact-${id}`,
          rollId: id,
          specVersion: 'warehouse-roll-coverage/v1',
          specFingerprint: fingerprintRollFact(spec as never),
          spec,
          sourceOrderId: sourceOrder.id,
          sourcePositionId,
          sourceOrder: {
            id: sourceOrder.id,
            requestType: sourceOrder.requestType,
            warehouseCoverageWorkflowVersion: sourceOrder.warehouseCoverageWorkflowVersion,
          },
          sourcePosition: {
            id: sourcePositionId,
            orderId: sourceOrder.id,
          },
          rawPayload: { stable: true },
        }
      : null,
  };
}

type FixtureRoll = ReturnType<typeof roll>;

function group(
  kind: 'client_order' | 'reserve',
  order: FixtureOrder,
  rollIds: string[],
  total = 1,
) {
  return {
    kind,
    id: order.id,
    rollIds,
    total,
    orderNumber: kind === 'reserve' ? null : order.orderNumber,
    counterpartyId: kind === 'reserve' ? null : order.counterpartyId,
    counterpartyName: kind === 'reserve' ? null : (order.counterparty?.displayName ?? null),
  };
}

function setup(rows: FixtureRoll[], groups: ReturnType<typeof group>[] = []) {
  const findMany = jest
    .fn()
    .mockImplementation(({ where }: { where?: { id?: { in: string[] } } }) => {
      const ids = where?.id?.in;
      return Promise.resolve(ids ? rows.filter((row) => ids.includes(row.id)) : rows);
    });
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(groups),
    warehouseRoll: { findMany },
  };
  return {
    prisma,
    service: new WarehouseBusinessProjectionService(prisma as never),
  };
}

function emptyPage() {
  return { items: [], page: 1, pageSize: 50, total: 0 };
}

function coverageFact(row: FixtureRoll) {
  const fact = row.currentCoverageFact;
  if (!fact) throw new Error('fixture requires a current coverage fact');
  return fact;
}

function replaceSpecProvenance(
  row: FixtureRoll,
  overrides: Partial<{ rollCode: string; sourceOrderId: string; sourcePositionId: string }>,
) {
  const fact = coverageFact(row);
  fact.spec = { ...fact.spec, ...overrides } as typeof fact.spec;
  fact.specFingerprint = fingerprintRollFact(fact.spec as never);
}

function forbiddenKeys(value: unknown): string[] {
  const forbidden = new Set([
    'positionSnapshot',
    'rawPayload',
    'rollCode',
    'actualWeightMilliKg',
    'specFingerprint',
    'currentCoverageFact',
  ]);
  if (Array.isArray(value)) return value.flatMap(forbiddenKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbidden.has(key) ? [key] : []),
    ...forbiddenKeys(child),
  ]);
}

describe('WarehouseBusinessProjectionService', () => {
  it('excludes sent rolls because warehouse acceptance is not confirmed', async () => {
    const sent = roll('sent', CLIENT_ORDER, 'sent');
    const { service } = setup([sent]);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it('projects an all-received client group as awaiting shipment', async () => {
    const rows = [roll('received-a', CLIENT_ORDER), roll('received-b', CLIENT_ORDER)];
    const { service } = setup(rows, [
      group(
        'client_order',
        CLIENT_ORDER,
        rows.map(({ id }) => id),
      ),
    ]);

    const page = await service.list({});

    expect(page).toEqual({
      items: [
        expect.objectContaining({
          kind: 'client_order',
          id: CLIENT_ORDER.id,
          status: 'awaiting_shipment',
          orderNumber: CLIENT_ORDER.orderNumber,
          counterpartyName: 'Контур Пак',
        }),
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('projects a coherent workflow V1 legacy handover', async () => {
    const legacy = roll('legacy-client', LEGACY_CLIENT_ORDER);
    const { service } = setup([legacy], [group('client_order', LEGACY_CLIENT_ORDER, [legacy.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [
        expect.objectContaining({
          kind: 'client_order',
          id: LEGACY_CLIENT_ORDER.id,
          status: 'awaiting_shipment',
        }),
      ],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('projects a received plus delivered client group as post-acceptance processing', async () => {
    const rows = [
      roll('received', CLIENT_ORDER, 'received'),
      roll('delivered', CLIENT_ORDER, 'delivered'),
    ];
    const { service } = setup(rows, [
      group(
        'client_order',
        CLIENT_ORDER,
        rows.map(({ id }) => id),
      ),
    ]);

    const page = await service.list({});

    expect(page.items).toEqual([
      expect.objectContaining({ id: CLIENT_ORDER.id, status: 'processing' }),
    ]);
  });

  it('excludes an all-delivered group because no accepted roll remains current', async () => {
    const rows = [
      roll('delivered-a', CLIENT_ORDER, 'delivered'),
      roll('delivered-b', CLIENT_ORDER, 'delivered'),
    ];
    const { service } = setup(rows);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it('renders only genuinely unallocated stock as reserve with null office fields', async () => {
    const free = roll('free', RESERVE_ORDER);
    const { service } = setup([free], [group('reserve', RESERVE_ORDER, [free.id])]);

    const page = await service.list({});

    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'reserve',
        id: RESERVE_ORDER.id,
        status: 'reserve',
        orderNumber: null,
        counterpartyName: null,
      }),
    ]);
  });

  it('groups stock allocated through consistent order, position, proposal, and decision links as customer stock', async () => {
    const allocated = roll(
      'allocated',
      RESERVE_ORDER,
      'received',
      {},
      {
        ownerCounterpartyId: 'counterparty-2',
        reservedForOrderId: CLIENT_ORDER_2.id,
        reservedForPositionId: 'position-2',
        reservedForPosition: { orderId: CLIENT_ORDER_2.id },
        reservedByProposalId: 'proposal-2',
        reservedByProposal: { orderId: CLIENT_ORDER_2.id, positionId: 'position-2' },
        reservedByCoverageDecisionId: 'decision-2',
        reservedByCoverageDecision: { orderId: CLIENT_ORDER_2.id },
        reservedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    );
    const { service } = setup([allocated], [group('client_order', CLIENT_ORDER_2, [allocated.id])]);

    const page = await service.list({});

    expect(page.items).toEqual([
      expect.objectContaining({
        kind: 'client_order',
        id: CLIENT_ORDER_2.id,
        status: 'awaiting_shipment',
        orderNumber: CLIENT_ORDER_2.orderNumber,
        counterpartyName: 'Плёнка Юг',
      }),
    ]);
    expect(page.items[0]).not.toEqual(
      expect.objectContaining({ kind: 'reserve', orderNumber: null, counterpartyName: null }),
    );
  });

  it('accepts allocated stock when its owner matches the target order counterparty', async () => {
    const matching = roll(
      'matching-owner',
      RESERVE_ORDER,
      'received',
      {},
      {
        ownerCounterpartyId: CLIENT_ORDER_2.counterpartyId,
        reservedForOrderId: CLIENT_ORDER_2.id,
        reservedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    );
    const { service } = setup([matching], [group('client_order', CLIENT_ORDER_2, [matching.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [expect.objectContaining({ id: CLIENT_ORDER_2.id, kind: 'client_order' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('accepts allocated stock with a null historical owner', async () => {
    const historical = roll(
      'historical-owner',
      RESERVE_ORDER,
      'received',
      {},
      {
        ownerCounterpartyId: null,
        reservedForOrderId: CLIENT_ORDER_2.id,
        reservedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    );
    const { service } = setup(
      [historical],
      [group('client_order', CLIENT_ORDER_2, [historical.id])],
    );

    await expect(service.list({})).resolves.toEqual({
      items: [expect.objectContaining({ id: CLIENT_ORDER_2.id, kind: 'client_order' })],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('fails closed when allocated stock owner conflicts with the target order counterparty', async () => {
    const conflicting = roll(
      'conflicting-owner',
      RESERVE_ORDER,
      'received',
      {},
      {
        ownerCounterpartyId: CLIENT_ORDER.counterpartyId,
        reservedForOrderId: CLIENT_ORDER_2.id,
        reservedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    );
    const { service } = setup(
      [conflicting],
      [group('client_order', CLIENT_ORDER_2, [conflicting.id])],
    );

    await expect(service.list({})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it.each([
    ['position', { reservedForPositionId: 'missing-position' }],
    ['proposal', { reservedByProposalId: 'missing-proposal' }],
    ['decision', { reservedByCoverageDecisionId: 'missing-decision' }],
    ['ownership', { ownerCounterpartyId: 'counterparty-2', reservedAt: new Date() }],
  ] as const)('fails closed for incomplete stock %s allocation linkage', async (_name, links) => {
    const incomplete = roll('incomplete', RESERVE_ORDER, 'received', {}, links);
    const { service } = setup([incomplete]);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it('fails closed when current allocation links point to different customer orders', async () => {
    const conflicting = roll(
      'conflicting',
      RESERVE_ORDER,
      'received',
      {},
      {
        reservedForOrderId: CLIENT_ORDER.id,
        reservedForPositionId: 'position-2',
        reservedForPosition: { orderId: CLIENT_ORDER_2.id },
        reservedAt: new Date('2026-08-08T00:00:00.000Z'),
      },
    );
    const { service } = setup([conflicting]);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it.each([
    {
      label: 'the current fact belongs to another roll',
      mutate: (row: FixtureRoll) => {
        coverageFact(row).rollId = 'other-roll';
      },
    },
    {
      label: 'the fact source-position relation is missing',
      mutate: (row: FixtureRoll) => {
        Object.assign(coverageFact(row), { sourcePosition: null });
      },
    },
    {
      label: 'the fact source position belongs to another order',
      mutate: (row: FixtureRoll) => {
        coverageFact(row).sourcePosition.orderId = CLIENT_ORDER_2.id;
      },
    },
    {
      label: 'the produced-for position differs from the fact source position',
      mutate: (row: FixtureRoll) => {
        row.producedForPositionId = 'other-position';
        row.producedForPosition = { id: 'other-position', orderId: CLIENT_ORDER.id };
      },
    },
    {
      label: 'the produced-for position relation is missing',
      mutate: (row: FixtureRoll) => {
        row.producedForPosition = null;
      },
    },
    {
      label: 'the canonical spec source order differs from the fact',
      mutate: (row: FixtureRoll) => {
        replaceSpecProvenance(row, { sourceOrderId: CLIENT_ORDER_2.id });
      },
    },
    {
      label: 'the canonical spec source position differs from the fact',
      mutate: (row: FixtureRoll) => {
        replaceSpecProvenance(row, { sourcePositionId: 'other-position' });
      },
    },
    {
      label: 'the canonical spec roll code differs from the persisted roll',
      mutate: (row: FixtureRoll) => {
        replaceSpecProvenance(row, { rollCode: 'OTHER-ROLL-CODE' });
      },
    },
  ])('fails closed at the detail stage when $label', async ({ mutate }) => {
    const malformed = roll('malformed-client-provenance', CLIENT_ORDER);
    mutate(malformed);
    const { service } = setup([malformed], [group('client_order', CLIENT_ORDER, [malformed.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('fails closed at the detail stage when stock origin conflicts with the fact source order', async () => {
    const malformed = roll(
      'malformed-stock-provenance',
      RESERVE_ORDER,
      'received',
      {},
      {
        producedForStockOrderId: 'other-stock-order',
      },
    );
    const { service } = setup([malformed], [group('reserve', RESERVE_ORDER, [malformed.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it.each([
    {
      label: 'a V2 produced-order relation is missing',
      order: CLIENT_ORDER,
      links: { producedForOrder: null },
    },
    {
      label: 'a V2 production decision is missing',
      order: CLIENT_ORDER,
      links: { producedByCoverageDecisionId: null, producedByCoverageDecision: null },
    },
    {
      label: 'a V2 production decision relation is missing',
      order: CLIENT_ORDER,
      links: { producedByCoverageDecision: null },
    },
    {
      label: 'a V2 production decision belongs to another order',
      order: CLIENT_ORDER,
      links: {
        producedByCoverageDecision: {
          id: `${CLIENT_ORDER.id}-production-decision`,
          orderId: CLIENT_ORDER_2.id,
          kind: 'produce_all' as const,
        },
      },
    },
    {
      label: 'a V2 production handover also carries legacy reservation provenance',
      order: CLIENT_ORDER,
      links: { reservedForOrderId: CLIENT_ORDER.id },
    },
    {
      label: 'a V1 legacy handover also carries V2 production provenance',
      order: LEGACY_CLIENT_ORDER,
      links: {
        producedForOrderId: LEGACY_CLIENT_ORDER.id,
        producedForPositionId: `${LEGACY_CLIENT_ORDER.id}-position`,
        producedByCoverageDecisionId: `${LEGACY_CLIENT_ORDER.id}-production-decision`,
      },
    },
  ])('fails closed at the detail stage when $label', async ({ order, links }) => {
    const malformed = roll('mixed-client-version', order, 'received', {}, links);
    const { service } = setup([malformed], [group('client_order', order, [malformed.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it.each([
    {
      label: 'produced-for order provenance',
      links: { producedForOrderId: CLIENT_ORDER_2.id },
      projectedGroup: group('client_order', CLIENT_ORDER_2, ['corrupt-stock-production']),
    },
    {
      label: 'produced-for position provenance',
      links: {
        producedForPositionId: `${CLIENT_ORDER_2.id}-position`,
        producedForPosition: {
          id: `${CLIENT_ORDER_2.id}-position`,
          orderId: CLIENT_ORDER_2.id,
        },
      },
      projectedGroup: group('reserve', RESERVE_ORDER, ['corrupt-stock-production']),
    },
    {
      label: 'produced-by decision provenance',
      links: {
        producedByCoverageDecisionId: `${CLIENT_ORDER_2.id}-production-decision`,
        producedByCoverageDecision: {
          id: `${CLIENT_ORDER_2.id}-production-decision`,
          orderId: CLIENT_ORDER_2.id,
          kind: 'produce_all' as const,
        },
      },
      projectedGroup: group('reserve', RESERVE_ORDER, ['corrupt-stock-production']),
    },
  ])('fails closed when stock carries client $label', async ({ links, projectedGroup }) => {
    const malformed = roll('corrupt-stock-production', RESERVE_ORDER, 'received', {}, links);
    const { service } = setup([malformed], [projectedGroup]);

    await expect(service.list({})).resolves.toEqual({
      items: [],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('deduplicates physical rolls into one template and preserves two business templates', async () => {
    const rows = [
      roll('same-a', CLIENT_ORDER),
      roll('same-b', CLIENT_ORDER, 'received', { actualWeightMilliKg: 19_200 }),
      roll('different', CLIENT_ORDER, 'received', { widthMilliMm: 600_000 }),
    ];
    const { service } = setup(rows, [
      group(
        'client_order',
        CLIENT_ORDER,
        rows.map(({ id }) => id),
      ),
    ]);

    const page = await service.list({});

    expect(page.items[0]?.templates).toHaveLength(2);
    expect(page.items[0]?.templates.map(({ widthMm }) => widthMm)).toEqual([500, 600]);
  });

  it('keeps an invalid-only accepted group with no projected templates and an exact total', async () => {
    const invalid = roll('invalid-only', CLIENT_ORDER);
    if (invalid.currentCoverageFact) invalid.currentCoverageFact.specFingerprint = 'invalid';
    const { service } = setup([invalid], [group('client_order', CLIENT_ORDER, [invalid.id])]);

    await expect(service.list({})).resolves.toEqual({
      items: [expect.objectContaining({ id: CLIENT_ORDER.id, templates: [] })],
      page: 1,
      pageSize: 50,
      total: 1,
    });
  });

  it('keeps valid templates from a mixed valid and invalid accepted group', async () => {
    const valid = roll('mixed-valid', CLIENT_ORDER);
    const invalid = roll('mixed-invalid', CLIENT_ORDER);
    if (invalid.currentCoverageFact) invalid.currentCoverageFact.specFingerprint = 'invalid';
    const { service } = setup(
      [valid, invalid],
      [group('client_order', CLIENT_ORDER, [valid.id, invalid.id])],
    );

    const page = await service.list({});

    expect(page).toEqual({
      items: [expect.objectContaining({ id: CLIENT_ORDER.id, templates: [expect.any(Object)] })],
      page: 1,
      pageSize: 50,
      total: 1,
    });
    expect(page.items[0]?.templates).toHaveLength(1);
  });

  it('fetches and hashes only page roll details while preserving group total', async () => {
    const first = roll('off-page-1', CLIENT_ORDER);
    const second = roll('page-2', CLIENT_ORDER_2);
    const thirdOrder = { ...CLIENT_ORDER, id: 'order-client-3', orderNumber: 'ЗК-103' };
    const third = roll('off-page-3', thirdOrder);
    let offPageSpecReads = 0;
    for (const offPage of [first, third]) {
      const fact = offPage.currentCoverageFact;
      if (!fact) continue;
      const spec = fact.spec;
      Object.defineProperty(fact, 'spec', {
        enumerable: true,
        get: () => {
          offPageSpecReads += 1;
          return spec;
        },
      });
    }
    const { service, prisma } = setup(
      [first, second, third],
      [group('client_order', CLIENT_ORDER_2, [second.id], 3)],
    );

    const page = await service.list({ page: 2, pageSize: 1 });

    expect(page).toEqual({
      items: [expect.objectContaining({ id: CLIENT_ORDER_2.id })],
      page: 2,
      pageSize: 1,
      total: 3,
    });
    expect(prisma.warehouseRoll.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.warehouseRoll.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [second.id] } } }),
    );
    expect(offPageSpecReads).toBe(0);
  });

  it('emits provenance validation inside the bounded candidate CTE before grouping and totals', async () => {
    const { service, prisma } = setup([]);

    await service.list({ page: 2, pageSize: 25 });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.warehouseRoll.findMany).not.toHaveBeenCalled();
    const statement = prisma.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;
    const sql = statement.strings.join('?').replace(/\s+/gu, ' ');
    const candidates = sql.slice(sql.indexOf('WITH candidates AS'), sql.indexOf('), linked AS'));
    expect(candidates).toMatch(/fact\."rollId" = roll\.id/u);
    expect(candidates).toMatch(
      /INNER JOIN commercial_order_positions AS source_position[\s\S]+source_position\."orderId" = fact\."sourceOrderId"/u,
    );
    expect(candidates).toMatch(
      /LEFT JOIN commercial_order_positions AS produced_position[\s\S]+produced_position\.id = roll\."producedForPositionId"/u,
    );
    expect(candidates).toMatch(
      /LEFT JOIN commercial_orders AS produced_order[\s\S]+produced_order\.id = roll\."producedForOrderId"/u,
    );
    expect(candidates).toMatch(
      /LEFT JOIN warehouse_coverage_decisions AS produced_decision[\s\S]+produced_decision\.id = roll\."producedByCoverageDecisionId"/u,
    );
    expect(candidates).toMatch(
      /fact\."spec" ->> 'rollCode' = roll\."rollCode"[\s\S]+fact\."spec" ->> 'sourceOrderId' = fact\."sourceOrderId"[\s\S]+fact\."spec" ->> 'sourcePositionId' = fact\."sourcePositionId"/u,
    );
    expect(candidates).toMatch(
      /source_order\."requestType" = 'client_order'[\s\S]+source_order\."warehouseCoverageWorkflowVersion" = 1[\s\S]+roll\."producedForOrderId" IS NULL[\s\S]+roll\."producedForPositionId" IS NULL[\s\S]+roll\."producedByCoverageDecisionId" IS NULL[\s\S]+roll\."reservedForOrderId" = fact\."sourceOrderId"/u,
    );
    expect(candidates).toMatch(
      /source_order\."warehouseCoverageWorkflowVersion" = 2[\s\S]+roll\."producedForOrderId" = fact\."sourceOrderId"[\s\S]+produced_order\.id = roll\."producedForOrderId"[\s\S]+roll\."producedForPositionId" = fact\."sourcePositionId"[\s\S]+produced_position\."orderId" = fact\."sourceOrderId"[\s\S]+produced_decision\."orderId" = fact\."sourceOrderId"[\s\S]+produced_decision\."kind" IN \('produce_all', 'auto_produce_all'\)/u,
    );
    expect(candidates).toMatch(
      /source_order\."requestType" = 'stock_reserve'[\s\S]+roll\."producedForStockOrderId" = fact\."sourceOrderId"[\s\S]+roll\."producedForOrderId" IS NULL[\s\S]+roll\."producedForPositionId" IS NULL[\s\S]+roll\."producedByCoverageDecisionId" IS NULL/u,
    );
    const linked = sql.slice(sql.indexOf('linked AS'), sql.indexOf('), resolved AS'));
    expect(linked).not.toMatch(/COALESCE\( produced_order_id,/u);
    expect(linked).toMatch(/COALESCE\( reserved_order_id,/u);
    expect(sql.indexOf('fact."rollId" = roll.id')).toBeLessThan(sql.indexOf('totals AS'));
  });

  it('excludes shipped and unsupported group identities at the group-key query stage', async () => {
    const shipped = { ...CLIENT_ORDER, shipmentStatus: 'shipped' };
    const unsupported = {
      ...CLIENT_ORDER,
      id: 'order-unsupported',
      requestType: 'future_request_type',
    } as unknown as FixtureOrder;
    const { service } = setup([roll('shipped', shipped), roll('unsupported', unsupported)]);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it('returns no row when there is no persisted source order', async () => {
    const { service } = setup([roll('orphan', null)]);

    await expect(service.list({})).resolves.toEqual(emptyPage());
  });

  it('recursively excludes physical and raw fields from the business response', async () => {
    const safe = roll('safe', CLIENT_ORDER);
    const { service } = setup([safe], [group('client_order', CLIENT_ORDER, [safe.id])]);

    const page = await service.list({});

    expect(forbiddenKeys(page)).toEqual([]);
  });

  it('serves identical pages through Commerce and the explicit Director business route', async () => {
    const expected = emptyPage();
    const projection = { list: jest.fn().mockResolvedValue(expected) };
    const commercial = new CommercialPerformanceController(
      {} as never,
      {} as never,
      projection as never,
    );
    const director = new DirectorController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      projection as never,
      {} as never,
    );

    await expect(commercial.warehouse({} as never)).resolves.toBe(expected);
    await expect(director.performanceWarehouse({} as never)).resolves.toBe(expected);
    expect(projection.list).toHaveBeenNthCalledWith(1, {});
    expect(projection.list).toHaveBeenNthCalledWith(2, {});
  });
});

const describePostgres = process.env.WAREHOUSE_BUSINESS_POSTGRES === '1' ? describe : describe.skip;

describePostgres('WarehouseBusinessProjectionService PostgreSQL provenance CTE', () => {
  const prisma = new PrismaClient();

  afterAll(async () => prisma.$disconnect());

  it('excludes a cross-roll fact before total while preserving legitimate allocated stock', async () => {
    class RollbackFixture extends Error {}

    try {
      await prisma.$transaction(
        async (tx) => {
          const counterpartyId = 'task1-provenance-counterparty';
          const clientOrderId = 'task1-provenance-client-order';
          const allocatedStockOrderId = 'task1-provenance-stock-order';
          const corruptStockOrderId = 'task1-provenance-corrupt-stock-order';
          const allocatedPositionId = 'task1-provenance-stock-position';
          const corruptPositionId = 'task1-provenance-corrupt-position';
          const allocatedRollId = 'task1-provenance-allocated-roll';
          const corruptRollId = 'task1-provenance-corrupt-roll';
          const factOwnerRollId = 'task1-provenance-fact-owner-roll';

          await tx.$executeRawUnsafe('ALTER TABLE warehouse_rolls DISABLE TRIGGER USER');

          await tx.counterparty.create({
            data: {
              id: counterpartyId,
              displayName: 'Task 1 provenance counterparty',
            },
          });
          await tx.commercialOrder.createMany({
            data: [
              {
                id: clientOrderId,
                orderNumber: 'TASK1-PROVENANCE-CLIENT',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
              },
              {
                id: allocatedStockOrderId,
                orderNumber: 'TASK1-PROVENANCE-STOCK',
                creatorRole: 'commercial',
                requestType: 'stock_reserve',
                stockBatchCode: 'TASK1-PROVENANCE-STOCK',
                shipmentStatus: 'not_applicable',
              },
              {
                id: corruptStockOrderId,
                orderNumber: 'TASK1-PROVENANCE-CORRUPT-STOCK',
                creatorRole: 'commercial',
                requestType: 'stock_reserve',
                stockBatchCode: 'TASK1-PROVENANCE-CORRUPT-STOCK',
                shipmentStatus: 'not_applicable',
              },
            ],
          });
          await tx.commercialOrderPosition.createMany({
            data: [
              {
                id: allocatedPositionId,
                orderId: allocatedStockOrderId,
                rollCount: 1,
                filmType: 'Термоусадочная плёнка',
                actualThickness: '35 мкм',
                accountingThickness: '40 мкм',
              },
              {
                id: corruptPositionId,
                orderId: corruptStockOrderId,
                rollCount: 1,
                filmType: 'Термоусадочная плёнка',
                actualThickness: '35 мкм',
                accountingThickness: '40 мкм',
              },
            ],
          });
          await tx.warehouseRoll.createMany({
            data: [
              {
                id: allocatedRollId,
                rollCode: 'TASK1-PROVENANCE-ALLOCATED-ROLL',
                ownerCounterpartyId: counterpartyId,
                producedForStockOrderId: allocatedStockOrderId,
                reservedForOrderId: clientOrderId,
                reservedAt: new Date('2026-08-08T08:00:00.000Z'),
                warehouseStatus: 'received',
              },
              {
                id: corruptRollId,
                rollCode: 'TASK1-PROVENANCE-CORRUPT-ROLL',
                producedForStockOrderId: corruptStockOrderId,
                warehouseStatus: 'received',
              },
              {
                id: factOwnerRollId,
                rollCode: 'TASK1-PROVENANCE-FACT-OWNER-ROLL',
                producedForStockOrderId: corruptStockOrderId,
                warehouseStatus: 'not_ready',
              },
            ],
          });

          const createFact = async (
            id: string,
            rollId: string,
            rollCode: string,
            sourceOrderId: string,
            sourcePositionId: string,
          ) => {
            const spec = coverageSpec(
              rollCode,
              {
                id: sourceOrderId,
                orderNumber: sourceOrderId,
                requestType: 'stock_reserve',
                warehouseCoverageWorkflowVersion: 1,
                shipmentStatus: 'not_applicable',
                counterpartyId: null,
                counterparty: null,
              },
              { sourcePositionId },
            );
            await tx.warehouseRollCoverageFact.create({
              data: {
                id,
                rollId,
                version: 1,
                source: 'migration_backfill',
                specVersion: 'warehouse-roll-coverage/v1',
                specFingerprint: fingerprintRollFact(spec as never),
                spec,
                sourceOrderId,
                sourcePositionId,
                actorKind: 'system',
                systemActorKey: 'warehouse_coverage_engine',
              },
            });
          };

          const allocatedFactId = 'task1-provenance-allocated-fact';
          const crossRollFactId = 'task1-provenance-cross-roll-fact';
          await createFact(
            allocatedFactId,
            allocatedRollId,
            'TASK1-PROVENANCE-ALLOCATED-ROLL',
            allocatedStockOrderId,
            allocatedPositionId,
          );
          await createFact(
            crossRollFactId,
            factOwnerRollId,
            'TASK1-PROVENANCE-FACT-OWNER-ROLL',
            corruptStockOrderId,
            corruptPositionId,
          );
          await tx.warehouseRoll.update({
            where: { id: allocatedRollId },
            data: { currentCoverageFactId: allocatedFactId },
          });

          await tx.warehouseRoll.update({
            where: { id: corruptRollId },
            data: { currentCoverageFactId: crossRollFactId },
          });

          const service = new WarehouseBusinessProjectionService(tx as never);
          await expect(service.list({ page: 1, pageSize: 50 })).resolves.toMatchObject({
            items: [
              {
                kind: 'client_order',
                id: clientOrderId,
                orderNumber: 'TASK1-PROVENANCE-CLIENT',
                counterpartyName: 'Task 1 provenance counterparty',
              },
            ],
            total: 1,
          });

          await tx.commercialOrder.update({
            where: { id: clientOrderId },
            data: { shipmentStatus: 'shipped' },
          });
          await expect(service.list({ page: 1, pageSize: 50 })).resolves.toEqual({
            items: [],
            page: 1,
            pageSize: 50,
            total: 0,
          });

          throw new RollbackFixture();
        },
        { timeout: 30_000 },
      );
      throw new Error('PostgreSQL fixture transaction unexpectedly committed');
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  });

  it('preserves coherent V1, V2, and stock allocation while excluding mixed origins from total', async () => {
    class RollbackFixture extends Error {}

    try {
      await prisma.$transaction(
        async (tx) => {
          const counterpartyId = 'task1-versioned-provenance-counterparty';
          const v1OrderId = 'task1-versioned-provenance-v1-order';
          const v2OrderId = 'task1-versioned-provenance-v2-order';
          const mixedOrderId = 'task1-versioned-provenance-mixed-order';
          const allocatedOrderId = 'task1-versioned-provenance-allocated-order';
          const corruptTargetOrderId = 'task1-versioned-provenance-corrupt-target-order';
          const stockOrderId = 'task1-versioned-provenance-stock-order';
          const corruptStockOrderId = 'task1-versioned-provenance-corrupt-stock-order';
          const v1PositionId = 'task1-versioned-provenance-v1-position';
          const v2PositionId = 'task1-versioned-provenance-v2-position';
          const mixedPositionId = 'task1-versioned-provenance-mixed-position';
          const stockPositionId = 'task1-versioned-provenance-stock-position';
          const corruptStockPositionId = 'task1-versioned-provenance-corrupt-stock-position';
          const v1RollId = 'task1-versioned-provenance-v1-roll';
          const v2RollId = 'task1-versioned-provenance-v2-roll';
          const mixedRollId = 'task1-versioned-provenance-mixed-roll';
          const allocatedRollId = 'task1-versioned-provenance-allocated-roll';
          const corruptStockRollId = 'task1-versioned-provenance-corrupt-stock-roll';
          const productionDecisionId = '10000000-0000-4000-8000-000000000001';

          await tx.$executeRawUnsafe('ALTER TABLE warehouse_rolls DISABLE TRIGGER USER');
          await tx.$executeRawUnsafe(
            'ALTER TABLE warehouse_coverage_decisions DISABLE TRIGGER USER',
          );

          await tx.counterparty.create({
            data: {
              id: counterpartyId,
              displayName: 'Task 1 versioned provenance counterparty',
            },
          });
          await tx.commercialOrder.createMany({
            data: [
              {
                id: v1OrderId,
                orderNumber: 'TASK1-VERSIONED-V1',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
                warehouseCoverageWorkflowVersion: 1,
              },
              {
                id: v2OrderId,
                orderNumber: 'TASK1-VERSIONED-V2',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
                warehouseCoverageWorkflowVersion: 2,
              },
              {
                id: mixedOrderId,
                orderNumber: 'TASK1-VERSIONED-MIXED',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
                warehouseCoverageWorkflowVersion: 2,
              },
              {
                id: allocatedOrderId,
                orderNumber: 'TASK1-VERSIONED-ALLOCATED',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
                warehouseCoverageWorkflowVersion: 2,
              },
              {
                id: corruptTargetOrderId,
                orderNumber: 'TASK1-VERSIONED-CORRUPT-TARGET',
                creatorRole: 'commercial',
                counterpartyId,
                requestType: 'client_order',
                warehouseCoverageWorkflowVersion: 2,
              },
              {
                id: stockOrderId,
                orderNumber: 'TASK1-VERSIONED-STOCK',
                creatorRole: 'commercial',
                requestType: 'stock_reserve',
                stockBatchCode: 'TASK1-VERSIONED-STOCK',
                shipmentStatus: 'not_applicable',
              },
              {
                id: corruptStockOrderId,
                orderNumber: 'TASK1-VERSIONED-CORRUPT-STOCK',
                creatorRole: 'commercial',
                requestType: 'stock_reserve',
                stockBatchCode: 'TASK1-VERSIONED-CORRUPT-STOCK',
                shipmentStatus: 'not_applicable',
              },
            ],
          });
          await tx.commercialOrderPosition.createMany({
            data: [
              [v1PositionId, v1OrderId],
              [v2PositionId, v2OrderId],
              [mixedPositionId, mixedOrderId],
              [stockPositionId, stockOrderId],
              [corruptStockPositionId, corruptStockOrderId],
            ].map(([id, orderId]) => ({
              id,
              orderId,
              rollCount: 1,
              filmType: 'Термоусадочная плёнка',
              actualThickness: '35 мкм',
              accountingThickness: '40 мкм',
            })),
          });

          const calculation = await tx.warehouseCoverageCalculation.create({
            data: {
              id: 'task1-versioned-provenance-calculation',
              orderId: v2OrderId,
              generation: 1,
              orderVersion: 1,
              positionVersions: [{ positionId: v2PositionId, version: 1 }],
              orderFingerprint: '1'.repeat(64),
              inventoryEpoch: 0n,
              inventoryFingerprint: '2'.repeat(64),
              inputFingerprint: '3'.repeat(64),
              algorithmVersion: 'warehouse-coverage-matching/v1',
              policyVersion: 'warehouse-coverage-policy/v1',
              availability: 'unavailable',
              reasonCodes: ['no_compatible_rolls'],
              requiredRollCount: 1,
              matchedRollCount: 0,
              uncertainRollCount: 0,
              verifiedCandidateRollIds: [],
              uncertainCandidateRollIds: [],
              systemActorKey: 'warehouse_coverage_engine',
            },
          });
          await tx.warehouseCoverageDecision.create({
            data: {
              id: productionDecisionId,
              orderId: v2OrderId,
              calculationId: calculation.id,
              generation: 1,
              kind: 'produce_all',
              inputFingerprint: calculation.inputFingerprint,
              sourceInventoryEpoch: 0n,
              expectedRollCount: 1,
              actorKind: 'system',
              systemActorKey: 'warehouse_coverage_engine',
            },
          });

          await tx.warehouseRoll.createMany({
            data: [
              {
                id: v1RollId,
                rollCode: 'TASK1-VERSIONED-V1-ROLL',
                ownerCounterpartyId: counterpartyId,
                reservedForOrderId: v1OrderId,
                warehouseStatus: 'received',
              },
              {
                id: v2RollId,
                rollCode: 'TASK1-VERSIONED-V2-ROLL',
                ownerCounterpartyId: counterpartyId,
                producedForOrderId: v2OrderId,
                producedForPositionId: v2PositionId,
                producedByCoverageDecisionId: productionDecisionId,
                warehouseStatus: 'received',
              },
              {
                id: mixedRollId,
                rollCode: 'TASK1-VERSIONED-MIXED-ROLL',
                ownerCounterpartyId: counterpartyId,
                producedForOrderId: mixedOrderId,
                producedForPositionId: mixedPositionId,
                warehouseStatus: 'received',
              },
              {
                id: allocatedRollId,
                rollCode: 'TASK1-VERSIONED-ALLOCATED-ROLL',
                ownerCounterpartyId: counterpartyId,
                producedForStockOrderId: stockOrderId,
                reservedForOrderId: allocatedOrderId,
                reservedAt: new Date('2026-08-08T08:00:00.000Z'),
                warehouseStatus: 'received',
              },
              {
                id: corruptStockRollId,
                rollCode: 'TASK1-VERSIONED-CORRUPT-STOCK-ROLL',
                ownerCounterpartyId: counterpartyId,
                producedForStockOrderId: corruptStockOrderId,
                producedForOrderId: corruptTargetOrderId,
                warehouseStatus: 'received',
              },
            ],
          });

          const createFact = async (input: {
            id: string;
            rollId: string;
            rollCode: string;
            orderId: string;
            positionId: string;
            requestType: 'client_order' | 'stock_reserve';
            workflowVersion: 1 | 2;
          }) => {
            const spec = coverageSpec(
              input.rollCode,
              {
                id: input.orderId,
                orderNumber: input.orderId,
                requestType: input.requestType,
                warehouseCoverageWorkflowVersion: input.workflowVersion,
                shipmentStatus:
                  input.requestType === 'stock_reserve' ? 'not_applicable' : 'not_shipped',
                counterpartyId: input.requestType === 'client_order' ? counterpartyId : null,
                counterparty:
                  input.requestType === 'client_order'
                    ? { displayName: 'Task 1 versioned provenance counterparty' }
                    : null,
              },
              { sourcePositionId: input.positionId },
            );
            await tx.warehouseRollCoverageFact.create({
              data: {
                id: input.id,
                rollId: input.rollId,
                version: 1,
                source: 'migration_backfill',
                specVersion: 'warehouse-roll-coverage/v1',
                specFingerprint: fingerprintRollFact(spec as never),
                spec,
                sourceOrderId: input.orderId,
                sourcePositionId: input.positionId,
                actorKind: 'system',
                systemActorKey: 'warehouse_coverage_engine',
              },
            });
            await tx.warehouseRoll.update({
              where: { id: input.rollId },
              data: { currentCoverageFactId: input.id },
            });
          };

          await createFact({
            id: 'task1-versioned-provenance-v1-fact',
            rollId: v1RollId,
            rollCode: 'TASK1-VERSIONED-V1-ROLL',
            orderId: v1OrderId,
            positionId: v1PositionId,
            requestType: 'client_order',
            workflowVersion: 1,
          });
          await createFact({
            id: 'task1-versioned-provenance-v2-fact',
            rollId: v2RollId,
            rollCode: 'TASK1-VERSIONED-V2-ROLL',
            orderId: v2OrderId,
            positionId: v2PositionId,
            requestType: 'client_order',
            workflowVersion: 2,
          });
          await createFact({
            id: 'task1-versioned-provenance-mixed-fact',
            rollId: mixedRollId,
            rollCode: 'TASK1-VERSIONED-MIXED-ROLL',
            orderId: mixedOrderId,
            positionId: mixedPositionId,
            requestType: 'client_order',
            workflowVersion: 2,
          });
          await createFact({
            id: 'task1-versioned-provenance-allocated-fact',
            rollId: allocatedRollId,
            rollCode: 'TASK1-VERSIONED-ALLOCATED-ROLL',
            orderId: stockOrderId,
            positionId: stockPositionId,
            requestType: 'stock_reserve',
            workflowVersion: 1,
          });
          await createFact({
            id: 'task1-versioned-provenance-corrupt-stock-fact',
            rollId: corruptStockRollId,
            rollCode: 'TASK1-VERSIONED-CORRUPT-STOCK-ROLL',
            orderId: corruptStockOrderId,
            positionId: corruptStockPositionId,
            requestType: 'stock_reserve',
            workflowVersion: 1,
          });

          const service = new WarehouseBusinessProjectionService(tx as never);
          const visible = await service.list({ page: 1, pageSize: 50 });
          expect(visible.total).toBe(3);
          expect(visible.items.map(({ id }) => id).sort()).toEqual(
            [v1OrderId, v2OrderId, allocatedOrderId].sort(),
          );

          await tx.commercialOrder.updateMany({
            where: { id: { in: [v1OrderId, v2OrderId, allocatedOrderId] } },
            data: { shipmentStatus: 'shipped' },
          });
          await expect(service.list({ page: 1, pageSize: 50 })).resolves.toEqual({
            items: [],
            page: 1,
            pageSize: 50,
            total: 0,
          });

          throw new RollbackFixture();
        },
        { timeout: 30_000 },
      );
      throw new Error('PostgreSQL fixture transaction unexpectedly committed');
    } catch (error) {
      if (!(error instanceof RollbackFixture)) throw error;
    }
  });
});
