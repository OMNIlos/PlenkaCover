import { projectTraceabilityWeightFacts } from './director-traceability.service';

describe('director traceability weight projection', () => {
  it('lets the server owner mark one current measurement per roll and kind', () => {
    const facts = projectTraceabilityWeightFacts([
      {
        id: 'spool-old',
        operatorRollLineId: 'line-1',
        kind: 'spool',
        stable: true,
        deviceStatus: 'ready',
        grossKg: null,
        spoolKg: 1.8,
        netKg: 1.8,
        createdAt: new Date('2026-08-10T08:00:00.000Z'),
      },
      {
        id: 'spool-current',
        operatorRollLineId: 'line-1',
        kind: 'spool',
        stable: true,
        deviceStatus: 'ready',
        grossKg: null,
        spoolKg: 1.9,
        netKg: 1.9,
        createdAt: new Date('2026-08-10T09:00:00.000Z'),
      },
      {
        id: 'other-roll',
        operatorRollLineId: 'line-2',
        kind: 'spool',
        stable: true,
        deviceStatus: 'ready',
        grossKg: null,
        spoolKg: 2.1,
        netKg: 2.1,
        createdAt: new Date('2026-08-10T08:30:00.000Z'),
      },
      {
        id: 'unstable-newer',
        operatorRollLineId: 'line-1',
        kind: 'spool',
        stable: false,
        deviceStatus: 'ready',
        grossKg: null,
        spoolKg: 99,
        netKg: 99,
        createdAt: new Date('2026-08-10T10:00:00.000Z'),
      },
    ]);

    expect(
      facts.map(({ title, valueLabel, isCurrent }) => ({ title, valueLabel, isCurrent })),
    ).toEqual([
      { title: 'Текущий принятый вес шпули', valueLabel: '1,9 кг', isCurrent: true },
      { title: 'Текущий принятый вес шпули', valueLabel: '2,1 кг', isCurrent: true },
      { title: 'Предыдущее измерение шпули', valueLabel: '1,8 кг', isCurrent: false },
    ]);
  });
});
