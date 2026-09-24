import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  ActionConfirmationDialog,
  shouldSubmitActionConfirmationOnEnter,
  type ActionConfirmationDialogState,
} from './ActionConfirmationDialog';

function stepBackDialog(
  overrides: Partial<ActionConfirmationDialogState> = {},
): ActionConfirmationDialogState {
  return {
    eyebrow: 'Оператор · возврат этапа',
    title: 'Вернуться к весу рулона?',
    message: 'Предыдущее измерение останется в истории.',
    tone: 'warning',
    confirmLabel: 'Вернуться',
    cancelLabel: 'Остаться',
    initialFocus: 'cancel',
    submitOnEnter: false,
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe('ActionConfirmationDialog safe confirmation', () => {
  it('does not submit a destructive recovery on Enter', () => {
    expect(shouldSubmitActionConfirmationOnEnter(stepBackDialog())).toBe(false);
    expect(
      shouldSubmitActionConfirmationOnEnter(
        stepBackDialog({ submitOnEnter: true, initialFocus: 'confirm' }),
      ),
    ).toBe(true);
  });

  it('initially focuses the safe cancel action', () => {
    const markup = renderToStaticMarkup(
      <ActionConfirmationDialog dialog={stepBackDialog()} onCancel={vi.fn()} />,
    );

    expect(markup).toMatch(
      /<button class="compact-action-button action-secondary" type="button" autofocus="">Остаться<\/button>/,
    );
  });

  it('disables every dialog action while the request is pending', () => {
    const markup = renderToStaticMarkup(
      <ActionConfirmationDialog dialog={stepBackDialog({ pending: true })} onCancel={vi.fn()} />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});
