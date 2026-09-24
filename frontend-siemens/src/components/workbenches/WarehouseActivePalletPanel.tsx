import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isDeliveryUncertain } from '../../api/idempotentOperation';
import {
  fetchWarehousePalletPreview,
  recordWarehousePalletSystemPrintIntent,
  sealCurrentWarehousePallet,
} from '../../api/warehouse';
import type { BrowserPalletListTemplateVersion } from '../../domain/palletListProfiles';
import type { WarehouseActivePallet, WarehouseWorkbench } from '../../domain/types';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';
import {
  createWarehouseSystemPrintRequestId,
  openWarehousePalletSystemPrint,
  WarehouseSystemPrintIntentGate,
} from './warehouseBrowserPrint';
import { warehouseRequestErrorMessage } from './warehousePalletResources';
import {
  warehousePalletAcceptanceLabel,
  warehouseRollCharacteristicsLabel,
  warehouseRollDimensionsLabel,
  warehouseRollPackagingLabel,
  warehouseRollProductionLabel,
  warehouseRollWeightLabel,
} from './warehouseRollPresentation';

type ClosePhase = 'idle' | 'pending' | 'success' | 'error' | 'sealed_error';
type SealedPrintDocument = { id: string; templateVersion: BrowserPalletListTemplateVersion };
const MIN_REPRINT_REASON_LENGTH = 3;
const MAX_REPRINT_REASON_LENGTH = 500;

