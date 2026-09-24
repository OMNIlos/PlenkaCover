import { useEffect, useState, type KeyboardEvent } from 'react';

import { trapFocusWithin } from './focusTrap';

export type ActionConfirmationTone = 'info' | 'success' | 'warning' | 'critical';

export type ActionConfirmationDetail = {
  label: string;
  value: string;
};

export type ActionConfirmationChoice = {
  label: string;
  value: string;
  description?: string;
};

export type ActionConfirmationDialogState = {
  eyebrow: string;
  title: string;
  message: string;
  tone: ActionConfirmationTone;
  objectTitle?: string;
  details?: ActionConfirmationDetail[];
  confirmLabel: string;
  cancelLabel?: string;
  choices?: {
    label: string;
    options: ActionConfirmationChoice[];
    requiredMessage: string;
  };
  input?: {
    label: string;
    placeholder?: string;
    requiredMessage: string;
  };
  initialFocus?: 'dialog' | 'cancel' | 'confirm' | 'input';
  submitOnEnter?: boolean;
  pending?: boolean;
  onConfirm: (value?: string, choiceValue?: string) => void;
};

const toneIcon: Record<ActionConfirmationTone, string> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  critical: 'warning',
};

export function shouldSubmitActionConfirmationOnEnter(
  dialog: ActionConfirmationDialogState,
): boolean {
  return !dialog.pending && !dialog.input && dialog.submitOnEnter !== false;
}

export function ActionConfirmationDialog({
  dialog,
  onCancel,
}: {
  dialog: ActionConfirmationDialogState;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [choiceValue, setChoiceValue] = useState(dialog.choices?.options[0]?.value ?? '');

  useEffect(() => {
    setValue('');
    setError('');
    setChoiceValue(dialog.choices?.options[0]?.value ?? '');
  }, [dialog]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!dialog.pending) onCancel();
      return;
    }
    if (event.key === 'Enter' && shouldSubmitActionConfirmationOnEnter(dialog)) {
      event.preventDefault();
      submit();
      return;
    }
    trapFocusWithin(event);
  }

  function submit() {
    if (dialog.pending) return;
    const normalized = value.trim();
    if (dialog.choices && !choiceValue) {
      setError(dialog.choices.requiredMessage);
      return;
    }
    if (dialog.input && !normalized) {
      setError(dialog.input.requiredMessage);
      return;
    }
    dialog.onConfirm(dialog.input ? normalized : undefined, dialog.choices ? choiceValue : undefined);
  }

  return (
    <div className="action-confirm-backdrop" role="presentation">
      <section
        className={`action-confirm-dialog tone-${dialog.tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-confirm-title"
        aria-busy={dialog.pending || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="action-confirm-header">
          <span className="action-confirm-icon" aria-hidden="true">
            <ix-icon name={toneIcon[dialog.tone]} size="24" />
          </span>
          <div>
            <span className="eyebrow">{dialog.eyebrow}</span>
            <h2 id="action-confirm-title">{dialog.title}</h2>
            {dialog.objectTitle && <p>{dialog.objectTitle}</p>}
          </div>
          <button
            className="drawer-close-button"
            type="button"
            disabled={dialog.pending}
            onClick={onCancel}
            aria-label="Закрыть"
          >
            <ix-icon name="close" size="24" />
          </button>
        </header>

        <div className="action-confirm-body">
          <p className="action-confirm-message">{dialog.message}</p>

          {dialog.details && dialog.details.length > 0 && (
            <dl className="action-confirm-details" aria-label="Что изменится">
              {dialog.details.map((detail) => (
                <div key={`${detail.label}-${detail.value}`}>
                  <dt>{detail.label}</dt>
                  <dd>{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {dialog.choices && (
            <fieldset className="action-confirm-choice">
              <legend>{dialog.choices.label}</legend>
              <div className="action-confirm-choice-list">
                {dialog.choices.options.map((option) => (
                  <label key={option.value} className={choiceValue === option.value ? 'is-selected' : undefined}>
                    <input
                      type="radio"
                      name="action-confirm-choice"
                      value={option.value}
                      checked={choiceValue === option.value}
                      onChange={() => {
                        setChoiceValue(option.value);
                        if (error) setError('');
                      }}
                    />
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {dialog.input && (
            <label className="action-confirm-input">
              <span>{dialog.input.label}</span>
              <textarea
                value={value}
                placeholder={dialog.input.placeholder}
                aria-invalid={Boolean(error)}
                onChange={(event) => {
                  setValue(event.currentTarget.value);
                  if (error) setError('');
                }}
                autoFocus={
                  dialog.initialFocus
                    ? dialog.initialFocus === 'input'
                    : true
                }
                disabled={dialog.pending}
              />
              {error && <strong role="alert">{error}</strong>}
            </label>
          )}
        </div>

        <footer className="action-confirm-actions">
          <button
            className="compact-action-button action-secondary"
            type="button"
            autoFocus={dialog.initialFocus === 'cancel'}
            disabled={dialog.pending}
            onClick={onCancel}
          >
            {dialog.cancelLabel ?? 'Отмена'}
          </button>
          <button
            className={`compact-action-button ${dialog.tone === 'critical' ? 'action-destructive' : 'action-recommended'}`}
            type="button"
            autoFocus={dialog.initialFocus === 'confirm'}
            disabled={dialog.pending}
            onClick={submit}
          >
            <ix-icon name={toneIcon[dialog.tone]} size="16" />
            <span>{dialog.confirmLabel}</span>
          </button>
        </footer>
      </section>
    </div>
  );
}
