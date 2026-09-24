import {
  capabilitiesForRole,
  DOMAIN_EVENTS,
  oneCOrderReference,
  PAYMENT_POLICY_PRESETS,
} from '@plenka/contracts';

describe('1С finance contracts', () => {
  it('builds the exact order marker used by 1С', () => {
    expect(oneCOrderReference(' ЗК-0042 ')).toBe('PLENKA_ORDER=ЗК-0042');
  });

  it('publishes the three canonical payment policy presets', () => {
    expect(PAYMENT_POLICY_PRESETS.immediate_100).toMatchObject({
      label: '100% сразу',
      installmentDays: 0,
      stages: [
        {
          sequence: 1,
          trigger: 'invoice_issued',
          percentageBasisPoints: 10_000,
          offsetDays: 0,
          label: '100% сразу',
        },
      ],
    });
    expect(
      PAYMENT_POLICY_PRESETS.split_50_50.stages.map((stage) => stage.percentageBasisPoints),
    ).toEqual([5_000, 5_000]);
    expect(PAYMENT_POLICY_PRESETS.net_30_100.stages).toEqual([
      {
        sequence: 1,
        trigger: 'full_shipment',
        percentageBasisPoints: 10_000,
        offsetDays: 30,
        label: '100% через 30 дней',
      },
    ]);
  });

  it('grants commercial users a dedicated note capability', () => {
    expect(capabilitiesForRole('commercial')).toContain('order:update_finance_note');
  });

  it('keeps finance note changes in the stable event vocabulary', () => {
    expect(DOMAIN_EVENTS).toContain('audit:commercial_finance_note_updated');
  });
});
