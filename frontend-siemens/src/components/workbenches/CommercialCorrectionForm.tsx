import type { CurrentRollResolution } from '../../domain/types';
import { currentRollResolutionLabels } from '../../domain/orderResolution';

type CommercialCorrectionFormProps = {
  reason: string;
  appliesFromRollNumber: number;
  minAppliesFromRoll: number;
  maxAppliesFromRoll: number;
  currentRollResolution: CurrentRollResolution;
  rollOptions?: Array<{ value: number; label: string }>;
  currentRollResolutionOptions?: CurrentRollResolution[];
  disabled?: boolean;
  onReasonChange: (reason: string) => void;
  onAppliesFromRollNumberChange: (rollNumber: number) => void;
  onCurrentRollResolutionChange: (resolution: CurrentRollResolution) => void;
};

export function CommercialCorrectionForm({
  reason,
  appliesFromRollNumber,
  minAppliesFromRoll,
  maxAppliesFromRoll,
  currentRollResolution,
  rollOptions,
  currentRollResolutionOptions,
  disabled = false,
  onReasonChange,
  onAppliesFromRollNumberChange,
  onCurrentRollResolutionChange,
}: CommercialCorrectionFormProps) {
  function clampRollNumber(value: number) {
    return Math.min(maxAppliesFromRoll, Math.max(minAppliesFromRoll, value || minAppliesFromRoll));
  }

  return (
    <div
      className="commercial-correction-form"
      title="После старта производства прямая правка закрыта. Уже выпущенные рулоны не меняются; активный рулон решает зав. производства."
    >
      <label>
        Причина изменения
        <textarea
          value={reason}
          disabled={disabled}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Например: клиент изменил толщину после подтверждения заказа"
        />
      </label>
      <div className="commercial-correction-controls">
        <label>
          Применить с рулона
          {rollOptions ? (
            <select
              required
              disabled={disabled}
              value={appliesFromRollNumber}
              onChange={(event) => onAppliesFromRollNumberChange(Number(event.target.value))}
            >
              {rollOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              min={minAppliesFromRoll}
              max={maxAppliesFromRoll}
              value={appliesFromRollNumber}
              disabled={disabled}
              onChange={(event) =>
                onAppliesFromRollNumberChange(clampRollNumber(Number(event.target.value)))
              }
            />
          )}
        </label>
        <label>
          Текущий рулон
          <select
            value={currentRollResolution}
            disabled={disabled}
            onChange={(event) =>
              onCurrentRollResolutionChange(event.target.value as CurrentRollResolution)
            }
          >
            {(currentRollResolutionOptions ?? Object.keys(currentRollResolutionLabels)).map(
              (value) => (
                <option key={value} value={value}>
                  {currentRollResolutionLabels[value as CurrentRollResolution]}
                </option>
              ),
            )}
          </select>
        </label>
      </div>
    </div>
  );
}
