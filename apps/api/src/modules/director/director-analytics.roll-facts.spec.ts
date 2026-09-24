import {
  buildDirectorRollFacts,
  type DirectorRollFactSource,
} from './director-analytics.roll-facts';

const ROOT_AT = new Date('2026-07-20T09:00:00.000Z');
const REWEIGH_AT = new Date('2026-07-24T09:00:00.000Z');

function source(
  id: string,
  overrides: Partial<DirectorRollFactSource> = {},
): DirectorRollFactSource {
  const operatorRollLineId = overrides.operatorRollLineId ?? 'line-1';

  return {
    id,
    operatorRollLineId,
    kind: 'roll',
    stable: true,
    grossKg: 42,
    spoolKg: 2,
    netKg: 40,
    deviceId: 'scale-1',
    deviceStatus: 'ready',
    actorId: null,
    postSessionId: null,
    supersedesCaptureId: null,
    createdAt: ROOT_AT,
    postSession: null,
    operation: null,
    line: {
      id: operatorRollLineId,
      planKg: 40,
      rollDispatchItem: {
        id: `roll-${operatorRollLineId}`,
        rollCode: `ROLL-${operatorRollLineId}`,
        productionOrder: {
          commercialOrder: {
            id: `order-${operatorRollLineId}`,
            orderNumber: `ORD-${operatorRollLineId}`,
          },
        },
      },
    },
    ...overrides,
  };
}

function line(
  lineId: string,
  rollId: string,
  planKg: number | null = 40,
): DirectorRollFactSource['line'] {
  return {
    id: lineId,
    planKg,
    rollDispatchItem: {
      id: rollId,
      rollCode: `CODE-${rollId}`,
      productionOrder: {
        commercialOrder: {
          id: `order-${rollId}`,
          orderNumber: `ORDER-${rollId}`,
        },
      },
    },
  };
}