export function WarehouseActivePalletPanel({
  taskId,
  pallet,
  rolls,
  onWarehouseRefresh,
}: {
  taskId: string;
  pallet: WarehouseActivePallet | null | undefined;
  rolls?: WarehouseWorkbench['expectedRolls'];
  onWarehouseRefresh?: () => void;
}) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [phase, setPhase] = useState<ClosePhase>('idle');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [sealedDocument, setSealedDocument] = useState<SealedPrintDocument | null>(null);
  const [reprintReason, setReprintReason] = useState('');
  const [reprintRetryReason, setReprintRetryReason] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const retryRequestIdRef = useRef<string | null>(null);
  const initialIntentGateRef = useRef(new WarehouseSystemPrintIntentGate());
  const reprintIntentGateRef = useRef(new WarehouseSystemPrintIntentGate());
  const initialIntentConfirmedRef = useRef(false);
  const generationRef = useRef(0);
  const palletIdRef = useRef<string | null>(pallet?.id ?? null);
  const rollsByCode = useMemo(
    () => new Map((rolls ?? []).map((roll) => [roll.id, roll])),
    [rolls],
  );

  const resetOperationState = useCallback(() => {
    pendingRef.current = false;
    retryRequestIdRef.current = null;
    initialIntentGateRef.current.reset();
    reprintIntentGateRef.current.reset();
    initialIntentConfirmedRef.current = false;
    setConfirmationOpen(false);
    setPhase('idle');
    setFeedback(null);
    setSealedDocument(null);
    setReprintReason('');
    setReprintRetryReason(null);
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    palletIdRef.current = null;
    resetOperationState();
    return () => {
      generationRef.current += 1;
    };
  }, [resetOperationState, taskId]);

  useEffect(() => {
    const nextPalletId = pallet?.id ?? null;
    if (nextPalletId === null || nextPalletId === palletIdRef.current) return;
    palletIdRef.current = nextPalletId;
    generationRef.current += 1;
    resetOperationState();
  }, [pallet?.id, resetOperationState, taskId]);

  const pending = phase === 'pending';
  const alreadySealed = sealedDocument !== null || phase === 'success' || phase === 'sealed_error';
  const canClose = Boolean(pallet && pallet.rollCount > 0 && !pending && !alreadySealed);
  const trimmedReprintReason = reprintReason.replace(/\s+/gu, ' ').trim();
  const validReprintReason =
    trimmedReprintReason.length >= MIN_REPRINT_REASON_LENGTH &&
    trimmedReprintReason.length <= MAX_REPRINT_REASON_LENGTH;

  function openConfirmation() {
    if (!canClose) return;
    setFeedback(null);
    setConfirmationOpen(true);
  }

  async function sealAndPrint() {
    if (!canClose || pendingRef.current) return;

    const generation = generationRef.current;
    const requestId = retryRequestIdRef.current ?? createWarehouseSystemPrintRequestId();
    let document: SealedPrintDocument | null = null;
    retryRequestIdRef.current = requestId;
    pendingRef.current = true;
    setPhase('pending');
    setFeedback('Закрываем палет и готовим системную печать…');

    try {
      const result = await sealCurrentWarehousePallet(taskId, { requestId });
      const sealed = {
        id: result.document.id,
        templateVersion: result.document.templateVersion,
      };
      document = sealed;
      retryRequestIdRef.current = null;
      if (generationRef.current === generation) {
        setSealedDocument(sealed);
        setFeedback('Палет закрыт. Загружаем палетный лист…');
      }

      await initialIntentGateRef.current.run((intentRequestId) =>
        recordWarehousePalletSystemPrintIntent(sealed.id, {
          requestId: intentRequestId,
          kind: 'initial',
        }),
      );
      initialIntentConfirmedRef.current = true;
      const preview = await fetchWarehousePalletPreview(sealed.id);
      await openWarehousePalletSystemPrint(preview, sealed.templateVersion);

      if (generationRef.current === generation) {
        setConfirmationOpen(false);
        setPhase('success');
        setFeedback('Палет закрыт. Открыта системная печать.');
      }
      onWarehouseRefresh?.();
    } catch (error: unknown) {
      if (generationRef.current !== generation) return;
      setConfirmationOpen(false);
      if (document) {
        retryRequestIdRef.current = null;
        setSealedDocument(document);
        setPhase('sealed_error');
        setFeedback(
          'Палет закрыт, но системная печать не открылась. Повторите печать без повторного закрытия.',
        );
      } else {
        if (!isDeliveryUncertain(error)) retryRequestIdRef.current = null;
        setPhase('error');
        setFeedback(
          isDeliveryUncertain(error)
            ? 'Статус закрытия не подтвержден. Повторите проверку: будет использован тот же запрос.'
            : warehouseRequestErrorMessage(error),
        );
      }
    } finally {
      if (generationRef.current === generation) pendingRef.current = false;
    }
  }

  async function retrySystemPrint() {
    if (!sealedDocument || pendingRef.current) return;

    const initialIntentPending = !initialIntentConfirmedRef.current;
    if (!initialIntentPending && reprintRetryReason === null && !validReprintReason) return;
    const generation = generationRef.current;
    pendingRef.current = true;
    setPhase('pending');
    setFeedback('Загружаем закрытый палетный лист…');
    try {
      if (initialIntentPending) {
        await initialIntentGateRef.current.run((requestId) =>
          recordWarehousePalletSystemPrintIntent(sealedDocument.id, {
            requestId,
            kind: 'initial',
          }),
        );
        initialIntentConfirmedRef.current = true;
      } else {
        const intentReason = reprintRetryReason ?? trimmedReprintReason;
        setReprintRetryReason(intentReason);
        await reprintIntentGateRef.current.run((requestId) =>
          recordWarehousePalletSystemPrintIntent(sealedDocument.id, {
            requestId,
            kind: 'reprint',
            reason: intentReason,
          }),
        );
      }
      const preview = await fetchWarehousePalletPreview(sealedDocument.id);
      await openWarehousePalletSystemPrint(preview, sealedDocument.templateVersion);
      if (generationRef.current === generation) {
        setPhase('success');
        setFeedback('Открыта системная печать.');
        setReprintReason('');
        setReprintRetryReason(null);
      }
      onWarehouseRefresh?.();
    } catch (error: unknown) {
      if (generationRef.current !== generation) return;
      setPhase('sealed_error');
      setFeedback(warehouseRequestErrorMessage(error));
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current = false;
        if (!reprintIntentGateRef.current.hasPendingRetry()) {
          setReprintRetryReason(null);
        }
      }
    }
  }

  const feedbackStatus = feedback ? (
    <p
      className={`warehouse-active-pallet-feedback state-${phase}`}
      role={phase === 'error' || phase === 'sealed_error' ? 'alert' : 'status'}
      aria-live="polite"
    >
      {feedback}
    </p>
  ) : null;
  const reprintControls =
    phase === 'sealed_error' && sealedDocument ? (
      <div className="warehouse-active-pallet-reprint">
        {initialIntentConfirmedRef.current && (
          <label className="warehouse-pallet-reprint-field">
            <span>Причина повторной печати</span>
            <textarea
              aria-label="Причина повторной системной печати"
              rows={3}
              maxLength={MAX_REPRINT_REASON_LENGTH}
              value={reprintReason}
              disabled={pending || reprintRetryReason !== null}
              onChange={(event) => setReprintReason(event.target.value)}
              placeholder="Например: системный диалог не открылся"
            />
            <small>
              {reprintRetryReason
                ? 'Причина зафиксирована до подтверждения запроса.'
                : `От ${MIN_REPRINT_REASON_LENGTH} до ${MAX_REPRINT_REASON_LENGTH} символов · ${trimmedReprintReason.length}`}
            </small>
          </label>
        )}
        <button
          type="button"
          className="warehouse-row-action"
          aria-label="Повторить системную печать палетного листа"
          disabled={
            pending ||
            (initialIntentConfirmedRef.current &&
              reprintRetryReason === null &&
              !validReprintReason)
          }
          onClick={() => void retrySystemPrint()}
        >
          Повторить системную печать
        </button>
      </div>
    ) : null;

  if (!pallet) {
    return (
      <section className="warehouse-active-pallet is-empty" aria-label="Текущий палет">
        <div>
          <span>Текущий палет</span>
          <strong>Палет пока не открыт</strong>
          <small>Выберите принятые рулоны для палетного листа.</small>
        </div>
        {feedbackStatus}
        {reprintControls}
      </section>
    );
  }

  return (
    <section className="warehouse-active-pallet" aria-label="Текущий палет">
      <header className="warehouse-active-pallet-header">
        <div>
          <span>Текущий палет №{pallet.sequenceNo}</span>
          <strong>{pallet.palletCode}</strong>
          <small>Заказ {pallet.orderNumber} · только рулоны этого заказа</small>
          {!alreadySealed && <small>Можно печатать до завершения приёмки</small>}
        </div>
        <div className="warehouse-active-pallet-count">
          <strong>{pallet.rollCount}</strong>
          <span>рул.</span>
        </div>
      </header>

      <ol className="warehouse-active-pallet-rolls" aria-label="Рулоны текущего палета">
        {pallet.rows.map((row) => {
          const roll = rollsByCode.get(row.rollCode);
          const details = roll
            ? [
                warehouseRollCharacteristicsLabel(roll),
                warehouseRollDimensionsLabel(roll),
                warehouseRollWeightLabel(roll),
                warehouseRollProductionLabel(roll),
                warehouseRollPackagingLabel(roll),
              ].filter((value): value is string => Boolean(value))
            : [];

          return (
            <li key={row.rollCode}>
              <span>{row.position}</span>
              <div className="warehouse-active-pallet-roll-copy">
                <strong>{row.rollCode}</strong>
                {details.map((detail) => (
                  <small key={detail}>{detail}</small>
                ))}
                <small>{warehousePalletAcceptanceLabel(row)}</small>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="warehouse-active-pallet-controls">
        <button
          type="button"
          className="warehouse-active-pallet-close action-recommended"
          aria-label="Распечатать текущий палетный лист"
          disabled={!canClose}
          onClick={openConfirmation}
        >
          <ix-icon name="print" size="16" />
          <span>
            {pending
              ? 'Закрываем палет…'
              : alreadySealed
                ? 'Палет уже закрыт'
                : phase === 'error'
                  ? 'Проверить закрытие и печать'
                  : 'Распечатать палетный лист'}
          </span>
        </button>
      </div>

      {feedbackStatus}
      {reprintControls}

      {confirmationOpen && (
        <PlenkiModal
          eyebrow="Склад · текущий палет"
          title={`Закрыть ${pallet.palletCode}?`}
          className="warehouse-active-pallet-dialog"
          onClose={() => {
            if (!pending) setConfirmationOpen(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="action-secondary"
                disabled={pending}
                onClick={() => setConfirmationOpen(false)}
              >
                Отмена
              </button>
              <button
                type="button"
                className="action-recommended"
                aria-label="Подтвердить закрытие палета"
                disabled={pending}
                onClick={() => void sealAndPrint()}
              >
                {pending ? 'Закрываем и печатаем…' : 'Закрыть и напечатать'}
              </button>
            </>
          }
        >
          <dl className="warehouse-active-pallet-confirmation">
            <div>
              <dt>Заказ</dt>
              <dd>{pallet.orderNumber}</dd>
            </div>
            <div>
              <dt>Рулонов</dt>
              <dd>{pallet.rollCount}</dd>
            </div>
            <div>
              <dt>Печать</dt>
              <dd>Системное окно Windows</dd>
            </div>
          </dl>
          <p className="warehouse-active-pallet-warning">
            После закрытия добавить рулоны в этот палет будет нельзя.
          </p>
        </PlenkiModal>
      )}
    </section>
  );
}
