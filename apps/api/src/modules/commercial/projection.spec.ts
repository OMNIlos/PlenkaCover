import type { Counterparty } from '@prisma/client';
import { projectCounterparty } from './projection';

const cp = {
  id: 'cp1',
  displayName: 'УралПак',
  legalName: 'ООО УралПак',
  inn: '660000',
  billingSource: 'manual_platform',
  syncStatus: 'ready',
  createdAt: new Date(),
} as Counterparty;

describe('projectCounterparty', () => {
  it('exposes legalName to commercial/finance/director', () => {
    expect(projectCounterparty(cp, 'commercial').legalName).toBe('ООО УралПак');
    expect(projectCounterparty(cp, 'finance').legalName).toBe('ООО УралПак');
    expect(projectCounterparty(cp, 'director').legalName).toBe('ООО УралПак');
  });

  it('normalizes a blank INN to null for legal projections', () => {
    const counterpartyWithBlankInn = { ...cp, inn: '' };

    expect(projectCounterparty(counterpartyWithBlankInn, 'finance').inn).toBeNull();
  });

  it('hides legalName from operator/warehouse/production/admin', () => {
    for (const role of ['operator', 'warehouse', 'production_lead', 'admin'] as const) {
      expect(projectCounterparty(cp, role).legalName).toBeNull();
    }
  });

  it('does not manufacture a counterparty for a stock order', () => {
    expect(projectCounterparty(null, 'commercial')).toBeNull();
  });
});
