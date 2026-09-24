import { createOperationKey } from '../../api/idempotentOperation';
import {
  DEFECT_BAG_TYPES,
  defectBagDisplayLabel,
  defectBagTypeLabel,
  operatorDefectBagWeighAction,
  operatorShiftDefectBags,
} from '../../domain/defectBagLabels';
import type { BigBagWeightDraft } from '../../domain/operatorRuntime';
import type { OperatorShift, OperatorShiftDefectBag } from '../../domain/types';
import { formatOperatorScaleKg as formatKg } from './operatorScalePreview';

export function hasDefectBagDraft(draft: BigBagWeightDraft) {
  return Boolean(draft.defectBagDraftId || draft.defectBagKg || draft.defectBagType);
}

function bagSummary(bag: OperatorShiftDefectBag) {
  if (bag.weightKg === 0) return '0 кг · QR не требуется';
  const status = {
    weighed: 'QR не напечатан',
    ready_for_warehouse: 'Готов к передаче на склад',
    received: 'Принят складом',
    shipped: 'Отгружен',
  }[bag.status];
  return `${defectBagTypeLabel(bag.defectType)} · ${formatKg(bag.weightKg)} кг · ${status}`;
}

export function OperatorDefectBagsPanel({
  shift,
  draft,
  onDraftChange,
  onAction,
  pendingActionId,
}: {
  shift: OperatorShift;
  draft: BigBagWeightDraft;
  onDraftChange?: (draft: BigBagWeightDraft) => void;
  onAction?: (actionId: string) => void;
  pendingActionId?: string | null;
}) {
  const bags = operatorShiftDefectBags(shift);
  const editable = shift.status === 'close_pending';
  const showDraft = editable && (bags.length === 0 || hasDefectBagDraft(draft));
  const pending = Boolean(pendingActionId);
  const rawWeight = draft.defectBagKg ?? '';
  const parsed = Number(rawWeight.trim().replace(',', '.'));
  const weight =
    rawWeight.trim() && Number.isFinite(parsed) && parsed >= 0 && parsed <= 10_000
      ? Number(parsed.toFixed(3))
      : null;
  const invalid = rawWeight.trim().length > 0 && weight === null;
  const changeDraft = (patch: Partial<BigBagWeightDraft>) =>
    onDraftChange?.({
      ...draft,
      defectBagDraftId: draft.defectBagDraftId ?? createOperationKey(),
      ...patch,
    });
  if (!editable && !(shift.status === 'closed' && bags.length > 0)) return null;

  return (
    <section className="defect-bags-panel" aria-label="Биг-беги брака">
      <h4>Биг-беги брака</h4>
      {bags.map((bag) => {
        const label = bag.weightKg === 0 ? 'Брак отсутствует' : defectBagDisplayLabel(bag);
        const reprint = bag.labelState === 'failed';
        return (
          <div className="defect-bag-handoff" key={bag.id} aria-label={`Мешок брака ${label}`}>
            <div>
              <strong>{label}</strong>
              <small>{bagSummary(bag)}</small>
            </div>
            {editable && bag.weightKg > 0 && bag.status === 'weighed' && bag.labelState !== 'delivery_unknown' && (
              <button
                type="button"
                className="compact-action-button action-recommended"
                disabled={pending}
                aria-label={`${reprint ? 'Повторить печать QR' : 'Напечатать QR мешка'} ${label}`}
                onClick={() =>
                  onAction?.(`operator-${reprint ? 'reprint' : 'print'}-defect-bag:${bag.id}`)
                }
              >
                <ix-icon name="print" size="16" />
                <span>{reprint ? 'Повторить печать QR' : 'Напечатать QR мешка'}</span>
              </button>
            )}
            {editable && bag.labelState === 'delivery_unknown' && (
              <small role="alert">Исход печати неизвестен. Обратитесь к администратору.</small>
            )}
          </div>
        );
      })}
      {showDraft && (
        <div className="defect-bag-handoff" aria-label="Новый мешок брака">
          <div
            className={`manual-bigbag-row defect-bag-manual-weight ${invalid ? 'has-error' : ''}`}
          >
            <div className="defect-bag-type-picker" role="group" aria-label="Тип брака">
              {DEFECT_BAG_TYPES.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={draft.defectBagType === type ? 'is-selected' : undefined}
                  aria-label={`Тип брака: ${defectBagTypeLabel(type)}`}
                  aria-pressed={draft.defectBagType === type}
                  disabled={pending}
                  onClick={() => changeDraft({ defectBagType: type })}
                >
                  {defectBagTypeLabel(type)}
                </button>
              ))}
            </div>
            <label htmlFor="defect-bag-weight">
              <span>Вес брака, кг</span>
              <input
                id="defect-bag-weight"
                type="number"
                inputMode="decimal"
                min="0"
                max="10000"
                step="0.001"
                value={rawWeight}
                disabled={pending}
                placeholder="12,4"
                aria-label="Вес мешка брака, кг"
                aria-invalid={invalid}
                onChange={(event) => changeDraft({ defectBagKg: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="compact-action-button manual-bigbag-action action-recommended"
              disabled={(weight !== 0 && !draft.defectBagType) || weight === null || pending}
              aria-busy={pending}
              aria-label="Зафиксировать вес мешка брака"
              title={
                !draft.defectBagType && weight !== 0
                  ? 'Выберите тип брака'
                  : weight === null
                    ? 'Введите вес от 0 до 10000 кг'
                    : undefined
              }
              onClick={() =>
                weight !== null && (weight === 0 || draft.defectBagType) &&
                onAction?.(
                  operatorDefectBagWeighAction(draft.defectBagType ?? null, weight, draft.defectBagDraftId),
                )
              }
            >
              <span>{pending ? 'Сохраняем…' : 'Зафиксировать вес'}</span>
            </button>
          </div>
          {bags.length > 0 && (
            <button
              type="button"
              className="secondary-button"
              disabled={pending}
              onClick={() =>
                onDraftChange?.({
                  ...draft,
                  defectBagDraftId: undefined,
                  defectBagKg: '',
                  defectBagType: undefined,
                })
              }
            >
              Убрать черновик
            </button>
          )}
        </div>
      )}
      {editable && (
        <button
          type="button"
          className="secondary-button"
          aria-label="Добавить биг-бег брака"
          disabled={showDraft || pending}
          onClick={() =>
            changeDraft({
              defectBagDraftId: createOperationKey(),
              defectBagKg: '',
              defectBagType: undefined,
            })
          }
        >
          <span aria-hidden="true">＋</span> Добавить биг-бег брака
        </button>
      )}
    </section>
  );
}
