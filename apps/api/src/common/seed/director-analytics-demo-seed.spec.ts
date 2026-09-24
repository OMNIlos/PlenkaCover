import {
  assertDirectorAnalyticsLocalDatabase,
  seedDirectorAnalyticsDemo,
} from './director-analytics-demo-seed';

describe('assertDirectorAnalyticsLocalDatabase', () => {
  it.each([
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_director',
    'postgres://preview:p%40ss@127.0.0.1:5432/plenka?schema=local_graph_20260724',
  ])('accepts an isolated localhost PostgreSQL schema: %s', (databaseUrl) => {
    expect(() => assertDirectorAnalyticsLocalDatabase(databaseUrl)).not.toThrow();
  });

  it.each([
    'mysql://preview:secret@localhost:5432/plenka?schema=local_graph_director',
    'postgresql://preview:secret@production.example/plenka?schema=local_graph_director',
    'postgresql://preview:secret@localhost.evil.example/plenka?schema=local_graph_director',
    'postgresql://localhost@production.example/plenka?schema=local_graph_director',
    'postgresql://preview:secret@localhost:5432/plenka',
    'postgresql://preview:secret@localhost:5432/plenka?schema=public',
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_DIRECTOR',
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_director%2Cpublic',
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_director&schema=public',
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_director%26schema%3Dpublic',
    'postgresql://preview:secret@localhost:5432/plenka?schema=local_graph_director&options=-csearch_path%3Dpublic',
    'not a database url',
  ])('rejects unsafe or ambiguous database URLs: %s', (databaseUrl) => {
    expect(() => assertDirectorAnalyticsLocalDatabase(databaseUrl)).toThrow(
      'DIRECTOR_PREVIEW_DATABASE_URL must target',
    );
  });
});

