import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { IdempotentOperationGate, isDeliveryUncertain } from '../../api/idempotentOperation';
import { voidWarehousePallet, type WarehousePalletVoidReasonCode } from '../../api/warehouse';
import type { PalletListDocument } from '../../domain/types';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';

const MAX_NOTE_LENGTH = 500;

const VOID_REASONS: Array<{ value: WarehousePalletVoidReasonCode; label: string }> = [
  { value: 'wrong_composition', label: 'Неверный состав палета' },
  { value: 'print_problem', label: 'Проблема с печатью этикетки' },
  { value: 'other', label: 'Другая причина' },
];

type VoidablePalletDocument = Pick<
  PalletListDocument,
  'palletId' | 'warehousePalletId' | 'origin' | 'documentStatus' | 'printStatus'
>;

type VoidPayload = {
  reasonCode: WarehousePalletVoidReasonCode;
  note?: string;
};

function safeTerminalMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 403) {
    return 'Недостаточно прав для аннулирования палетного листа.';
  }
  if (error instanceof ApiError && error.status === 404) {
    return 'Палетный лист больше не найден. Обновите данные приемки.';
  }
  return 'Не удалось аннулировать палетный лист. Обновите данные и повторите действие.';
}

export function canVoidPalletDocument(document: VoidablePalletDocument) {
  return Boolean(
    document.origin === 'physical_pallet' &&
      document.documentStatus === 'sealed' &&
      document.warehousePalletId,
  );
}

export function VoidPalletDialog({
  taskId,
  document,
  onClose,
  onSuccess,
  onCanonicalRefresh,
}: {
  taskId: string;
  document: VoidablePalletDocument;
  onClose: () => void;
  onSuccess: () => void;
  onCanonicalRefresh: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<WarehousePalletVoidReasonCode | ''>('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<VoidPayload | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const generationRef = useRef(0);
  const gateRef = useRef(new IdempotentOperationGate());

  const palletId = document.warehousePalletId;
  const isVoidable = canVoidPalletDocument(document);
  const normalizedNote = note.trim();
  const valid = Boolean(reasonCode) && normalizedNote.length <= MAX_NOTE_LENGTH;
  const targetKey = `${taskId}:${palletId ?? 'none'}:${document.documentStatus ?? 'unknown'}`;
  const targetKeyRef = useRef(targetKey);

  useEffect(() => {
    if (targetKeyRef.current === targetKey) return;
    targetKeyRef.current = targetKey;
    generationRef.current += 1;
    pendingRef.current = false;
    gateRef.current = new IdempotentOperationGate();
    setReasonCode('');
    setNote('');
    setPending(false);
    setRetry(null);
    setFeedback(null);
  }, [targetKey]);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  if (!isVoidable || typeof palletId !== 'string') return null;
  const voidTargetPalletId = palletId;

  function close() {
    if (!pendingRef.current && !retry) onClose();
  }

  async function submit(payload: VoidPayload) {
    if (pendingRef.current) return;
    const generation = generationRef.current;
    const intent = `warehouse:void:${taskId}:${voidTargetPalletId}`;
    const request = gateRef.current.start(
      intent,
      (operationKey) =>
        voidWarehousePallet(taskId, voidTargetPalletId, { operationKey, ...payload }),
    );
    if (!request) return;

    pendingRef.current = true;
    setPending(true);
    setFeedback(null);
    setRetry(null);
    try {
      const result = await request;
      if (generationRef.current !== generation) return;
      if (result.documentStatus !== 'voided') {
        setFeedback('Аннулирование не подтверждено. Обновите данные приёмки.');
        onCanonicalRefresh();
        return;
      }
      onSuccess();
      onClose();
    } catch (error: unknown) {
      if (generationRef.current !== generation) return;
      if (error instanceof ApiError && error.status === 409) {
        onCanonicalRefresh();
        onClose();
        return;
      }
      if (isDeliveryUncertain(error)) {
        setRetry(payload);
        setFeedback(
          'Статус аннулирования не подтвержден. Повторная проверка отправит тот же запрос.',
        );
        return;
      }
      setFeedback(safeTerminalMessage(error));
    } finally {
      if (generationRef.current === generation) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  const submitCurrent = () => {
    if (!reasonCode || !valid) return;
    void submit({
      reasonCode,
      ...(normalizedNote ? { note: normalizedNote } : {}),
    });
  };

  return (
    <PlenkiModal
      eyebrow="Склад · палетный лист"
      title={`Аннулировать ${document.palletId}?`}
      className="warehouse-void-pallet-dialog"
      onClose={close}
      footer={
        <>
          <button
            type="button"
            className="action-secondary"
            disabled={pending || Boolean(retry)}
            onClick={close}
          >
            Отмена
          </button>
          {retry ? (
            <button
              type="button"
              className="action-recommended"
              aria-label="Повторить аннулирование палетного листа"
              disabled={pending}
              onClick={() => void submit(retry)}
            >
              Повторить аннулирование
            </button>
          ) : (
            <button
              type="button"
              className="action-recommended"
              aria-label="Подтвердить аннулирование палетного листа"
              disabled={pending || !valid}
              onClick={submitCurrent}
            >
              {pending ? 'Аннулируем…' : 'Аннулировать палетный лист'}
            </button>
          )}
        </>
      }
    >
      <div className="warehouse-void-pallet-dialog-content">
        <p className="warehouse-void-pallet-warning">
          Напечатанную этикетку необходимо уничтожить. QR-код прежнего листа останется доступен
          для трассировки.
        </p>
        {document.printStatus === 'needs_admin' && (
          <p className="warehouse-void-pallet-warning is-urgent" role="alert">
            Доставка на принтер не подтверждена: бумажная этикетка уже могла быть напечатана.
          </p>
        )}
        <label className="warehouse-void-pallet-field">
          <span>Причина аннулирования</span>
          <select
            aria-label="Причина аннулирования"
            autoFocus
            value={reasonCode}
            disabled={pending || Boolean(retry)}
            onChange={(event) => {
              setReasonCode(event.target.value as WarehousePalletVoidReasonCode | '');
              setFeedback(null);
            }}
          >
            <option value="">Выберите причину</option>
            {VOID_REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
          {!reasonCode && <small role="status">Выберите причину аннулирования.</small>}
        </label>
        <label className="warehouse-void-pallet-field">
          <span>Комментарий (необязательно)</span>
          <textarea
            aria-label="Комментарий к аннулированию"
            rows={4}
            maxLength={MAX_NOTE_LENGTH}
            value={note}
            disabled={pending || Boolean(retry)}
            onChange={(event) => {
              setNote(event.target.value);
              setFeedback(null);
            }}
            placeholder="Например: собрать палет заново"
          />
          <small>{normalizedNote.length} / {MAX_NOTE_LENGTH}</small>
        </label>
        {feedback && <p className="warehouse-void-pallet-feedback" role="alert">{feedback}</p>}
      </div>
    </PlenkiModal>
  );
}
