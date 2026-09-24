import { parseDirectorAnalyticsRange } from './director-analytics.time';
import { DirectorPayrollFactsService } from './director-payroll-facts.service';

const GENERATED_AT = new Date('2026-07-25T12:00:00.000Z');
const RANGE = parseDirectorAnalyticsRange({
  from: '2026-07-10',
  to: '2026-07-15',
  bucket: 'day',
});

type CaptureOverrides = {
  lineId?: string;
  netKg?: number | null;
  createdAt?: Date;
  supersedesCaptureId?: string | null;
  postSession?: ReturnType<typeof operatorSession> | null;
  postSessionId?: string | null;
  operation?: {
    status: string;
    actor: { id: string; displayName: string };
  } | null;
  rawMaterialId?: string | null;
  characteristicsSnapshot?: unknown;
  defects?: Array<{ id: string; createdAt: Date }>;
  rollId?: string;
  rollCode?: string;
};

function operatorSession(
  overrides: {
    id?: string;
    role?: string;
    shiftId?: string;
    postId?: string;
    operatorId?: string;
    machineAssignments?: Array<{
      id: string;
      operatorId: string;
      postId: string;
      status: string;
    }>;
  } = {},
) {
  const shiftId = overrides.shiftId ?? 'shift-1';
  const postId = overrides.postId ?? 'post-urp';
  const operatorId = overrides.operatorId ?? 'operator-original';
  return {
    id: overrides.id ?? 'session-original',
    operator: {
      id: operatorId,
      displayName: 'Оригинальный оператор',
      role: overrides.role ?? 'operator',
    },
    post: { id: postId, code: 'URP', name: 'УРП' },
    shift: {
      id: shiftId,
      label: 'Смена 1',
      status: 'closed',
      plannedStartAt: new Date('2026-07-10T06:00:00.000Z'),
      plannedEndAt: new Date('2026-07-10T18:00:00.000Z'),
      endedAt: new Date('2026-07-10T18:00:00.000Z'),
      machineAssignments: overrides.machineAssignments ?? [],
    },
  };
}

function capture(id: string, overrides: CaptureOverrides = {}) {
  const lineId = overrides.lineId ?? 'line-1';
  const rollId = overrides.rollId ?? `roll-${lineId}`;
  const session =
    Object.hasOwn(overrides, 'postSession') && overrides.postSession !== undefined
      ? overrides.postSession
      : operatorSession();

  return {
    id,
    operatorRollLineId: lineId,
    kind: 'roll',
    stable: true,
    netKg: Object.hasOwn(overrides, 'netKg') ? (overrides.netKg ?? null) : 40,
    postSessionId:
      overrides.postSessionId === undefined ? (session?.id ?? null) : overrides.postSessionId,
    supersedesCaptureId: overrides.supersedesCaptureId ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-07-10T09:00:00.000Z'),
    postSession: session,
    operation: overrides.operation ?? null,
    line: {
      id: lineId,
      step: 'warehouse',
      defects: overrides.defects ?? [],
      rollDispatchItem: {
        id: rollId,
        rollCode: overrides.rollCode ?? `CODE-${lineId}`,
        status: 'done',
        rawMaterialId: overrides.rawMaterialId ?? null,
        filmType: 'ПВД',
        characteristicsSnapshot: overrides.characteristicsSnapshot ?? null,
        productionOrder: {
          commercialOrder: {
            id: `order-${lineId}`,
            orderNumber: `ORDER-${lineId}`,
            counterparty: { legalName: `ООО ${lineId}` },
          },
        },
      },
    },
    rawPayload: { mustNotEscape: true },
    payload: { mustNotEscape: true },
  };
}

