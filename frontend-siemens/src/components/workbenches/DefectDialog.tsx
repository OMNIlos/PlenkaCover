import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { ApiError } from '../../api/client';
import { isDeliveryUncertain } from '../../api/idempotentOperation';
import {
  fetchOperatorScaleReading,
  type OperatorScaleReading,
} from '../../api/operator';
import { trapFocusWithin } from '../shell/focusTrap';
import {
  canSubmitOperatorDefect,
  operatorDefectRecoveryMessage,
  OperatorScalePreview,
} from './operatorScalePreview';

export const DEFECT_NOTE_MAX_LENGTH = 500;

type ReasonDialogProps = {
  eyebrow: string;
  title: string;
  description: string;
  objectLabel: string;
  evidenceLabel: string;
  evidenceDetail: string;
  noteLabel?: string;
  notePlaceholder?: string;
  confirmLabel: string;
  pendingLabel: string;
  frozenNote?: string | null;
  retryLabel?: string;
  preferFocusFallback?: boolean;
  measurement?: ReactNode;
  confirmDisabled?: boolean;
  tone: 'warning' | 'critical';
  onCancel: () => void;
  onSubmit: (note: string) => Promise<void> | void;
};

export function submissionErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : '';
  if (error instanceof ApiError && isDeliveryUncertain(error)) {
    return 'Нет подтверждённой связи с платформой или шлюзом весов. Операция сохранена для безопасного повтора.';
  }
  if (
    typeof DOMException !== 'undefined' &&
    error instanceof DOMException &&
    error.name === 'AbortError'
  ) {
    return 'Запрос прерван до подтверждения результата. Повторите отправку.';
  }
  if (/secure uuid generation|безопасн.+идентификатор операции/iu.test(message)) {
    return 'Не удалось создать безопасный идентификатор операции. Обновите браузер или откройте платформу по HTTPS.';
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/iu.test(message)) {
    return 'Нет связи с платформой или шлюзом весов. Проверьте сеть, питание шлюза и повторите отправку.';
  }
  if (/offline|недоступн|gateway|шлюз/iu.test(message)) {
    return 'Весы поста недоступны. Проверьте подключение и повторите фиксацию.';
  }
  if (/unstable|стабил|stable/iu.test(message)) {
    return 'Масса ещё не стабилизировалась. Дождитесь стабильного сигнала и повторите.';
  }
  if (/[\p{Script=Cyrillic}]/u.test(message)) return message;
  return 'Действие не выполнено. Проверьте состояние оборудования и повторите.';
}

export function restoreDialogFocus(
  returnFocusTarget: HTMLElement | null,
  focusFallback: HTMLElement | null,
  preferFocusFallback = false,
) {
  if (!preferFocusFallback && returnFocusTarget?.isConnected) {
    returnFocusTarget?.focus();
    return;
  }
  focusFallback?.focus();
}

