import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api/client';
import { createOperationKey, isDeliveryUncertain } from '../../api/idempotentOperation';
import { setWarehousePalletSelection } from '../../api/warehouse';

type PalletSelection = {
  selected: boolean;
  locked: boolean;
  palletId: string | null;
  palletCode: string | null;
};

type RetryIntent = {
  intent: string;
  selected: boolean;
};

function isRetryableSelectionFailure(error: unknown): boolean {
  if (error instanceof ApiError && error.status === 409) return false;
  return isDeliveryUncertain(error);
}

export function WarehousePalletSelectionButton({
  taskId,
  scanRowId,
  rollCode,
  selection,
  locked,
  onWarehouseRefresh,
}: {
  taskId: string;
  scanRowId: string;
  rollCode: string;
  selection: PalletSelection;
  locked: boolean;
  onWarehouseRefresh: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<RetryIntent | null>(null);
  const pendingRef = useRef(false);
  const operationKeysRef = useRef(new Map<string, string>());
  const canonicalRevisionRef = useRef(0);
  const selected = selection.selected;
  const label = selected ? 'В палетном листе' : 'Добавить в палетный лист';
  const ariaLabel = selected
    ? `${rollCode} в палетном листе`
    : `Добавить ${rollCode} в палетный лист`;

  useEffect(() => {
    canonicalRevisionRef.current += 1;
    operationKeysRef.current.delete(`${taskId}:${scanRowId}:true`);
    operationKeysRef.current.delete(`${taskId}:${scanRowId}:false`);
    setError(null);
    setRetry(null);
    return () => {
      canonicalRevisionRef.current += 1;
    };
  }, [locked, scanRowId, selected, selection.palletCode, selection.palletId, taskId]);

  async function submit(nextSelected: boolean, intent = `${taskId}:${scanRowId}:${nextSelected}`) {
    if (pendingRef.current || locked) return;
    const submittedAtRevision = canonicalRevisionRef.current;
    let operationKey = operationKeysRef.current.get(intent);
    try {
      operationKey ??= createOperationKey();
    } catch {
      setError('Не удалось подготовить запрос. Повторите попытку.');
      setRetry(null);
      return;
    }
    operationKeysRef.current.set(intent, operationKey);
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setRetry(null);
    try {
      await setWarehousePalletSelection(taskId, scanRowId, {
        operationKey,
        selected: nextSelected,
      });
      if (canonicalRevisionRef.current !== submittedAtRevision) return;
      operationKeysRef.current.delete(intent);
      onWarehouseRefresh();
    } catch (reason) {
      if (canonicalRevisionRef.current !== submittedAtRevision) return;
      if (isRetryableSelectionFailure(reason)) {
        setError('Не удалось обновить палетный лист. Повторите попытку.');
        setRetry({ intent, selected: nextSelected });
      } else {
        operationKeysRef.current.delete(intent);
        setError('Состав палета изменился. Обновляем данные…');
        setRetry(null);
        onWarehouseRefresh();
      }
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <div className="warehouse-pallet-selection-control">
      <button
        type="button"
        className={`warehouse-row-action warehouse-pallet-selection ${selected ? 'is-selected' : ''}`}
        aria-label={ariaLabel}
        aria-pressed={selected}
        aria-busy={pending || undefined}
        disabled={locked}
        title={
          locked
            ? 'Рулон входит в закрытый палетный лист. Изменения недоступны.'
            : selected
              ? `Исключить ${rollCode} из текущего палетного листа`
              : `Добавить ${rollCode} в текущий палетный лист`
        }
        onClick={() => void submit(!selected)}
      >
        {pending ? 'Обновляем…' : label}
      </button>
      {error && (
        <p className="warehouse-pallet-selection-error" role={retry ? 'alert' : 'status'}>
          <span>{error}</span>
          {retry && (
            <button
              type="button"
              className="warehouse-row-action"
              aria-label={`Повторить ${retry.selected ? 'добавление' : 'исключение'} ${rollCode} в палетный лист`}
              disabled={locked || pending}
              onClick={() => void submit(retry.selected, retry.intent)}
            >
              Повторить
            </button>
          )}
        </p>
      )}
    </div>
  );
}
