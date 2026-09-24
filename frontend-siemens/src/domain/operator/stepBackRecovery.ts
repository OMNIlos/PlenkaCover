export type OperatorStepBackActionId =
  | 'operator-step-back-spool-weight'
  | 'operator-step-back-roll-weight';

export const OPERATOR_STAGE_COOLDOWN_MS = 1_200;

export type OperatorStepBackPrompt = {
  title: string;
  message: string;
  successTitle: string;
  successDetail: string;
  confirmLabel: 'Вернуться';
  cancelLabel: 'Остаться';
};

const STEP_BACK_PROMPTS: Record<OperatorStepBackActionId, OperatorStepBackPrompt> = {
  'operator-step-back-spool-weight': {
    title: 'Вернуться к весу шпули?',
    message:
      'Зафиксированный вес шпули останется в истории. После возврата шпулю нужно взвесить заново.',
    successTitle: 'Возвращено к весу шпули',
    successDetail: 'Предыдущее измерение сохранено в истории. Взвесьте шпулю заново.',
    confirmLabel: 'Вернуться',
    cancelLabel: 'Остаться',
  },
  'operator-step-back-roll-weight': {
    title: 'Вернуться к весу рулона?',
    message:
      'Зафиксированный вес рулона останется в истории. После возврата рулон нужно взвесить заново.',
    successTitle: 'Возвращено к весу рулона',
    successDetail: 'Предыдущее измерение сохранено в истории. Взвесьте рулон заново.',
    confirmLabel: 'Вернуться',
    cancelLabel: 'Остаться',
  },
};

const STAGE_TRANSITION_ACTIONS = new Set([
  'operator-accept-order',
  'operator-spool-weight',
  'operator-roll-weight',
  'operator-print-qr',
  'operator-verify-qr',
  'operator-handover',
  'operator-defer-order',
  'operator-resume-order',
  'operator-step-back-spool-weight',
  'operator-step-back-roll-weight',
]);

export function isOperatorStepBackAction(actionId: string): actionId is OperatorStepBackActionId {
  return actionId in STEP_BACK_PROMPTS;
}

export function operatorStepBackPrompt(actionId: string): OperatorStepBackPrompt | null {
  return isOperatorStepBackAction(actionId) ? STEP_BACK_PROMPTS[actionId] : null;
}

export function isOperatorStageTransitionAction(actionId: string): boolean {
  return STAGE_TRANSITION_ACTIONS.has(actionId);
}

export function operatorStageCooldownBlocksAction(actionId: string): boolean {
  return (
    isOperatorStageTransitionAction(actionId) &&
    actionId !== 'operator-verify-qr' &&
    actionId !== 'operator-defer-order'
  );
}

export function operatorStepBackFailureDetail(error: unknown): string {
  const source =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }) : undefined;
  const code = typeof source?.code === 'string' ? source.code : null;

  if (code === 'OPERATOR_STEP_BACK_PRINT_STARTED') {
    return 'Вернуться нельзя: печать этикетки уже началась. Обратитесь к зав. производства.';
  }
  if (code === 'OPERATOR_OPERATION_IN_PROGRESS') {
    return 'По рулону уже выполняется операция. Дождитесь её завершения и обновите очередь.';
  }
  if (code === 'OPERATOR_STEP_CONFLICT' || code === 'OPERATOR_CONCURRENT_STATE_CONFLICT') {
    return 'Состояние рулона уже изменилось. Обновите очередь и проверьте текущий этап.';
  }
  if (code === 'OPERATOR_DISPATCH_TERMINAL' || code === 'OPERATOR_DISPATCH_STATE_CONFLICT') {
    return 'Рулон уже передан дальше и недоступен для возврата. Обратитесь к зав. производства.';
  }
  return error instanceof Error ? error.message : 'Не удалось вернуть предыдущий этап.';
}
