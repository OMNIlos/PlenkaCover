import {
  PAYMENT_STAGE_TRIGGERS,
  type PaymentPolicyInput,
  type PaymentPolicyStageInput,
  type PaymentStageTrigger,
  type PaymentTermType,
} from '@plenka/contracts';

export type DeferredPaymentRow = {
  kind: 'invoice_prepayment' | 'post_delivery';
  amount: number;
  dueDate: string | null;
};

export type CalculatedPaymentStage = PaymentPolicyStageInput & {
  amount: number;
};

export type ProjectedScheduleDateInput = {
  invoiceDate: string | null;
  shipmentDate: string | null;
  trigger: PaymentStageTrigger;
  offsetDays: PaymentPolicyStageInput['offsetDays'];
};

export type ProjectedScheduleDate =
  | { date: string; kind: 'actual' }
  | { date: null; kind: 'condition' };

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_BUSINESS_YEAR = 2000;
const MAX_BUSINESS_YEAR = 2100;
const MIN_PAYMENT_STAGES = 1;
const MAX_PAYMENT_STAGES = 50;
const TOTAL_PERCENTAGE_BASIS_POINTS = 10000;
const UNSAFE_INVOICE_AMOUNT_ERROR = 'Сумма счета превышает безопасный диапазон.';
const MAX_SAFE_KOPECKS = BigInt(Number.MAX_SAFE_INTEGER);

function dateOnly(value: string): Date {
  if (!DATE_ONLY_PATTERN.test(value)) throw new Error('Указана неверная дата.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value ||
    date.getUTCFullYear() < MIN_BUSINESS_YEAR ||
    date.getUTCFullYear() > MAX_BUSINESS_YEAR
  ) {
    throw new Error('Указана неверная дата.');
  }
  return date;
}

function toKopecks(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Сумма счета должна быть больше нуля.');
  }
  const scaledAmount = amount * 100;
  const kopecks = Math.round(scaledAmount);
  if (Math.abs(scaledAmount - kopecks) > 1e-7) {
    throw new Error('Сумма счета должна быть указана с точностью до копейки.');
  }
  if (!Number.isSafeInteger(kopecks)) {
    throw new Error(UNSAFE_INVOICE_AMOUNT_ERROR);
  }
  return kopecks;
}

function fromKopecks(value: number): number {
  return value / 100;
}

export function validatePaymentPolicy(policy: PaymentPolicyInput): void {
  if (
    !Array.isArray(policy.stages) ||
    policy.stages.length < MIN_PAYMENT_STAGES ||
    policy.stages.length > MAX_PAYMENT_STAGES
  ) {
    throw new Error('Политика оплаты должна содержать от 1 до 50 этапов.');
  }
  if (!Number.isInteger(policy.installmentDays) || policy.installmentDays < 0) {
    throw new Error('Срок рассрочки должен быть неотрицательным целым числом дней.');
  }

  const stages = [...policy.stages].sort((left, right) => left.sequence - right.sequence);
  if (
    stages.some((stage, index) => !Number.isInteger(stage.sequence) || stage.sequence !== index + 1)
  ) {
    throw new Error('Номера этапов должны идти от 1 без пропусков и повторов.');
  }

  for (const stage of stages) {
    if (!PAYMENT_STAGE_TRIGGERS.includes(stage.trigger)) {
      throw new Error('Указан неизвестный триггер этапа оплаты.');
    }
    if (
      !Number.isInteger(stage.percentageBasisPoints) ||
      stage.percentageBasisPoints < 1 ||
      stage.percentageBasisPoints > TOTAL_PERCENTAGE_BASIS_POINTS
    ) {
      throw new Error('Процент этапа должен быть целым числом basis points от 1 до 10000.');
    }
    if (stage.trigger === 'invoice_issued' && stage.offsetDays !== 0) {
      throw new Error('Предоплата должна иметь смещение 0 дней.');
    }
    if (
      stage.trigger === 'full_shipment' &&
      (!Number.isInteger(stage.offsetDays) ||
        stage.offsetDays < 0 ||
        stage.offsetDays > policy.installmentDays)
    ) {
      throw new Error('Смещение отложенного этапа должно быть от 0 до срока рассрочки.');
    }
  }

  const percentageTotal = stages.reduce((total, stage) => total + stage.percentageBasisPoints, 0);
  if (percentageTotal !== TOTAL_PERCENTAGE_BASIS_POINTS) {
    throw new Error('Сумма процентов этапов должна быть равна 100,00%.');
  }

  const prepaymentStages = stages.filter((stage) => stage.trigger === 'invoice_issued');
  if (prepaymentStages.length > 1) {
    throw new Error('Максимум одна предоплата может быть привязана к выставлению счета.');
  }

  const deferredStages = stages.filter((stage) => stage.trigger === 'full_shipment');
  if (deferredStages.length === 0) {
    if (policy.installmentDays !== 0) {
      throw new Error('Для 100% предоплаты срок рассрочки должен быть равен 0.');
    }
    return;
  }

  for (let index = 1; index < deferredStages.length; index += 1) {
    if (deferredStages[index].offsetDays <= deferredStages[index - 1].offsetDays) {
      throw new Error('Смещения отложенных этапов должны строго возрастать.');
    }
  }
  if (deferredStages[deferredStages.length - 1].offsetDays !== policy.installmentDays) {
    throw new Error('Смещение последнего отложенного этапа должно быть равно сроку рассрочки.');
  }
}

