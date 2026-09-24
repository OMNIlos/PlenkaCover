import type {
  CommercialNextActionContract,
  CommercialOrderDetailContract,
  CommercialOrderSummaryContract,
  CommercialPipelineActionCode,
} from './contracts';

export type CommercialPipelineStepState =
  | 'done'
  | 'current'
  | 'next'
  | 'blocked'
  | 'issue'
  | 'skipped';

export type CommercialPipelineStepId =
  | 'intake'
  | 'finance_handoff'
  | 'invoice'
  | 'production_handoff'
  | 'production'
  | 'warehouse';

export type CommercialPipelineStep = {
  id: CommercialPipelineStepId;
  title: string;
  state: CommercialPipelineStepState;
  note?: string;
  action?: boolean;
};

export type CommercialPipelineFocus = {
  mode: 'action' | 'waiting' | 'done' | 'issue';
  title: string;
  detail: string;
  owner: string;
  actionLabel?: string;
};

export type CommercialPipelineProjection = {
  steps: CommercialPipelineStep[];
  focus: CommercialPipelineFocus;
};

type PipelineOrder = CommercialOrderSummaryContract | CommercialOrderDetailContract;

const OWNER_LABELS: Record<CommercialNextActionContract['ownerRole'], string> = {
  commercial: 'Коммерция',
  production_lead: 'Зав. производства',
  operator: 'Оператор',
  warehouse: 'Склад',
  finance: 'Бухгалтерия',
  director: 'Директор',
  admin: 'Администратор',
};

const ACTION_COPY: Partial<
  Record<CommercialNextActionContract['code'], { title: string; actionLabel: string }>
> = {
  promote_draft: { title: 'Черновик', actionLabel: 'Передать в работу' },
  submit_to_finance: {
    title: 'Передать в бухгалтерию',
    actionLabel: 'Передать в бухгалтерию',
  },
  request_cover: { title: 'Проверка склада', actionLabel: 'Запросить' },
  review_cover: { title: 'Маршрут', actionLabel: 'Проверить' },
  correct_order_spec: { title: 'Данные заказа', actionLabel: 'Исправить' },
  send_to_production: {
    title: 'Передать в производство',
    actionLabel: 'Передать в производство',
  },
  resolve_problem: { title: 'Проблема производства', actionLabel: 'Решить' },
  prepare_shipment: { title: 'Отгрузка', actionLabel: 'Подготовить' },
} satisfies Record<CommercialPipelineActionCode, { title: string; actionLabel: string }>;

export function projectCommercialPipeline(order: PipelineOrder): CommercialPipelineProjection {
  if (order.cancellation?.status === 'cancelled') {
    return {
      steps: [],
      focus: { mode: 'done', title: 'Отменён', detail: 'Заказ отменён.', owner: 'Завершено' },
    };
  }
  const detail = isDetail(order) ? order : null;
  const draft = detail ? detail.commercialStage === 'draft' : order.bucket === 'drafts';
  const sentToFinance = financeHandoffCompleted(order, detail);
  const invoiceIssued = invoiceCompleted(order, detail);
  const productionHandoff = productionHandoffCompleted(order, detail);
  const productionNotRequired =
    order.indicators.warehouseCover === 'full_confirmed' ||
    detail?.warehouseCoverage?.state === 'warehouse_reserved';
  const productionDone =
    order.indicators.production === 'ready' ||
    (productionNotRequired && order.commercialCompletion.fulfilledQty > 0);
  const productionIssue =
    order.indicators.production === 'defect' ||
    order.indicators.production === 'needs_approval' ||
    Boolean(detail?.productionProblems.length);
  const shipped =
    order.indicators.shipment === 'shipped' ||
    order.commercialCompletion.state === 'shipped';
  const warehouseStarted =
    productionDone ||
    productionNotRequired ||
    order.commercialCompletion.state === 'ready_for_shipment' ||
    order.commercialCompletion.fulfilledQty > 0;
  const financeGate = productionFinanceGate(order);

  const steps: CommercialPipelineStep[] = [
    {
      id: 'intake',
      title: 'Заявка',
      state: draft ? 'current' : 'done',
      note: draft ? 'Черновик' : undefined,
      action: draft && order.nextAction.allowed,
    },
    {
      id: 'finance_handoff',
      title: sentToFinance ? 'Передано в бухгалтерию' : 'Передать в бухгалтерию',
      state: sentToFinance ? 'done' : draft ? 'next' : 'current',
      action:
        !sentToFinance &&
        order.nextAction.code === 'submit_to_finance' &&
        order.nextAction.allowed,
    },
    {
      id: 'invoice',
      title: invoiceIssued ? 'Счёт выставлен' : 'Выставление счёта',
      state: invoiceIssued ? 'done' : sentToFinance ? 'current' : 'next',
    },
    {
      id: 'production_handoff',
      title: productionHandoff ? 'Передано в производство' : 'Передать в производство',
      state: productionHandoff
        ? 'done'
        : !invoiceIssued
          ? 'next'
          : financeGate
            ? 'blocked'
            : 'current',
      note: !productionHandoff && invoiceIssued ? financeGate : undefined,
      action:
        !productionHandoff &&
        order.nextAction.code === 'send_to_production' &&
        order.nextAction.allowed,
    },
    productionStep(order, {
      productionHandoff,
      productionNotRequired,
      productionDone,
      productionIssue,
    }),
    warehouseStep(order, { warehouseStarted, shipped }),
  ];

  return {
    steps,
    focus: focusProjection(order, steps),
  };
}

