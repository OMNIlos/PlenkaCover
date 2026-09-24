import { ConflictException } from '@nestjs/common';

export type OperatorRollAction =
  | 'accept'
  | 'spool_weight'
  | 'roll_weight'
  | 'qr_print'
  | 'qr_verify'
  | 'handover';

export type OperatorRollMutationAction =
  | OperatorRollAction
  | 'roll_reweigh'
  | 'step_back'
  | 'defect'
  | 'defer'
  | 'resume';

type MutableRollState = {
  warehouseState: string;
  rollDispatchItem: {
    status: string;
    productionOrder?: { commercialOrder?: { cancellationStatus?: string } };
  };
};

const MUTABLE_DISPATCH_STATUSES = {
  accept: ['assigned'],
  spool_weight: ['assigned'],
  roll_weight: ['assigned'],
  roll_reweigh: ['assigned'],
  qr_print: ['assigned'],
  qr_verify: ['assigned'],
  handover: ['assigned'],
  step_back: ['assigned'],
  defect: ['assigned', 'deferred'],
  defer: ['assigned'],
  resume: ['deferred'],
} as const satisfies Record<OperatorRollMutationAction, readonly string[]>;

const TERMINAL_DISPATCH_STATUSES = new Set(['defect', 'ready_for_warehouse', 'done']);

const TRANSITIONS = {
  accept: { predecessor: 'assigned', result: 'spool_weight' },
  spool_weight: { predecessor: 'spool_weight', result: 'roll_weight' },
  roll_weight: { predecessor: 'roll_weight', result: 'qr_print' },
  qr_print: { predecessor: 'qr_print', result: 'qr_check' },
  qr_verify: { predecessor: 'qr_check', result: 'handover' },
  handover: { predecessor: 'handover', result: 'warehouse' },
} as const satisfies Record<OperatorRollAction, { predecessor: string; result: string }>;

export function operatorRollTransition(action: OperatorRollAction) {
  return TRANSITIONS[action];
}

export function assertOperatorRollTransition(action: OperatorRollAction, currentStep: string) {
  const transition = operatorRollTransition(action);
  if (currentStep !== transition.predecessor) {
    throw new ConflictException({
      code: 'OPERATOR_STEP_CONFLICT',
      message: 'Состояние рулона изменилось. Обновите рабочую очередь.',
    });
  }
  return transition.result;
}

export function assertOperatorRollReweighTransition(currentStep: string): 'qr_print' | 'handover' {
  if (currentStep === 'qr_print' || currentStep === 'handover') return currentStep;
  throw new ConflictException({
    code: 'OPERATOR_STEP_CONFLICT',
    message: 'Состояние рулона изменилось. Обновите рабочую очередь.',
  });
}

export function assertOperatorRollStepBack(currentStep: string): 'roll_weight' | 'spool_weight' {
  if (currentStep === 'qr_print') {
    return 'roll_weight';
  }
  if (currentStep === 'roll_weight') {
    return 'spool_weight';
  }
  throw new ConflictException({
    code: 'OPERATOR_STEP_CONFLICT',
    message: 'Состояние рулона изменилось. Обновите рабочую очередь.',
  });
}

export function assertOperatorRollMutable(
  action: OperatorRollMutationAction,
  state: MutableRollState,
): void {
  if (
    state.rollDispatchItem.productionOrder?.commercialOrder?.cancellationStatus === 'cancelled' &&
    !['qr_print', 'qr_verify', 'handover', 'roll_reweigh', 'defect'].includes(action)
  ) {
    throw new ConflictException({
      code: 'OPERATOR_ORDER_CANCELLED',
      message: 'Заказ отменён. Новое производство остановлено.',
    });
  }
  const status = state.rollDispatchItem.status;
  if (TERMINAL_DISPATCH_STATUSES.has(status) || state.warehouseState !== 'not_ready') {
    throw new ConflictException({
      code: 'OPERATOR_DISPATCH_TERMINAL',
      message: 'Рулон уже передан в следующий контур или завершён и недоступен оператору.',
    });
  }
  if (!(MUTABLE_DISPATCH_STATUSES[action] as readonly string[]).includes(status)) {
    throw new ConflictException({
      code: 'OPERATOR_DISPATCH_STATE_CONFLICT',
      message: 'Состояние производственного задания не допускает эту операцию.',
    });
  }
}
