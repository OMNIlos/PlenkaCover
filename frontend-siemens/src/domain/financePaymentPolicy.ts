import type { PaymentPolicyDraft } from './types';

const TOTAL_PERCENTAGE_BASIS_POINTS = 10_000;
const MAX_INSTALLMENT_DAYS = 3650;

function percentageLabel(basisPoints: number): string {
  return (basisPoints / 100).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function paymentStageCountLabel(count: number): string {
  if (count % 10 === 1 && count % 100 !== 11) return `${count} этап`;
  if ([2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100)) {
    return `${count} этапа`;
  }
  return `${count} этапов`;
}

export function paymentStageConditionLabel(
  trigger: 'invoice_issued' | 'full_shipment',
  offsetDays: number,
): string {
  return trigger === 'invoice_issued'
    ? 'при выставлении счёта'
    : `через ${offsetDays} дней после полной отгрузки`;
}

export function paymentPolicySummary(policy: PaymentPolicyDraft): string {
  const stageLabel = paymentStageCountLabel(policy.stages.length);
  const hasPrepayment = policy.stages.some((stage) => stage.trigger === 'invoice_issued');
  const hasDeferredPayment = policy.stages.some((stage) => stage.trigger === 'full_shipment');
  if (!hasDeferredPayment) return `${stageLabel} · полностью при выставлении счёта`;
  if (!hasPrepayment) {
    return `${stageLabel} · до ${policy.installmentDays} дней после полной отгрузки`;
  }
  return [
    stageLabel,
    `предоплата и платежи до ${policy.installmentDays} дней после полной отгрузки`,
  ].join(' · ');
}

export function prepay50Template(finalDay: number): PaymentPolicyDraft {
  return {
    installmentDays: finalDay,
    stages: [
      {
        sequence: 1,
        trigger: 'invoice_issued',
        percentageBasisPoints: 5000,
        offsetDays: 0,
      },
      {
        sequence: 2,
        trigger: 'full_shipment',
        percentageBasisPoints: 5000,
        offsetDays: finalDay,
      },
    ],
  };
}

export function immediate100Template(): PaymentPolicyDraft {
  return {
    installmentDays: 0,
    stages: [
      {
        sequence: 1,
        trigger: 'invoice_issued',
        percentageBasisPoints: 10_000,
        offsetDays: 0,
      },
    ],
  };
}

export function split50Template(): PaymentPolicyDraft {
  return prepay50Template(30);
}

export function net30Template(): PaymentPolicyDraft {
  return postpay100Template(30);
}

export function postpay100Template(finalDay: number): PaymentPolicyDraft {
  return {
    installmentDays: finalDay,
    stages: [
      {
        sequence: 1,
        trigger: 'full_shipment',
        percentageBasisPoints: 10_000,
        offsetDays: finalDay,
      },
    ],
  };
}

export function paymentPolicyDraftError(policy: PaymentPolicyDraft): string | null {
  if (
    !Number.isSafeInteger(policy.installmentDays) ||
    policy.installmentDays < 0 ||
    policy.installmentDays > MAX_INSTALLMENT_DAYS
  ) {
    return `Срок рассрочки должен быть от 0 до ${MAX_INSTALLMENT_DAYS} дней`;
  }
  if (policy.stages.length === 0) return 'Добавьте хотя бы один этап оплаты';
  if (policy.stages.length > 50) return 'Добавьте не больше 50 этапов оплаты';

  const sequences = new Set<number>();
  let previousDeferredOffset = -1;
  for (const [index, stage] of policy.stages.entries()) {
    if (!Number.isSafeInteger(stage.sequence) || stage.sequence !== index + 1) {
      return 'Этапы оплаты должны идти по порядку без пропусков';
    }
    if (sequences.has(stage.sequence)) return 'Номера этапов оплаты не должны повторяться';
    sequences.add(stage.sequence);
    if (
      !Number.isSafeInteger(stage.percentageBasisPoints) ||
      stage.percentageBasisPoints <= 0 ||
      stage.percentageBasisPoints > TOTAL_PERCENTAGE_BASIS_POINTS
    ) {
      return 'Доля этапа должна быть больше 0% и не превышать 100%';
    }
    if (
      !Number.isSafeInteger(stage.offsetDays) ||
      stage.offsetDays < 0 ||
      stage.offsetDays > policy.installmentDays
    ) {
      return 'День этапа должен входить в срок рассрочки';
    }
    if (stage.trigger === 'invoice_issued' && stage.offsetDays !== 0) {
      return 'Предоплата должна быть назначена на день выставления счёта';
    }
    if (stage.trigger === 'full_shipment') {
      if (stage.offsetDays <= previousDeferredOffset) {
        return 'Даты платежей после отгрузки должны идти по возрастанию';
      }
      previousDeferredOffset = stage.offsetDays;
    }
  }

  const total = policy.stages.reduce(
    (sum, stage) => sum + stage.percentageBasisPoints,
    0,
  );
  if (total < TOTAL_PERCENTAGE_BASIS_POINTS) {
    return `Распределите ещё ${percentageLabel(TOTAL_PERCENTAGE_BASIS_POINTS - total)}%`;
  }
  if (total > TOTAL_PERCENTAGE_BASIS_POINTS) {
    return `Уменьшите распределение на ${percentageLabel(total - TOTAL_PERCENTAGE_BASIS_POINTS)}%`;
  }

  const prepaymentStages = policy.stages.filter((stage) => stage.trigger === 'invoice_issued');
  if (prepaymentStages.length > 1) {
    return 'Добавьте не больше одной предоплаты в день выставления счёта';
  }
  const deferredStages = policy.stages.filter((stage) => stage.trigger === 'full_shipment');
  if (deferredStages.length === 0) {
    return policy.installmentDays === 0
      ? null
      : 'Для 100% предоплаты срок рассрочки должен быть 0 дней';
  }
  if (deferredStages.at(-1)?.offsetDays !== policy.installmentDays) {
    return `Последний платёж должен быть назначен на ${policy.installmentDays}-й день рассрочки`;
  }
  return null;
}
