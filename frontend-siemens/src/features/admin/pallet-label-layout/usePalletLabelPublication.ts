import { useRef, useState } from 'react';

import type {
  AdminPalletLabelLayoutApi,
  PublishPalletLabelLayoutResult,
} from '../../../api/adminPalletLabelLayout';
import { ApiError } from '../../../api/client';
import { IdempotentOperationGate, isDeliveryUncertain } from '../../../api/idempotentOperation';
import type {
  PalletLabelEditorBootstrap,
  PalletLabelLayout,
  PalletLabelLayoutPublication,
} from './palletLabelLayoutModel';

export const MIN_PUBLISH_REASON_LENGTH = 3;
export const MAX_PUBLISH_REASON_LENGTH = 500;

export type PalletLabelPublicationFeedback = {
  tone: 'success' | 'error' | 'warning';
  message: string;
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function publishErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW':
        return 'Текст не помещается в выбранные блоки. Измените геометрию и повторите предпросмотр.';
      case 'PALLET_LABEL_LAYOUT_SOURCE_UNAVAILABLE':
        return 'Источник публикации временно недоступен. Выберите другой палетный лист.';
      case 'PALLET_LABEL_LAYOUT_SOURCE_NOT_FOUND':
        return 'Палетный лист для публикации не найден. Обновите список источников.';
      case 'PALLET_LABEL_LAYOUT_INVALID':
        return 'Макет нельзя опубликовать. Исправьте отмеченные ограничения.';
      default:
        return error.message || 'Публикацию не удалось подтвердить.';
    }
  }
  return errorMessage(error, 'Публикацию не удалось подтвердить.');
}

export function usePalletLabelPublication({
  api,
  activePublication,
  sourceDocumentId,
  layout,
  publishable,
  onPublished,
  onMetadataRefreshed,
}: {
  api: AdminPalletLabelLayoutApi;
  activePublication: PalletLabelLayoutPublication | null;
  sourceDocumentId: string;
  layout: PalletLabelLayout | null;
  publishable: boolean;
  onPublished: (publication: PublishPalletLabelLayoutResult['publication']) => void;
  onMetadataRefreshed: (bootstrap: PalletLabelEditorBootstrap) => void;
}) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [metadataStale, setMetadataStale] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [feedback, setFeedback] = useState<PalletLabelPublicationFeedback | null>(null);
  const gateRef = useRef(new IdempotentOperationGate());
  const trimmedReason = reason.trim();
  const reasonValid =
    trimmedReason.length >= MIN_PUBLISH_REASON_LENGTH &&
    trimmedReason.length <= MAX_PUBLISH_REASON_LENGTH;
  const canStart = publishable && !pending && !metadataStale;
  const canConfirm = canStart && reasonValid;

  async function refreshMetadata(successMessage: string): Promise<boolean> {
    if (refreshPending) return false;
    setRefreshPending(true);
    try {
      const refreshed = await api.load();
      onMetadataRefreshed(refreshed);
      setMetadataStale(false);
      setFeedback({ tone: 'warning', message: successMessage });
      return true;
    } catch {
      setFeedback({
        tone: 'error',
        message:
          'Не удалось обновить активную версию. Публикация заблокирована до успешного обновления.',
      });
      return false;
    } finally {
      setRefreshPending(false);
    }
  }

  async function publish() {
    if (!canConfirm || !layout) return;
    const expectedActivePublicationId = activePublication?.id ?? null;
    const intent = JSON.stringify({
      expectedActivePublicationId,
      sourceDocumentId,
      reason: trimmedReason,
      layout,
    });
    const request = gateRef.current.start(
      intent,
      (operationKey) =>
        api.publish({
          operationKey,
          expectedActivePublicationId,
          sourceDocumentId,
          reason: trimmedReason,
          layout,
        }),
      'pallet-label-layout-publication',
    );
    if (!request) return;
    setPending(true);
    setFeedback(null);
    try {
      const result = await request;
      onPublished(result.publication);
      setConfirmationOpen(false);
      setReason('');
      setFeedback({
        tone: 'success',
        message: result.replayed
          ? `Публикация уже была подтверждена. Активен макет v${result.publication.version}. Ранее сформированные листы не изменятся.`
          : `Макет v${result.publication.version} опубликован. Ранее сформированные листы не изменятся.`,
      });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 409) {
        setMetadataStale(true);
        await refreshMetadata(
          'Активный макет изменился. Геометрия сохранена — проверьте версию и повторите публикацию.',
        );
      } else if (isDeliveryUncertain(error)) {
        setFeedback({
          tone: 'warning',
          message:
            'Статус публикации не подтвержден. Повторите запрос: будет использован тот же ключ операции.',
        });
      } else {
        setFeedback({ tone: 'error', message: publishErrorMessage(error) });
      }
    } finally {
      setPending(false);
    }
  }

  return {
    confirmationOpen,
    reason,
    trimmedReason,
    reasonValid,
    pending,
    feedback,
    metadataStale,
    refreshPending,
    canStart,
    canConfirm,
    setReason,
    clearFeedback: () => {
      if (!metadataStale) setFeedback(null);
    },
    openConfirmation: () => {
      setConfirmationOpen(true);
      setFeedback(null);
    },
    closeConfirmation: () => setConfirmationOpen(false),
    publish,
    refreshMetadata: () =>
      refreshMetadata(
        'Активная версия обновлена. Геометрия сохранена — проверьте макет и повторите публикацию.',
      ),
  };
}
