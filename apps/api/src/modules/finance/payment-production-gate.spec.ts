import {
  captureProductionClearance,
  financeAllowsProduction,
  financeProductionGate,
} from './payment-production-gate';

describe('financeProductionGate', () => {
  it('waits for an issued invoice before production can start', () => {
    expect(financeProductionGate(null)).toBe('awaiting_invoice');
    expect(
      financeProductionGate({
        invoiceStatus: 'draft',
        policy: null,
        paymentTermsType: null,
        schedules: [],
      }),
    ).toBe('awaiting_invoice');
  });

  it('waits for payment terms when an invoice has no policy or legacy terms', () => {
    expect(
      financeProductionGate({
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: null,
        schedules: [],
      }),
    ).toBe('awaiting_payment_terms');
  });

  it('waits for an unpaid canonical invoice prepayment', () => {
    expect(
      financeProductionGate({
        invoiceStatus: 'invoiced',
        policy: {
          id: 'policy',
          stages: [{ id: 'invoice-stage', trigger: 'invoice_issued' }],
        },
        paymentTermsType: null,
        schedules: [
          {
            paymentPolicyStageId: 'invoice-stage',
            kind: 'invoice_prepayment',
            status: 'unpaid',
          },
        ],
      }),
    ).toBe('awaiting_prepayment');
  });

  it('opens production for a canonical post-shipment-only policy', () => {
    expect(
      financeProductionGate({
        invoiceStatus: 'invoiced',
        policy: {
          id: 'policy',
          stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
        },
        paymentTermsType: null,
        schedules: [],
      }),
    ).toBe('open');
  });

  it('keeps production open after the financial source is corrected or replaced', () => {
    expect(
      financeProductionGate({
        productionClearedAt: new Date('2026-08-04T10:00:00.000Z'),
        invoiceStatus: 'not_invoiced',
        policy: null,
        paymentTermsType: null,
        schedules: [],
      }),
    ).toBe('open');
  });
});

describe('captureProductionClearance', () => {
  const actor = { userId: 'finance-1', role: 'finance' as const };

  function setup(financeOrder: Record<string, unknown>) {
    const tx = {
      financeOrder: {
        findUnique: jest.fn().mockResolvedValue(financeOrder),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      domainEvent: { create: jest.fn() },
    };
    const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
    return { tx, audit };
  }

  it('captures an invoiced all-postpay gate and emits one durable event', async () => {
    const { tx, audit } = setup({
      id: 'fo1',
      commercialOrderId: 'co1',
      productionClearedAt: null,
      invoiceStatus: 'invoiced',
      paymentTermsType: null,
      policy: {
        id: 'policy-1',
        stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
      },
      schedules: [],
    });

    await expect(
      captureProductionClearance(
        tx as never,
        audit as never,
        actor,
        'fo1',
        'invoice policy allows production',
      ),
    ).resolves.toEqual(expect.any(Date));

    expect(tx.financeOrder.updateMany).toHaveBeenCalledWith({
      where: { id: 'fo1', productionClearedAt: null },
      data: { productionClearedAt: expect.any(Date) },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:finance_production_cleared',
        objectId: 'fo1',
        actorRole: 'finance',
        actorId: 'finance-1',
        reason: 'invoice policy allows production',
        detail: {
          financeOrderId: 'fo1',
          commercialOrderId: 'co1',
        },
      }),
      tx,
    );
  });

  it('returns an existing marker without rewriting it or duplicating audit', async () => {
    const clearedAt = new Date('2026-08-04T10:00:00.000Z');
    const { tx, audit } = setup({
      id: 'fo1',
      commercialOrderId: 'co1',
      productionClearedAt: clearedAt,
      invoiceStatus: 'not_invoiced',
      paymentTermsType: null,
      policy: null,
      schedules: [],
    });

    await expect(
      captureProductionClearance(
        tx as never,
        audit as never,
        actor,
        'fo1',
        'later production read',
      ),
    ).resolves.toEqual(clearedAt);
    expect(tx.financeOrder.updateMany).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('financeAllowsProduction', () => {
  it('blocks a canonical invoice prepayment stage when its schedule is missing', () => {
    const policy = {
      id: 'policy',
      stages: [
        {
          id: 'invoice-stage',
          trigger: 'invoice_issued',
        },
      ],
    };

    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy,
        schedules: [],
        paymentTermsType: 'prepay_50_postpay_50_30d',
      }),
    ).toBe(false);
  });

  it('does not satisfy a canonical invoice stage with a schedule linked to another stage', () => {
    const policy = {
      id: 'policy',
      stages: [
        {
          id: 'required-invoice-stage',
          trigger: 'invoice_issued',
        },
      ],
    };

    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy,
        schedules: [
          {
            paymentPolicyStageId: 'another-stage',
            kind: 'invoice_prepayment',
            status: 'paid',
          },
        ],
        paymentTermsType: null,
      }),
    ).toBe(false);
  });

  it('allows a canonical policy with no invoice prepayment after invoicing', () => {
    const policy = {
      id: 'policy',
      stages: [{ id: 'shipment-stage', trigger: 'full_shipment' }],
    };

    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy,
        schedules: [],
        paymentTermsType: null,
      }),
    ).toBe(true);
  });

  it('allows a canonical policy after every invoice prepayment is paid', () => {
    const policy = {
      id: 'policy',
      stages: [
        { id: 'invoice-stage', trigger: 'invoice_issued' },
        { id: 'shipment-stage', trigger: 'full_shipment' },
      ],
    };

    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy,
        schedules: [
          {
            paymentPolicyStageId: 'invoice-stage',
            kind: 'invoice_prepayment',
            status: 'paid',
          },
          {
            paymentPolicyStageId: 'shipment-stage',
            kind: 'post_delivery',
            status: 'unpaid',
          },
        ],
        paymentTermsType: null,
      }),
    ).toBe(true);
  });

  it('blocks a canonical policy while any invoice prepayment is unpaid', () => {
    const policy = {
      id: 'policy',
      stages: [{ id: 'invoice-stage', trigger: 'invoice_issued' }],
    };

    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy,
        schedules: [
          {
            paymentPolicyStageId: 'invoice-stage',
            kind: 'invoice_prepayment',
            status: 'unpaid',
          },
        ],
        paymentTermsType: null,
      }),
    ).toBe(false);
  });

  it('allows production for an invoiced 100% post-delivery payment', () => {
    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: 'postpay_100_30d',
        schedules: [{ paymentPolicyStageId: null, kind: 'post_delivery', status: 'pending' }],
      }),
    ).toBe(true);
  });

  it('requires the invoice prepayment row to be confirmed for 50/50 terms', () => {
    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: 'prepay_50_postpay_50_30d',
        schedules: [{ paymentPolicyStageId: null, kind: 'invoice_prepayment', status: 'pending' }],
      }),
    ).toBe(false);
    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: 'prepay_50_postpay_50_30d',
        schedules: [{ paymentPolicyStageId: null, kind: 'invoice_prepayment', status: 'paid' }],
      }),
    ).toBe(true);
  });

  it('rejects legacy or non-invoiced finance records', () => {
    expect(
      financeAllowsProduction({
        invoiceStatus: 'draft',
        policy: null,
        paymentTermsType: 'postpay_100_30d',
        schedules: [],
      }),
    ).toBe(false);
    expect(
      financeAllowsProduction({
        invoiceStatus: 'invoiced',
        policy: null,
        paymentTermsType: null,
        schedules: [],
      }),
    ).toBe(false);
  });
});
