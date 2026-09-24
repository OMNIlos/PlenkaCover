import { describe, expect, it } from 'vitest';

import {
  isOperatorStageTransitionAction,
  operatorStageCooldownBlocksAction,
  operatorStepBackFailureDetail,
  operatorStepBackPrompt,
} from './stepBackRecovery';

describe('operator step-back recovery UI contract', () => {
  it.each([
    ['operator-step-back-spool-weight', 'Вернуться к весу шпули?', 'Возвращено к весу шпули'],
    ['operator-step-back-roll-weight', 'Вернуться к весу рулона?', 'Возвращено к весу рулона'],
  ] as const)('defines a safe prompt for %s', (actionId, title, successTitle) => {
    expect(operatorStepBackPrompt(actionId)).toEqual(
      expect.objectContaining({
        title,
        successTitle,
        confirmLabel: 'Вернуться',
        cancelLabel: 'Остаться',
      }),
    );
  });

  it('applies the short cooldown only to server transitions that advance or reopen a stage', () => {
    expect(isOperatorStageTransitionAction('operator-roll-weight')).toBe(true);
    expect(isOperatorStageTransitionAction('operator-step-back-roll-weight')).toBe(true);
    expect(isOperatorStageTransitionAction('operator-reweigh-roll')).toBe(false);
    expect(isOperatorStageTransitionAction('operator-problem')).toBe(false);
  });

  it('never drops a physical scanner submission during the visual stage cooldown', () => {
    expect(operatorStageCooldownBlocksAction('operator-print-qr')).toBe(true);
    expect(operatorStageCooldownBlocksAction('operator-verify-qr')).toBe(false);
    expect(operatorStageCooldownBlocksAction('operator-defer-order')).toBe(false);
  });

  it('turns stable backend conflicts into an actionable operator message', () => {
    expect(
      operatorStepBackFailureDetail({
        code: 'OPERATOR_STEP_BACK_PRINT_STARTED',
        message: 'technical',
      }),
    ).toContain('печать этикетки уже началась');
    expect(
      operatorStepBackFailureDetail({
        code: 'OPERATOR_STEP_CONFLICT',
        message: 'technical',
      }),
    ).toContain('Обновите очередь');
  });
});