export function allocatePaymentPolicy(
  amount: number,
  policy: PaymentPolicyInput,
): CalculatedPaymentStage[] {
  validatePaymentPolicy(policy);
  const totalKopecks = BigInt(toKopecks(amount));
  const percentageBasisPointsTotal = BigInt(TOTAL_PERCENTAGE_BASIS_POINTS);
  const shares = policy.stages.map((stage) => {
    const scaled = totalKopecks * BigInt(stage.percentageBasisPoints);
    return {
      stage,
      kopecks: scaled / percentageBasisPointsTotal,
      remainder: scaled % percentageBasisPointsTotal,
    };
  });
  const allocatedKopecks = shares.reduce((total, share) => total + share.kopecks, 0n);
  const undistributedKopecks = totalKopecks - allocatedKopecks;
  const remainderOrder = [...shares].sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.stage.sequence - right.stage.sequence;
    }
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (let index = 0n; index < undistributedKopecks; index += 1n) {
    remainderOrder[Number(index)].kopecks += 1n;
  }
  return shares
    .sort((left, right) => left.stage.sequence - right.stage.sequence)
    .map(({ stage, kopecks }) => {
      if (kopecks > MAX_SAFE_KOPECKS) {
        throw new Error(UNSAFE_INVOICE_AMOUNT_ERROR);
      }
      return { ...stage, amount: fromKopecks(Number(kopecks)) };
    });
}

export function paymentPolicyFromLegacyType(type: PaymentTermType): PaymentPolicyInput {
  switch (type) {
    case 'prepay_50_postpay_50_30d':
      return {
        installmentDays: 30,
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
            offsetDays: 30,
          },
        ],
      };
    case 'postpay_100_30d':
      return {
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
  }
}

export function addCalendarDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new Error('Число календарных дней должно быть неотрицательным целым числом.');
  }
  const date = dateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function projectedScheduleDate(input: ProjectedScheduleDateInput): ProjectedScheduleDate {
  if (input.trigger === 'invoice_issued') {
    if (input.invoiceDate === null) return { date: null, kind: 'condition' };
    dateOnly(input.invoiceDate);
    return { date: input.invoiceDate, kind: 'actual' };
  }
  if (input.trigger !== 'full_shipment') {
    throw new Error('Указан неизвестный триггер этапа оплаты.');
  }
  if (input.shipmentDate !== null) {
    return {
      date: addCalendarDays(input.shipmentDate, input.offsetDays),
      kind: 'actual',
    };
  }

  return { date: null, kind: 'condition' };
}

export function buildDeferredPaymentRows(
  totalAmount: number,
  type: PaymentTermType,
  invoiceDate: string,
): DeferredPaymentRow[] {
  const normalizedInvoiceDate = addCalendarDays(invoiceDate, 0);
  const policy = paymentPolicyFromLegacyType(type);
  const total = toKopecks(totalAmount);
  let remaining = total;
  return [...policy.stages]
    .sort((left, right) => left.sequence - right.sequence)
    .map((stage, index, stages) => {
      const kopecks =
        index === stages.length - 1
          ? remaining
          : Math.floor((total * stage.percentageBasisPoints) / TOTAL_PERCENTAGE_BASIS_POINTS);
      remaining -= kopecks;
      return {
        kind: stage.trigger === 'invoice_issued' ? 'invoice_prepayment' : 'post_delivery',
        amount: fromKopecks(kopecks),
        dueDate: stage.trigger === 'invoice_issued' ? normalizedInvoiceDate : null,
      };
    });
}

export function postDeliveryDueDate(shipmentDate: string): string {
  return addCalendarDays(shipmentDate, 30);
}
