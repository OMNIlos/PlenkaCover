export const PAYMENT_STAGE_TRIGGERS = ['invoice_issued', 'full_shipment'] as const;
export type PaymentStageTrigger = (typeof PAYMENT_STAGE_TRIGGERS)[number];

export type PaymentPolicyStageInput = {
  sequence: number;
  trigger: PaymentStageTrigger;
  percentageBasisPoints: number;
  offsetDays: number;
  label?: string;
};

export type PaymentPolicyInput = {
  installmentDays: number;
  stages: PaymentPolicyStageInput[];
};

export type PaymentPolicyView = PaymentPolicyInput & {
  id: string;
  revision: number;
  capturedProductionLeadDays: number;
};

export type PaymentPolicyPreset = {
  label: string;
  installmentDays: number;
  stages: readonly PaymentPolicyStageInput[];
};

export const PAYMENT_POLICY_PRESETS = {
  immediate_100: {
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
  },
  split_50_50: {
    label: '50/50',
    installmentDays: 30,
    stages: [
      {
        sequence: 1,
        trigger: 'invoice_issued',
        percentageBasisPoints: 5_000,
        offsetDays: 0,
        label: '50% сразу',
      },
      {
        sequence: 2,
        trigger: 'full_shipment',
        percentageBasisPoints: 5_000,
        offsetDays: 30,
        label: '50% через 30 дней',
      },
    ],
  },
  net_30_100: {
    label: '100% через 30 дней',
    installmentDays: 30,
    stages: [
      {
        sequence: 1,
        trigger: 'full_shipment',
        percentageBasisPoints: 10_000,
        offsetDays: 30,
        label: '100% через 30 дней',
      },
    ],
  },
} as const satisfies Record<string, PaymentPolicyPreset>;

export type PaymentPolicyPresetId = keyof typeof PAYMENT_POLICY_PRESETS;

export type PaymentScheduleDateKind = 'actual' | 'condition' | 'unavailable';
