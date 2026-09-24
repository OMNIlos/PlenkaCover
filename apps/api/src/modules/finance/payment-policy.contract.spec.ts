import {
  DOMAIN_EVENTS,
  PAYMENT_STAGE_TRIGGERS,
  type PaymentPolicyInput,
} from '@plenka/contracts';

describe('payment policy contract', () => {
  it('publishes stable triggers and audit names', () => {
    const policy: PaymentPolicyInput = {
      installmentDays: 30,
      stages: [
        {
          sequence: 1,
          trigger: 'full_shipment',
          percentageBasisPoints: 10000,
          offsetDays: 30,
        },
      ],
    };

    expect(PAYMENT_STAGE_TRIGGERS).toEqual(['invoice_issued', 'full_shipment']);
    expect(policy.stages[0].percentageBasisPoints).toBe(10000);
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining(['audit:payment_policy_created', 'audit:payment_policy_updated']),
    );
  });
});
