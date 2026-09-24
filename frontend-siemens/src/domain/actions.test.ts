import { describe, expect, it } from 'vitest';

import { getWorkObjectAction } from './actions';

describe('commercial production handoff action', () => {
  it('routes only the explicit commercial button to the production handoff', () => {
    expect(
      getWorkObjectAction(
        'commercial',
        'commercial-send-to-production:commercial-order-1',
      ),
    ).toEqual({
      role: 'commercial',
      kind: 'commercialSendToProduction',
      targetId: 'commercial-order-1',
    });
    expect(getWorkObjectAction('finance', 'commercial-send-to-production:commercial-order-1')).toEqual(
      { role: 'finance', kind: 'financeReduce' },
    );
  });
});

describe('finance payment schedule action', () => {
  it('routes targeted accountant confirmation to the live finance reducer', () => {
    expect(getWorkObjectAction('finance', 'finance-confirm-schedule:schedule-1')).toEqual({
      role: 'finance',
      kind: 'financeReduce',
    });
  });
});

describe('production technical cover action', () => {
  it('keeps the CommercialOrder id as the exact production action target', () => {
    expect(
      getWorkObjectAction(
        'production',
        'production-technical-approve-cover:commercial-order-1',
      ),
    ).toEqual({
      role: 'production',
      kind: 'productionApproveTechnicalCover',
      targetId: 'commercial-order-1',
    });
  });
});