function ReasonDialog({
  eyebrow,
  title,
  description,
  objectLabel,
  evidenceLabel,
  evidenceDetail,
  noteLabel,
  notePlaceholder,
  confirmLabel,
  pendingLabel,
  frozenNote = null,
  retryLabel,
  preferFocusFallback = false,
  measurement,
  confirmDisabled = false,
  tone,
  onCancel,
  onSubmit,
}: ReasonDialogProps) {
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submissionRef = useRef<Promise<void> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const effectiveNote = frozenNote ?? note;
  const normalizedNote = effectiveNote.trim();
  const noteRequired = Boolean(noteLabel);
  const noteDescriptionIds = [
    'defect-dialog-note-counter',
    frozenNote ? 'defect-dialog-retry-status' : null,
    error ? 'defect-dialog-error' : null,
  ]
    .filter(Boolean)
    .join(' ');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const returnFocusTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    const hadInert = appShell?.hasAttribute('inert') ?? false;
    const previousAriaHidden = appShell?.getAttribute('aria-hidden') ?? null;

    appShell?.setAttribute('inert', '');
    appShell?.setAttribute('aria-hidden', 'true');
    const animationFrame = window.requestAnimationFrame(() => {
      (textareaRef.current ?? dialogRef.current)?.focus();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      if (!hadInert) appShell?.removeAttribute('inert');
      if (previousAriaHidden === null) appShell?.removeAttribute('aria-hidden');
      else appShell?.setAttribute('aria-hidden', previousAriaHidden);
      window.requestAnimationFrame(() => {
        const focusFallback = document.querySelector<HTMLElement>('[data-dialog-focus-fallback]');
        restoreDialogFocus(returnFocusTarget, focusFallback, preferFocusFallback);
      });
    };
  }, [preferFocusFallback]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!pending) onCancel();
      return;
    }
    trapFocusWithin(event);
  }

  function submit() {
    if ((noteRequired && !normalizedNote) || submissionRef.current) return;
    setPending(true);
    setError('');
    const request = (async () => {
      await onSubmit(normalizedNote);
    })();
    submissionRef.current = request;
    void request
      .catch((reason: unknown) => setError(submissionErrorMessage(reason)))
      .finally(() => {
        if (submissionRef.current === request) submissionRef.current = null;
        setPending(false);
      });
  }

  const dialog = (
    <div className="problem-report-backdrop defect-dialog-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className={`problem-report-dialog defect-dialog tone-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="defect-dialog-title"
        aria-describedby="defect-dialog-description"
        aria-busy={pending}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="problem-report-header defect-dialog-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="defect-dialog-title">{title}</h2>
          </div>
          <button
            className="drawer-close-button"
            type="button"
            onClick={onCancel}
            aria-label="Закрыть"
            disabled={pending}
          >
            <ix-icon name="close" size="24" />
          </button>
        </header>

        <div className="problem-report-body defect-dialog-body">
          <p id="defect-dialog-description" className="defect-dialog-description">
            {description}
          </p>

          <dl className="defect-dialog-evidence" aria-label="Физическое подтверждение брака">
            <div>
              <dt>Рулон</dt>
              <dd>{objectLabel}</dd>
            </div>
            <div>
              <dt>{evidenceLabel}</dt>
              <dd>{evidenceDetail}</dd>
            </div>
          </dl>

          {measurement}

          {noteRequired && (
            <label className="defect-dialog-note">
              <span>{noteLabel}</span>
              <textarea
                ref={textareaRef}
                value={effectiveNote}
                maxLength={DEFECT_NOTE_MAX_LENGTH}
                rows={4}
                placeholder={notePlaceholder}
                disabled={pending}
                readOnly={Boolean(frozenNote)}
                required
                aria-required="true"
                aria-invalid={Boolean(error)}
                aria-describedby={noteDescriptionIds}
                onChange={(event) => {
                  setNote(event.currentTarget.value);
                  if (error) setError('');
                }}
              />
              <small id="defect-dialog-note-counter">
                {effectiveNote.length}/{DEFECT_NOTE_MAX_LENGTH}
              </small>
            </label>
          )}

          {noteRequired && frozenNote && (
            <div
              id="defect-dialog-retry-status"
              className="defect-dialog-retry-status"
              role="status"
            >
              Комментарий сохранён для безопасного повтора с тем же идентификатором операции.
            </div>
          )}

          {error && (
            <div id="defect-dialog-error" className="defect-dialog-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="problem-report-actions defect-dialog-actions">
          <button className="peer-button" type="button" onClick={onCancel} disabled={pending}>
            Отмена
          </button>
          <button
            className={tone === 'critical' ? 'action-destructive' : 'primary-button'}
            type="button"
            disabled={pending || (noteRequired && !normalizedNote) || confirmDisabled}
            aria-busy={pending || undefined}
            onClick={submit}
          >
            {pending ? pendingLabel : (retryLabel ?? confirmLabel)}
          </button>
        </footer>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

export function DefectDialog({
  rollCode,
  spoolKg = 0,
  plannedNetKg = 0,
  initialReading = null,
  onCancel,
  onSubmit,
}: {
  rollCode: string;
  spoolKg?: number;
  plannedNetKg?: number;
  initialReading?: OperatorScaleReading | null;
  onCancel: () => void;
  onSubmit: () => Promise<void> | void;
}) {
  const [reading, setReading] = useState<OperatorScaleReading | null>(initialReading);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let cancelled = false;
    const poll = () => {
      fetchOperatorScaleReading('roll')
        .then((value) => {
          if (!cancelled) setReading(value);
        })
        .catch(() => {
          if (!cancelled) {
            setReading({
              deviceId: '',
              kind: 'roll',
              status: 'offline',
              stable: false,
              grossKg: 0,
              at: '',
            });
          }
        });
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const offline = Boolean(reading && reading.status !== 'ready');
  const scaleReady = canSubmitOperatorDefect(reading, spoolKg);
  const recoveryMessage = operatorDefectRecoveryMessage(reading, spoolKg);
  return (
    <ReasonDialog
      eyebrow="Оператор · физический брак"
      title="Зафиксировать брак рулона"
      description="При отправке масса будет получена со стабильных весов поста; значение нельзя вводить с клавиатуры."
      objectLabel={rollCode}
      evidenceLabel="Масса брака"
      evidenceDetail="Будет получена со стабильных весов поста"
      measurement={
        <>
          <OperatorScalePreview
            rollCode={rollCode}
            grossKg={reading?.grossKg ?? 0}
            spoolKg={spoolKg}
            plannedNetKg={plannedNetKg}
            stable={Boolean(reading?.stable) && !offline}
            offline={offline}
            waiting={!reading}
            tone="critical"
            sourceLabel="весы поста"
          />
          {recoveryMessage && (
            <div className="defect-scale-recovery" role="status">
              {recoveryMessage}
            </div>
          )}
        </>
      }
      confirmLabel="Взвесить и зафиксировать брак"
      pendingLabel="Получаем массу с весов…"
      preferFocusFallback
      tone="critical"
      confirmDisabled={!scaleReady}
      onCancel={onCancel}
      onSubmit={() => onSubmit()}
    />
  );
}

export function DefectResolutionDialog({
  rollCode,
  resolution,
  weightLabel,
  sourceLabel,
  capturedAtLabel,
  onCancel,
  onSubmit,
}: {
  rollCode: string;
  resolution: 'rework' | 'writeoff';
  weightLabel: string;
  sourceLabel: string;
  capturedAtLabel: string;
  onCancel: () => void;
  onSubmit: (note: string) => Promise<void> | void;
}) {
  const writeoff = resolution === 'writeoff';
  return (
    <ReasonDialog
      eyebrow="Зав. производства · решение по браку"
      title={writeoff ? 'Подтвердите списание' : 'Подтвердите переделку'}
      description={
        writeoff
          ? 'Рулон будет списан без замены. Вторсырьё изменится после сохранения решения.'
          : 'После сохранения решения будет создан один замещающий рулон.'
      }
      objectLabel={rollCode}
      evidenceLabel="Подтверждённая масса"
      evidenceDetail={`${weightLabel} · ${sourceLabel} · ${capturedAtLabel}`}
      noteLabel="Обязательная заметка к решению"
      notePlaceholder="Почему выбран этот исход и что проверено"
      confirmLabel={writeoff ? 'Подтвердить списание' : 'Подтвердить переделку'}
      pendingLabel="Записываем решение…"
      preferFocusFallback
      tone={writeoff ? 'critical' : 'warning'}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  );
}
