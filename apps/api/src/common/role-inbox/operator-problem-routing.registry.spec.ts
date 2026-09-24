import { ROLE_INBOX_PRESENTATIONS } from './role-inbox.registry';

describe('operator problem inbox routing', () => {
  it('fans one durable event out to exactly the three business recipients', () => {
    const presentations = ROLE_INBOX_PRESENTATIONS.filter(
      ({ eventType }) => eventType === 'problem:operator_reported',
    );

    expect(presentations).toHaveLength(3);
    expect(presentations.map(({ recipientRole }) => recipientRole).sort()).toEqual([
      'commercial',
      'director',
      'production_lead',
    ]);
    expect(presentations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recipientRole: 'commercial',
          cta: { kind: 'production_problem', section: 'Проблемы' },
        }),
        expect.objectContaining({
          recipientRole: 'production_lead',
          cta: { kind: 'production_problem', section: 'Проблемы' },
        }),
        expect.objectContaining({
          recipientRole: 'director',
          cta: { kind: 'production_problem', section: 'Проблемы' },
        }),
      ]),
    );
  });
});