describe('buildDirectorRollFacts', () => {
  it('keeps production and producer on the root while taking actual weight from the leaf', () => {
    const spool = source('spool-1', {
      kind: 'spool',
      grossKg: 2.4,
      spoolKg: 2.4,
      netKg: null,
      createdAt: new Date('2026-07-20T08:55:00.000Z'),
    });
    const root = source('root-1', {
      spoolKg: 9.9,
      actorId: 'original-operator',
      postSessionId: 'original-session',
      postSession: {
        operator: { id: 'original-operator', displayName: 'Original Operator' },
      },
      operation: {
        status: 'succeeded',
        actor: { id: 'root-operation-actor', displayName: 'Root Operation Actor' },
      },
    });
    const leaf = source('leaf-1', {
      grossKg: 47,
      spoolKg: 2,
      netKg: 45,
      actorId: 'reweigh-operator',
      postSessionId: 'reweigh-session',
      supersedesCaptureId: root.id,
      createdAt: REWEIGH_AT,
      postSession: {
        operator: { id: 'reweigh-operator', displayName: 'Reweigh Operator' },
      },
      operation: {
        status: 'succeeded',
        actor: { id: 'reweigh-operator', displayName: 'Reweigh Operator' },
      },
    });

    const [fact] = buildDirectorRollFacts([leaf, spool, root]);

    expect(fact).toMatchObject({
      producedAt: ROOT_AT,
      actualCapturedAt: REWEIGH_AT,
      actualKg: 45,
      rootCaptureId: 'root-1',
      leafCaptureId: 'leaf-1',
      rootSessionId: 'original-session',
      operatorId: 'original-operator',
      operatorName: 'Original Operator',
      provenance: 'post_session',
      spoolTareKg: 2.4,
    });
  });

  it('falls back to the successful root operation actor', () => {
    const [fact] = buildDirectorRollFacts([
      source('root-operation-fallback', {
        actorId: 'legacy-capture-actor',
        operation: {
          status: 'succeeded',
          actor: { id: 'operation-actor', displayName: 'Operation Actor' },
        },
      }),
    ]);

    expect(fact).toMatchObject({
      operatorId: 'operation-actor',
      operatorName: 'Operation Actor',
      provenance: 'operation_actor',
    });
  });

  it('marks the producer missing when root provenance cannot identify one', () => {
    const [fact] = buildDirectorRollFacts([
      source('root-missing-actor', {
        actorId: 'unverified-capture-actor',
        operation: {
          status: 'failed',
          actor: { id: 'failed-operation-actor', displayName: 'Failed Operation Actor' },
        },
      }),
    ]);

    expect(fact).toMatchObject({
      operatorId: null,
      operatorName: null,
      provenance: 'actor_missing',
    });
  });

  it('gives missing plan precedence while preserving resolved actor fields', () => {
    const [fact] = buildDirectorRollFacts([
      source('root-missing-plan', {
        postSessionId: 'session-without-plan',
        postSession: {
          operator: { id: 'known-operator', displayName: 'Known Operator' },
        },
        line: line('line-1', 'roll-line-1', null),
      }),
    ]);

    expect(fact).toMatchObject({
      plannedKg: null,
      operatorId: 'known-operator',
      operatorName: 'Known Operator',
      provenance: 'plan_missing',
    });
  });

  it('uses the latest valid spool capture from the same line no later than production', () => {
    const root = source('root-with-spool-history');
    const [fact] = buildDirectorRollFacts([
      source('newest-other-line-spool', {
        operatorRollLineId: 'line-2',
        kind: 'spool',
        grossKg: 8.8,
        spoolKg: 8.8,
        netKg: null,
        createdAt: new Date('2026-07-20T08:59:00.000Z'),
        line: line('line-2', 'roll-line-2'),
      }),
      source('older-spool', {
        kind: 'spool',
        grossKg: 2.1,
        spoolKg: 2.1,
        netKg: null,
        createdAt: new Date('2026-07-20T08:50:00.000Z'),
      }),
      source('latest-spool', {
        kind: 'spool',
        grossKg: 2.4,
        spoolKg: 2.4,
        netKg: null,
        createdAt: new Date('2026-07-20T08:58:00.000Z'),
      }),
      root,
    ]);

    expect(fact.spoolTareKg).toBe(2.4);
  });

  it('uses corrected spool evidence captured before the canonical roll leaf', () => {
    const root = source('root-before-spool-correction');
    const leaf = source('leaf-after-spool-correction', {
      grossKg: 43.5,
      spoolKg: 2.5,
      netKg: 41,
      supersedesCaptureId: root.id,
      createdAt: REWEIGH_AT,
    });
    const [fact] = buildDirectorRollFacts([
      source('original-spool', {
        kind: 'spool',
        grossKg: 2,
        spoolKg: 2,
        netKg: null,
        createdAt: new Date('2026-07-20T08:55:00.000Z'),
      }),
      source('corrected-spool', {
        kind: 'spool',
        grossKg: 2.5,
        spoolKg: 2.5,
        netKg: null,
        createdAt: new Date('2026-07-21T09:00:00.000Z'),
      }),
      root,
      leaf,
    ]);

    expect(fact.spoolTareKg).toBe(2.5);
  });

  it('does not use spool evidence captured after the canonical roll leaf', () => {
    const root = source('root-with-later-spool');
    const leaf = source('leaf-before-later-spool', {
      supersedesCaptureId: root.id,
      createdAt: REWEIGH_AT,
    });
    const [fact] = buildDirectorRollFacts([
      source('spool-before-leaf', {
        kind: 'spool',
        grossKg: 2.4,
        spoolKg: 2.4,
        netKg: null,
        createdAt: new Date('2026-07-23T09:00:00.000Z'),
      }),
      source('spool-after-leaf', {
        kind: 'spool',
        grossKg: 9.9,
        spoolKg: 9.9,
        netKg: null,
        createdAt: new Date('2026-07-25T09:00:00.000Z'),
      }),
      root,
      leaf,
    ]);

    expect(fact.spoolTareKg).toBe(2.4);
  });

  it('excludes invalid and post-production spool values instead of using roll snapshots', () => {
    const root = source('root-without-valid-spool', { spoolKg: 7.7 });
    const [fact] = buildDirectorRollFacts([
      source('invalid-spool', {
        kind: 'spool',
        grossKg: 3.2,
        spoolKg: 3.2,
        netKg: null,
        deviceId: null,
        createdAt: new Date('2026-07-20T08:58:00.000Z'),
      }),
      source('future-spool', {
        kind: 'spool',
        grossKg: 4.2,
        spoolKg: 4.2,
        netKg: null,
        createdAt: new Date('2026-07-20T09:01:00.000Z'),
      }),
      root,
    ]);

    expect(fact.spoolTareKg).toBeNull();
  });

  it('sorts facts by producedAt descending and then rollId ascending', () => {
    const facts = buildDirectorRollFacts([
      source('same-time-z', {
        operatorRollLineId: 'line-z',
        line: line('line-z', 'roll-z'),
      }),
      source('older', {
        operatorRollLineId: 'line-old',
        createdAt: new Date('2026-07-19T09:00:00.000Z'),
        line: line('line-old', 'roll-old'),
      }),
      source('same-time-a', {
        operatorRollLineId: 'line-a',
        line: line('line-a', 'roll-a'),
      }),
      source('newer', {
        operatorRollLineId: 'line-new',
        createdAt: new Date('2026-07-21T09:00:00.000Z'),
        line: line('line-new', 'roll-new'),
      }),
    ]);

    expect(facts.map(({ rollId }) => rollId)).toEqual(['roll-new', 'roll-a', 'roll-z', 'roll-old']);
  });
});