function prismaFixture(input: {
  periodLineIds: string[];
  periodChains: ReturnType<typeof capture>[];
  unionChains?: ReturnType<typeof capture>[];
  stocks?: Array<{
    materialId: string;
    rawMaterialDefinition: { id: string; kind: string } | null;
  }>;
  definitions?: Array<{ id: string; kind: string }>;
  sessions?: unknown[];
}) {
  let chainLoad = 0;
  const weightCapture = {
    findMany: jest.fn(
      async (query: {
        distinct?: unknown;
        select?: unknown;
        where: {
          postSession?: { shiftId?: { in: string[] } };
          operatorRollLineId?: { in: string[] };
          createdAt?: { lte?: Date };
        };
      }) => {
        if (query.distinct !== undefined) {
          if (query.where.postSession === undefined) {
            return input.periodLineIds.map((operatorRollLineId) => ({ operatorRollLineId }));
          }
          const requestedShiftIds = query.where.postSession.shiftId?.in ?? [];
          const generatedAt = query.where.createdAt?.lte;
          const lineIds = [
            ...new Set(
              (input.unionChains ?? input.periodChains)
                .filter(
                  (row) =>
                    row.supersedesCaptureId === null &&
                    row.postSession?.shift !== null &&
                    requestedShiftIds.includes(row.postSession?.shift.id ?? '') &&
                    (generatedAt === undefined || row.createdAt <= generatedAt),
                )
                .map(({ operatorRollLineId }) => operatorRollLineId),
            ),
          ];
          return lineIds.map((operatorRollLineId) => ({ operatorRollLineId }));
        }
        chainLoad += 1;
        const rows =
          chainLoad === 1 ? input.periodChains : (input.unionChains ?? input.periodChains);
        const requestedLineIds = query.where.operatorRollLineId?.in;
        return requestedLineIds === undefined
          ? rows
          : rows.filter(({ operatorRollLineId }) => requestedLineIds.includes(operatorRollLineId));
      },
    ),
  };
  const rawMaterialStock = {
    findMany: jest.fn(
      async ({ where }: { select?: unknown; where: { materialId: { in: string[] } } }) =>
        (input.stocks ?? []).filter(({ materialId }) => where.materialId.in.includes(materialId)),
    ),
  };
  const rawMaterialDefinition = {
    findMany: jest.fn(async ({ where }: { select?: unknown; where: { id: { in: string[] } } }) =>
      (input.definitions ?? []).filter(({ id }) => where.id.in.includes(id)),
    ),
  };
  const operatorPostSession = {
    findMany: jest.fn(async () => input.sessions ?? []),
  };
  const prisma = {
    weightCapture,
    rawMaterialStock,
    rawMaterialDefinition,
    operatorPostSession,
  };
  return {
    prisma,
    service: new DirectorPayrollFactsService(prisma as never),
  };
}

function allSelects(prisma: ReturnType<typeof prismaFixture>['prisma']): unknown[] {
  return [
    ...prisma.weightCapture.findMany.mock.calls,
    ...prisma.rawMaterialStock.findMany.mock.calls,
    ...prisma.rawMaterialDefinition.findMany.mock.calls,
  ].map(([query]) => (query as { select?: unknown }).select);
}

