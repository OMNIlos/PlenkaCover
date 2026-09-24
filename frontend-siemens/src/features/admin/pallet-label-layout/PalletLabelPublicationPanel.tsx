import type { PalletLabelPublicationFeedback } from './usePalletLabelPublication';
import {
  MAX_PUBLISH_REASON_LENGTH,
  MIN_PUBLISH_REASON_LENGTH,
} from './usePalletLabelPublication';

export function PalletLabelPublicationPanel({
  confirmationOpen,
  reason,
  trimmedReasonLength,
  pending,
  canConfirm,
  feedback,
  metadataStale,
  refreshPending,
  onReasonChange,
  onCancel,
  onConfirm,
  onRefreshMetadata,
}: {
  confirmationOpen: boolean;
  reason: string;
  trimmedReasonLength: number;
  pending: boolean;
  canConfirm: boolean;
  feedback: PalletLabelPublicationFeedback | null;
  metadataStale: boolean;
  refreshPending: boolean;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onRefreshMetadata: () => void;
}) {
  return (
    <>
      {confirmationOpen ? (
        <section
          className="pallet-layout-publish-confirmation"
          role="region"
          aria-labelledby="pallet-layout-publish-confirmation-title"
        >
          <div>
            <h3 id="pallet-layout-publish-confirmation-title">
              Подтверждение публикации макета
            </h3>
            <p>
              <strong>Только новые палетные листы.</strong> Ранее сформированные документы и
              повторные печати останутся без изменений.
            </p>
          </div>
          <label>
            <span>Причина</span>
            <textarea
              aria-label="Причина публикации макета"
              rows={3}
              maxLength={MAX_PUBLISH_REASON_LENGTH}
              value={reason}
              disabled={pending}
              onChange={(event) => onReasonChange(event.target.value)}
              placeholder="Например: согласовано новое расположение блоков"
            />
            <small>
              От {MIN_PUBLISH_REASON_LENGTH} до {MAX_PUBLISH_REASON_LENGTH} символов ·{' '}
              {trimmedReasonLength}
            </small>
          </label>
          <div className="pallet-layout-publish-actions">
            <button type="button" disabled={pending} onClick={onCancel}>
              Отмена
            </button>
            <button
              type="button"
              className="action-recommended"
              aria-label="Подтвердить публикацию макета"
              disabled={!canConfirm}
              onClick={onConfirm}
            >
              {pending ? 'Публикуем…' : 'Подтвердить публикацию'}
            </button>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <div className={`pallet-layout-publish-feedback is-${feedback.tone}`}>
          <span role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.message}</span>
          {metadataStale ? (
            <button
              type="button"
              aria-label="Обновить активную версию"
              disabled={refreshPending || pending}
              onClick={onRefreshMetadata}
            >
              {refreshPending ? 'Обновляем…' : 'Обновить активную версию'}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