describe('seedDirectorAnalyticsDemo', () => {
  it('rejects a date that would mislabel the fixed boundary dataset', async () => {
    await expect(seedDirectorAnalyticsDemo({} as never, '2026-07-23')).rejects.toThrow(
      'fixed to asOfDate 2026-07-24',
    );
  });

  it('is create-only and idempotent with the exact deterministic application graph', async () => {
    const rows = new Map<string, Map<string, Record<string, unknown>>>();
    const createCalls: Array<{ model: string; data: Record<string, unknown> }> = [];
    const models = [
      'user',
      'counterparty',
      'commercialOrder',
      'commercialOrderPosition',
      'productionOrder',
      'rollDispatchItem',
      'operatorRollLine',
      'post',
      'deviceRuntime',
      'shift',
      'operatorPostSession',
      'operatorRollOperation',
      'weightCapture',
      'defectRecord',
      'bigBagUnit',
      'shiftBagUsage',
      'domainEvent',
    ] as const;

    const prisma = Object.fromEntries(
      models.map((model) => {
        const records = new Map<string, Record<string, unknown>>();
        rows.set(model, records);
        return [
          model,
          {
            findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
              const [field, value] = Object.entries(where)[0] ?? [];
              return [...records.values()].find((record) => record[field] === value) ?? null;
            }),
            create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
              const row = { ...data };
              records.set(String(row.id), row);
              createCalls.push({ model, data: row });
              return row;
            }),
          },
        ];
      }),
    );

    await seedDirectorAnalyticsDemo(prisma as never, '2026-07-24');
    const firstCreateCount = createCalls.length;
    await seedDirectorAnalyticsDemo(prisma as never, '2026-07-24');

    expect(createCalls).toHaveLength(firstCreateCount);
    expect(Object.keys(prisma).every((model) => !('update' in prisma[model]))).toBe(true);
    expect(Object.keys(prisma).every((model) => !('delete' in prisma[model]))).toBe(true);
    expect(Object.keys(prisma).every((model) => !('upsert' in prisma[model]))).toBe(true);

    const orders = [...(rows.get('commercialOrder')?.values() ?? [])];
    const promotionEvents = [...(rows.get('domainEvent')?.values() ?? [])].filter(
      ({ type }) => type === 'audit:commercial_draft_promoted',
    );
    const promotionByOrder = new Map(
      promotionEvents.map(({ objectId, createdAt }) => [objectId, createdAt as Date]),
    );
    const applicationGraph = orders
      .filter(({ id }) => String(id).startsWith('LOCAL-GRAPH-APP-'))
      .map(({ id, createdAt, requestType, commercialStage, delegationMarker, draftedAt }) => {
        const submittedDate = (promotionByOrder.get(id) ?? (createdAt as Date))
          .toISOString()
          .slice(0, 10);
        const mode =
          commercialStage === 'draft'
            ? 'draft'
            : delegationMarker
              ? 'delegated'
              : draftedAt
                ? 'promoted'
                : (createdAt as Date).toISOString().slice(0, 10) === '2026-01-23'
                  ? 'outside'
                  : 'direct';
        return [submittedDate, String(requestType), mode] as const;
      });
    expect(applicationGraph).toEqual([
      ['2026-07-24', 'client_order', 'direct'],
      ['2026-07-20', 'client_order', 'promoted'],
      ['2026-07-19', 'client_order', 'delegated'],
      ['2026-07-18', 'stock_reserve', 'direct'],
      ['2026-07-17', 'client_order', 'direct'],
      ['2026-06-25', 'stock_reserve', 'direct'],
      ['2026-06-24', 'client_order', 'direct'],
      ['2026-04-24', 'stock_reserve', 'direct'],
      ['2026-04-23', 'client_order', 'direct'],
      ['2026-01-24', 'stock_reserve', 'direct'],
      ['2026-01-23', 'client_order', 'outside'],
      ['2026-07-24', 'client_order', 'draft'],
    ]);
    expect(
      ['2026-07-18', '2026-06-25', '2026-04-24', '2026-01-24'].map(
        (fromDate) =>
          applicationGraph.filter(
            ([submittedDate, _requestType, mode]) => submittedDate >= fromDate && mode !== 'draft',
          ).length,
      ),
    ).toEqual([4, 6, 8, 10]);
    expect(orders.find(({ id }) => id === 'LOCAL-GRAPH-APP-02')?.createdAt).toEqual(
      new Date('2025-12-01T09:00:00.000Z'),
    );
    expect(promotionEvents).toEqual([
      expect.objectContaining({
        objectId: 'LOCAL-GRAPH-APP-02',
        createdAt: new Date('2026-07-20T09:00:00.000Z'),
      }),
    ]);

    const lines = [...(rows.get('operatorRollLine')?.values() ?? [])];
    const operations = [...(rows.get('operatorRollOperation')?.values() ?? [])];
    const captures = [...(rows.get('weightCapture')?.values() ?? [])];
    const defects = [...(rows.get('defectRecord')?.values() ?? [])];
    const usages = [...(rows.get('shiftBagUsage')?.values() ?? [])];
    expect(lines.map(({ planKg }) => planKg)).toEqual(expect.arrayContaining([40, 40, 40, null]));
    expect(captures.filter(({ kind }) => kind === 'roll').map(({ netKg }) => netKg)).toEqual(
      expect.arrayContaining([40, 45, 37, 42, 44, 41, 43]),
    );
    expect(captures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'LOCAL-GRAPH-CAPTURE-REWEIGH',
          supersedesCaptureId: 'LOCAL-GRAPH-CAPTURE-REWEIGH-ROOT',
          actorId: 'LOCAL-GRAPH-USER-OP-2',
          postSessionId: 'LOCAL-GRAPH-SESSION-03',
        }),
        expect.objectContaining({
          id: 'LOCAL-GRAPH-CAPTURE-MISSING-ACTOR',
          actorId: null,
          postSessionId: null,
          operationId: null,
        }),
      ]),
    );
    expect(captures.filter(({ kind }) => kind === 'spool')).toHaveLength(6);
    expect(operations).not.toHaveLength(0);
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'roll_weight',
          status: 'succeeded',
          attempt: 1,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        expect.objectContaining({
          action: 'roll_reweigh',
          status: 'succeeded',
          attempt: 1,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      ]),
    );
    expect(
      operations.every(
        ({ action, status, attempt, leaseToken, leaseExpiresAt }) =>
          ['roll_weight', 'roll_reweigh'].includes(String(action)) &&
          status === 'succeeded' &&
          attempt === 1 &&
          leaseToken === null &&
          leaseExpiresAt === null,
      ),
    ).toBe(true);
    expect(defects).toHaveLength(3);
    expect(
      defects.filter(({ operatorRollLineId }) => operatorRollLineId === 'LOCAL-GRAPH-LINE-02'),
    ).toHaveLength(2);
    expect(defects.filter(({ weightCaptureId }) => weightCaptureId === null)).toHaveLength(1);
    expect(usages.map(({ startKg, endKg }) => Number(startKg) - Number(endKg))).toEqual(
      expect.arrayContaining([128, 90, -5]),
    );
    expect(usages.some(({ endKg, closedAt }) => endKg === null && closedAt === null)).toBe(true);
  });
});