describe('DirectorPayrollFactsService', () => {
  it('scopes closing period facts to the exact actor and root session but keeps whole shift-post thresholds', async () => {
    const own = capture('own-root', {
      lineId: 'line-own',
      postSession: operatorSession({
        id: 'session-exact',
        operatorId: 'operator-exact',
      }),
    });
    const peer = capture('peer-root', {
      lineId: 'line-peer',
      postSession: operatorSession({ id: 'session-peer', operatorId: 'operator-peer' }),
    });
    const otherPost = capture('other-post-root', {
      lineId: 'line-other-post',
      postSession: operatorSession({
        id: 'session-other-post',
        operatorId: 'operator-other-post',
        postId: 'post-other',
      }),
    });
    const otherShift = capture('other-shift-root', {
      lineId: 'line-other-shift',
      postSession: operatorSession({
        id: 'session-other-shift',
        operatorId: 'operator-other-shift',
        shiftId: 'shift-other',
      }),
    });
    const fixture = prismaFixture({
      periodLineIds: ['line-own', 'line-peer'],
      periodChains: [peer, own],
      unionChains: [otherShift, otherPost, peer, own],
    });
    const service = new DirectorPayrollFactsService({} as never) as any;

    const snapshot = await service.loadForOperatorRootSession(
      {
        operatorId: 'operator-exact',
        rootSessionId: 'session-exact',
        shiftId: 'shift-1',
        postId: 'post-urp',
      },
      GENERATED_AT,
      fixture.prisma,
    );

    expect(snapshot.periodFacts.map(({ lineId }: { lineId: string }) => lineId)).toEqual([
      'line-own',
    ]);
    expect(snapshot.thresholdFacts.map(({ lineId }: { lineId: string }) => lineId)).toEqual([
      'line-own',
      'line-peer',
    ]);
    expect(fixture.prisma.weightCapture.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ postSessionId: 'session-exact' }),
      }),
    );
  });

  it.each([['forward'], ['reversed']] as const)(
    'selects the sole completed exact assignment independent of query order: %s',
    async (order) => {
      const candidates = [
        {
          id: 'assignment-planned',
          operatorId: 'operator-original',
          postId: 'post-urp',
          status: 'planned',
        },
        {
          id: 'assignment-completed',
          operatorId: 'operator-original',
          postId: 'post-urp',
          status: 'completed',
        },
        {
          id: 'assignment-cancelled',
          operatorId: 'operator-original',
          postId: 'post-urp',
          status: 'cancelled',
        },
      ];
      const root = capture('assignment-root', {
        postSession: operatorSession({
          machineAssignments: order === 'forward' ? candidates : [...candidates].reverse(),
        }),
      });
      const { service } = prismaFixture({
        periodLineIds: ['line-1'],
        periodChains: [root],
        unionChains: [root],
      });

      const snapshot = await service.load(RANGE, GENERATED_AT);
      expect(snapshot.periodFacts[0]?.machineAssignment).toEqual({
        id: 'assignment-completed',
        status: 'completed',
      });
    },
  );

  it('fails closed when more than one exact completed assignment exists', async () => {
    const root = capture('ambiguous-assignment-root', {
      postSession: operatorSession({
        machineAssignments: ['a', 'b'].map((id) => ({
          id,
          operatorId: 'operator-original',
          postId: 'post-urp',
          status: 'completed',
        })),
      }),
    });
    const { service } = prismaFixture({
      periodLineIds: ['line-1'],
      periodChains: [root],
      unionChains: [root],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);
    expect(snapshot.periodFacts[0]?.machineAssignment).toBeNull();
  });

  it('takes canonical leaf weight while retaining root production and operator provenance', async () => {
    const rootCreatedAt = new Date('2026-07-10T09:00:00.000Z');
    const root = capture('capture-root', {
      netKg: 40,
      createdAt: rootCreatedAt,
    });
    const leaf = capture('capture-leaf', {
      netKg: 45,
      supersedesCaptureId: root.id,
      createdAt: new Date('2026-07-20T09:00:00.000Z'),
      postSession: operatorSession({
        id: 'warehouse-session',
        operatorId: 'warehouse-actor',
      }),
    });
    const { service } = prismaFixture({
      periodLineIds: ['line-1', 'line-1'],
      periodChains: [leaf, root],
      unionChains: [leaf, root],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);

    expect(snapshot.periodFacts).toEqual([
      expect.objectContaining({
        lineId: 'line-1',
        rollId: 'roll-line-1',
        actualKg: 45,
        producedAt: rootCreatedAt,
        operatorId: 'operator-original',
        operatorName: 'Оригинальный оператор',
        rootSessionId: 'session-original',
        shift: expect.objectContaining({ id: 'shift-1' }),
        post: expect.objectContaining({ id: 'post-urp', name: 'УРП' }),
      }),
    ]);
    expect(snapshot.periodFacts).toHaveLength(1);
    expect(snapshot.thresholdFacts).toHaveLength(1);
  });

  it('uses canonical roll output instead of mismatching Big-Bag consumption for a closed session', async () => {
    const rolls = [47.1, 47.2, 47.3, 47.45].map((netKg, index) =>
      capture(`capture-${index + 1}`, {
        lineId: `line-${index + 1}`,
        netKg,
        characteristicsSnapshot: { birka: index % 2 === 0 ? 'ГОСТ103' : 'i' },
        postSession: operatorSession({ id: 'session-original' }),
      }),
    );
    rolls.push(
      capture('capture-defect', {
        lineId: 'line-defect',
        netKg: 12,
        postSession: operatorSession({ id: 'session-original' }),
        defects: [{ id: 'defect-1', createdAt: new Date('2026-07-10T10:00:00.000Z') }],
      }),
    );
    const endedAt = new Date('2026-07-10T18:00:00.000Z');
    const { service } = prismaFixture({
      periodLineIds: rolls.map(({ operatorRollLineId }) => operatorRollLineId),
      periodChains: rolls,
      unionChains: rolls,
      sessions: [
        {
          id: 'session-original',
          status: 'closed',
          startedAt: new Date('2026-07-10T06:00:00.000Z'),
          endedAt,
          operator: {
            id: 'operator-original',
            displayName: 'Оригинальный оператор',
            role: 'operator',
          },
          post: { id: 'post-urp', code: 'URP', name: 'УРП' },
          shift: { id: 'shift-1', label: 'Смена 1', status: 'closed' },
          bagUsages: [
            {
              startKg: 55,
              endKg: 0,
              closedAt: endedAt,
              releasedReason: null,
              bigBag: { material: 'ПВД Айка' },
              episodes: [
                {
                  sequence: 1,
                  startKg: 55,
                  endKg: 0,
                  closeKind: 'shift_closed',
                  closedAt: endedAt,
                },
              ],
            },
          ],
        },
      ],
    });

    const snapshot = await service.loadForOperatorRootSession(
      {
        operatorId: 'operator-original',
        rootSessionId: 'session-original',
        shiftId: 'shift-1',
        postId: 'post-urp',
      },
      GENERATED_AT,
    );

    expect(snapshot.sessionFacts).toEqual([
      expect.objectContaining({
        sessionId: 'session-original',
        processedKg: 189.05,
        materialNames: ['ПВД Айка'],
        rolls: [
          { grams: 47_100, birka: 'ГОСТ103' },
          { grams: 47_200, birka: 'i' },
          { grams: 47_300, birka: 'ГОСТ103' },
          { grams: 47_450, birka: 'i' },
        ],
      }),
    ]);
  });

  it('expands complete shifts and projects materials and generated-time-safe defects', async () => {
    const period = capture('period-root', {
      lineId: 'line-period',
      rollId: 'roll-z',
      createdAt: new Date('2026-07-11T09:00:00.000Z'),
      rawMaterialId: 'stock-primary',
      defects: [{ id: 'late-defect', createdAt: new Date('2026-07-26T09:00:00.000Z') }],
    });
    const malformed = capture('malformed-root', {
      lineId: 'line-malformed',
      rollId: 'roll-a',
      createdAt: new Date('2026-07-12T09:00:00.000Z'),
      characteristicsSnapshot: { recipe: { ingredients: 'invalid' } },
      defects: [{ id: 'defect-1', createdAt: new Date('2026-07-12T10:00:00.000Z') }],
    });
    const outside = capture('outside-root', {
      lineId: 'line-outside',
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      characteristicsSnapshot: {
        recipe: {
          ingredients: [
            { rawMaterialDefinitionId: 'definition-secondary' },
            { rawMaterialDefinitionId: 'definition-additive' },
          ],
        },
      },
    });
    const future = capture('future-root', {
      lineId: 'line-future',
      createdAt: new Date('2026-07-26T09:00:00.000Z'),
    });
    const { prisma, service } = prismaFixture({
      periodLineIds: ['line-period', 'line-malformed', 'line-period'],
      periodChains: [period, malformed],
      unionChains: [future, malformed, outside, period],
      stocks: [
        {
          materialId: 'stock-primary',
          rawMaterialDefinition: { id: 'rmd-base-primary', kind: 'base' },
        },
      ],
      definitions: [
        { id: 'definition-secondary', kind: 'secondary' },
        { id: 'definition-additive', kind: 'custom' },
      ],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);

    expect(snapshot.periodFacts.map(({ lineId }) => lineId)).toEqual([
      'line-malformed',
      'line-period',
    ]);
    expect(snapshot.thresholdFacts.map(({ lineId }) => lineId)).toEqual([
      'line-malformed',
      'line-period',
      'line-outside',
    ]);
    expect(snapshot.periodFacts[0]).toMatchObject({
      hasDefect: true,
      materialKinds: [],
    });
    expect(snapshot.periodFacts[1]).toMatchObject({
      hasDefect: false,
      materialKinds: ['primary'],
    });
    expect(snapshot.thresholdFacts[2]?.materialKinds).toEqual(['secondary']);
    expect(JSON.stringify(snapshot)).not.toMatch(/rawPayload|deviceFrames?|credentials?/i);
    expect(JSON.stringify(allSelects(prisma))).not.toMatch(
      /rawPayload|deviceFrames?|credentials?|\binn\b|billing/i,
    );
    for (const [query] of prisma.weightCapture.findMany.mock.calls) {
      expect(query.where.createdAt).toEqual(expect.objectContaining({ lte: GENERATED_AT }));
    }
  });

  it('adapts only controlled base identities or explicit semantic kinds for payroll', async () => {
    const recipeCapture = (lineId: string, definitionIds: string[]) =>
      capture(lineId, {
        lineId,
        characteristicsSnapshot: {
          recipe: {
            ingredients: definitionIds.map((rawMaterialDefinitionId) => ({
              rawMaterialDefinitionId,
            })),
          },
        },
      });
    const rows = [
      recipeCapture('line-canonical-secondary', ['rmd-base-secondary', 'definition-additive']),
      recipeCapture('line-mixed', ['rmd-base-primary', 'rmd-base-secondary']),
      recipeCapture('line-ignored', [
        'rmd-base-aika',
        'rmd-base-primary-copy',
        'definition-named-primary',
      ]),
    ];
    const { service } = prismaFixture({
      periodLineIds: rows.map(({ operatorRollLineId }) => operatorRollLineId),
      periodChains: rows,
      unionChains: rows,
      definitions: [
        { id: 'rmd-base-primary', kind: 'base' },
        { id: 'rmd-base-secondary', kind: 'base' },
        { id: 'definition-additive', kind: 'custom' },
        { id: 'rmd-base-aika', kind: 'base' },
        { id: 'rmd-base-primary-copy', kind: 'base' },
        { id: 'definition-named-primary', kind: 'custom' },
      ],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);
    const materialKindsByLine = new Map(
      snapshot.periodFacts.map(({ lineId, materialKinds }) => [lineId, materialKinds]),
    );

    expect(materialKindsByLine).toEqual(
      new Map([
        ['line-canonical-secondary', ['secondary']],
        ['line-mixed', ['primary', 'secondary']],
        ['line-ignored', []],
      ]),
    );
  });

  it('excludes a union candidate whose resolved canonical root belongs to an unrelated shift', async () => {
    const relevant = capture('relevant-root', {
      lineId: 'line-relevant',
      createdAt: new Date('2026-07-11T09:00:00.000Z'),
      rawMaterialId: 'stock-relevant',
      characteristicsSnapshot: {
        recipe: {
          ingredients: [{ rawMaterialDefinitionId: 'definition-relevant' }],
        },
      },
    });
    const unrelatedCanonical = capture('unrelated-canonical-root', {
      lineId: 'line-duplicate',
      createdAt: new Date('2026-07-08T09:00:00.000Z'),
      postSession: operatorSession({ id: 'session-unrelated', shiftId: 'shift-unrelated' }),
      rawMaterialId: 'stock-unrelated',
      characteristicsSnapshot: {
        recipe: {
          ingredients: [{ rawMaterialDefinitionId: 'definition-unrelated' }],
        },
      },
    });
    const relevantDuplicate = capture('relevant-duplicate-root', {
      lineId: 'line-duplicate',
      createdAt: new Date('2026-07-12T09:00:00.000Z'),
    });
    const unrelatedShiftOnly = capture('unrelated-shift-only', {
      lineId: 'line-unrelated-only',
      createdAt: new Date('2026-07-09T09:00:00.000Z'),
      postSession: operatorSession({
        id: 'session-unrelated-only',
        shiftId: 'shift-unrelated',
      }),
    });
    const { prisma, service } = prismaFixture({
      periodLineIds: ['line-relevant', 'line-duplicate'],
      periodChains: [relevantDuplicate, unrelatedCanonical, relevant],
      unionChains: [unrelatedShiftOnly, relevantDuplicate, unrelatedCanonical, relevant],
      stocks: [
        {
          materialId: 'stock-relevant',
          rawMaterialDefinition: { id: 'stock-definition-relevant', kind: 'primary' },
        },
        {
          materialId: 'stock-unrelated',
          rawMaterialDefinition: { id: 'stock-definition-unrelated', kind: 'secondary' },
        },
      ],
      definitions: [
        { id: 'definition-relevant', kind: 'additive' },
        { id: 'definition-unrelated', kind: 'secondary' },
      ],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);

    expect(snapshot.thresholdFacts.map(({ lineId }) => lineId)).toEqual(['line-relevant']);
    const shiftCandidateQuery = prisma.weightCapture.findMany.mock.calls.find(
      ([query]) => query.where.postSession !== undefined,
    )?.[0];
    expect(shiftCandidateQuery?.where.postSession?.shiftId?.in).toEqual(['shift-1']);
    expect(
      prisma.rawMaterialStock.findMany.mock.calls.flatMap(([query]) => query.where.materialId.in),
    ).toEqual(['stock-relevant']);
    expect(
      prisma.rawMaterialDefinition.findMany.mock.calls.flatMap(([query]) => query.where.id.in),
    ).toEqual(['definition-relevant']);
  });

  it('uses only an operator session identity and otherwise falls back to a successful operation', async () => {
    const root = capture('fallback-root', {
      postSession: operatorSession({ role: 'director' }),
      operation: {
        status: 'succeeded',
        actor: { id: 'operation-actor', displayName: 'Актор операции' },
      },
    });
    const noPlacement = capture('fallback-without-placement', {
      lineId: 'line-no-placement',
      postSession: null,
      postSessionId: null,
      operation: {
        status: 'succeeded',
        actor: { id: 'legacy-operator', displayName: 'Legacy Operator' },
      },
    });
    const { service } = prismaFixture({
      periodLineIds: ['line-1', 'line-no-placement'],
      periodChains: [root, noPlacement],
      unionChains: [root, noPlacement],
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);
    const byLine = new Map(snapshot.periodFacts.map((fact) => [fact.lineId, fact]));

    expect(byLine.get('line-1')).toMatchObject({
      operatorId: 'operation-actor',
      operatorName: 'Актор операции',
      rootSessionId: 'session-original',
    });
    expect(byLine.get('line-no-placement')).toMatchObject({
      operatorId: 'legacy-operator',
      operatorName: 'Legacy Operator',
      rootSessionId: null,
      shift: null,
      post: null,
    });
  });

  it('rejects non-positive and non-finite leaves and ignores rootless malformed chains', async () => {
    const zero = capture('zero', { lineId: 'line-zero', netKg: 0 });
    const negative = capture('negative', { lineId: 'line-negative', netKg: -1 });
    const infinite = capture('infinite', {
      lineId: 'line-infinite',
      netKg: Number.POSITIVE_INFINITY,
    });
    const orphan = capture('orphan', {
      lineId: 'line-orphan',
      supersedesCaptureId: 'missing',
    });
    const cycleA = capture('cycle-a', {
      lineId: 'line-cycle',
      supersedesCaptureId: 'cycle-b',
    });
    const cycleB = capture('cycle-b', {
      lineId: 'line-cycle',
      supersedesCaptureId: 'cycle-a',
    });
    const rows = [zero, negative, infinite, orphan, cycleA, cycleB];
    const { service } = prismaFixture({
      periodLineIds: rows.map(({ operatorRollLineId }) => operatorRollLineId),
      periodChains: rows,
      unionChains: rows,
    });

    await expect(service.load(RANGE, GENERATED_AT)).resolves.toEqual({
      periodFacts: [],
      thresholdFacts: [],
      sessionFacts: [],
    });
  });

  it('queries material identifiers in chunks of at most one thousand', async () => {
    const ingredients = Array.from({ length: 1_001 }, (_, index) => ({
      rawMaterialDefinitionId: `definition-${index}`,
    }));
    const definitions = ingredients.map(({ rawMaterialDefinitionId: id }) => ({
      id,
      kind: `kind-${id}`,
    }));
    const root = capture('many-materials', {
      characteristicsSnapshot: { recipe: { ingredients } },
    });
    const { prisma, service } = prismaFixture({
      periodLineIds: ['line-1'],
      periodChains: [root],
      unionChains: [root],
      definitions,
    });

    const snapshot = await service.load(RANGE, GENERATED_AT);

    expect(snapshot.periodFacts[0]?.materialKinds).toEqual([]);
    expect(
      prisma.rawMaterialDefinition.findMany.mock.calls.flatMap(([query]) => query.where.id.in),
    ).toHaveLength(1_001);
    for (const [query] of prisma.rawMaterialDefinition.findMany.mock.calls) {
      expect(query.where.id.in.length).toBeLessThanOrEqual(1_000);
    }
  });
});