function financeHandoffCompleted(
  order: PipelineOrder,
  detail: CommercialOrderDetailContract | null,
) {
  if (order.requestType === 'stock_reserve') return true;
  if (detail) {
    return detail.commercialStage === 'sent_to_finance' || detail.commercialStage === 'in_work';
  }
  return order.bucket === 'in_work' && order.nextAction.code !== 'submit_to_finance';
}

function invoiceCompleted(
  order: PipelineOrder,
  detail: CommercialOrderDetailContract | null,
) {
  if (order.requestType === 'stock_reserve') return true;
  if (detail) return detail.financeSummary?.invoiceStatus === 'invoiced';
  return !['promote_draft', 'submit_to_finance', 'wait_invoice'].includes(order.nextAction.code);
}

function productionHandoffCompleted(
  order: PipelineOrder,
  detail: CommercialOrderDetailContract | null,
) {
  if (detail?.productionOrderId) return true;
  if (
    ['in_production', 'ready', 'needs_approval', 'defect'].includes(
      order.indicators.production,
    )
  ) {
    return true;
  }
  return [
    'wait_fulfillment',
    'resolve_problem',
    'prepare_shipment',
    'wait_prepare_shipment',
    'await_shipment',
    'view_history',
  ].includes(order.nextAction.code);
}

function productionFinanceGate(order: PipelineOrder): string | undefined {
  if (order.nextAction.code === 'wait_payment_terms') return 'Условия оплаты';
  if (order.nextAction.code === 'wait_prepayment') return 'После предоплаты';
  if (order.nextAction.code === 'wait_invoice') return 'После счёта';
  return undefined;
}

function productionStep(
  order: PipelineOrder,
  context: {
    productionHandoff: boolean;
    productionNotRequired: boolean;
    productionDone: boolean;
    productionIssue: boolean;
  },
): CommercialPipelineStep {
  if (context.productionNotRequired && context.productionDone) {
    return {
      id: 'production',
      title: 'Производство не требуется',
      state: 'skipped',
    };
  }
  if (context.productionDone) {
    return { id: 'production', title: 'Произведено', state: 'done' };
  }
  if (context.productionIssue) {
    return {
      id: 'production',
      title: 'Производство',
      state: 'issue',
      note:
        order.indicators.production === 'defect'
          ? 'Брак'
          : 'Нужно решение',
      action: order.nextAction.code === 'resolve_problem' && order.nextAction.allowed,
    };
  }
  if (context.productionHandoff) {
    return {
      id: 'production',
      title: 'Производство',
      state: 'current',
      note:
        order.indicators.production === 'in_production'
          ? 'В работе'
          : 'Ожидает запуска',
    };
  }
  return {
    id: 'production',
    title: 'Производство',
    state: 'next',
  };
}

function warehouseStep(
  order: PipelineOrder,
  context: { warehouseStarted: boolean; shipped: boolean },
): CommercialPipelineStep {
  if (context.shipped) {
    return { id: 'warehouse', title: 'Отгружено', state: 'done' };
  }
  if (order.indicators.shipment === 'shipment_problem') {
    return {
      id: 'warehouse',
      title: 'Склад',
      state: 'issue',
      note: 'Проблема отгрузки',
    };
  }
  if (context.warehouseStarted) {
    return {
      id: 'warehouse',
      title: 'Склад',
      state: 'current',
      note:
        order.indicators.shipment === 'partial_shipped'
          ? 'Частично отгружено'
          : undefined,
      action:
        order.nextAction.code === 'prepare_shipment' && order.nextAction.allowed,
    };
  }
  return { id: 'warehouse', title: 'Склад', state: 'next' };
}

function focusProjection(
  order: PipelineOrder,
  steps: CommercialPipelineStep[],
): CommercialPipelineFocus {
  const action = ACTION_COPY[order.nextAction.code];
  if (order.nextAction.allowed && action) {
    return {
      mode: 'action',
      title: action.title,
      detail: '',
      owner: OWNER_LABELS[order.nextAction.ownerRole],
      actionLabel: action.actionLabel,
    };
  }
  if (order.indicators.payment === 'overdue') {
    return {
      mode: 'issue',
      title: 'Просроченная оплата',
      detail: '',
      owner: 'Бухгалтерия',
    };
  }
  if (order.indicators.payment === 'sync_error') {
    return {
      mode: 'issue',
      title: 'Ошибка статуса оплаты',
      detail: '',
      owner: 'Бухгалтерия',
    };
  }
  const current = steps.find(({ state }) =>
    ['current', 'blocked', 'issue'].includes(state),
  );
  if (current) {
    return {
      mode: current.state === 'issue' ? 'issue' : 'waiting',
      title: current.title,
      detail: current.note ?? '',
      owner: OWNER_LABELS[order.nextAction.ownerRole],
    };
  }
  return {
    mode: 'done',
    title: 'Отгружено',
    detail: '',
    owner: 'Коммерция',
  };
}

function isDetail(order: PipelineOrder): order is CommercialOrderDetailContract {
  return 'commercialStage' in order;
}
