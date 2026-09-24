import { useEffect, useState } from 'react';

import type { CurrentRollResolution, WorkObject } from '../../domain/types';
import { currentRollResolutionLabels } from '../../domain/orderResolution';
import { CommercialCorrectionForm } from './CommercialCorrectionForm';

type CommercialProductionProblemPanelProps = {
  object: WorkObject;
  onAction?: (actionId: string) => void;
};

export function CommercialProductionProblemPanel({ object, onAction }: CommercialProductionProblemPanelProps) {
  const problem = object.productionProblems?.find((item) => item.status !== 'resolved');
  const progress = object.commercialProductionProgress;
  const correctionRequested = problem?.status === 'correction_requested';
  const currentRoll = progress?.currentRollNumber ?? problem?.currentRollNumber ?? 1;
  const totalRolls = progress?.totalRolls ?? problem?.totalRolls ?? currentRoll;
  const minAppliesFromRoll = Math.min(totalRolls, Math.max(1, currentRoll));
  const [reason, setReason] = useState('');
  const [appliesFromRollNumber, setAppliesFromRollNumber] = useState(minAppliesFromRoll);
  const [currentRollResolution, setCurrentRollResolution] = useState<CurrentRollResolution>('requires_production_decision');
  const submittedCorrection = object.orderResolutionCases?.find((item) =>
    item.type === 'production_current_roll_resolution'
    && item.status === 'awaiting_production'
    && item.recipeCorrectionRequest
  );

  useEffect(() => {
    setReason('');
    setAppliesFromRollNumber(minAppliesFromRoll);
    setCurrentRollResolution('requires_production_decision');
  }, [problem?.id, minAppliesFromRoll]);

  function submitCorrection() {
    const normalizedReason = reason.trim();
    if (!normalizedReason) return;
    onAction?.(`commercial-request-correction-submitted:${appliesFromRollNumber}:${currentRollResolution}:${encodeURIComponent(normalizedReason)}`);
  }

  if (!problem && !progress) return null;

  return (
    <section className={`commercial-panel commercial-production-problem-panel severity-${problem?.severity ?? 'info'}`} aria-label="Проблема и прогресс производства">
      <div className="commercial-panel-title">
        <div>
          <span className="eyebrow">Производство сообщило в коммерцию</span>
          <h4>{problem ? 'Разобрать проблему производства' : 'Прогресс производства'}</h4>
        </div>
        <span className={`commercial-state-badge ${problem ? 'state-blocked' : 'state-ready'}`}>
          {correctionRequested ? 'Ждет решение производства' : problem ? 'Нужно решение коммерции' : 'Без открытой проблемы'}
        </span>
      </div>

      <div className="commercial-cover-summary">
        <div><span>Готово</span><strong>{progress?.completedRolls ?? problem?.completedRolls ?? 0} рул.</strong></div>
        <div><span>Текущий</span><strong>{progress?.currentRollNumber ?? problem?.currentRollNumber ?? '-'} рулон</strong></div>
        <div><span>Всего</span><strong>{progress?.totalRolls ?? problem?.totalRolls ?? '-'} рул.</strong></div>
        <div><span>Источник</span><strong>{progress?.source === 'mock' ? 'рабочий экран производства' : progress?.source ?? 'производство'}</strong></div>
      </div>

      {problem && (
        <div className={`commercial-inline-problem severity-${problem.severity}`}>
          <strong>{problem.comment}</strong>
          <span>Позиция: {problem.positionId ?? 'не указана'} · Рулон: {problem.rollId ?? 'не указан'}</span>
          <small>{correctionRequested ? 'Ждет решение зав. производства' : 'Нужно изменение параметров'}</small>
        </div>
      )}

      {problem && !correctionRequested && (
        <div className="commercial-correction-delta" aria-label="Изменение позиции после проблемы производства">
          <div>
            <span>Сейчас</span>
            <strong>{problem.comment}</strong>
            <small>Текущий рулон: {currentRoll}. Уже готово: {problem.completedRolls ?? progress?.completedRolls ?? 0} из {totalRolls}.</small>
          </div>
          <div>
            <span>После изменения</span>
            <strong>Новая версия с рулона {appliesFromRollNumber}</strong>
            <small>Текущий рулон: {currentRollResolutionLabels[currentRollResolution]}.</small>
          </div>
        </div>
      )}

      {problem && correctionRequested && submittedCorrection?.recipeCorrectionRequest && (
        <div className="commercial-correction-delta" aria-label="Переданное изменение позиции">
          <div>
            <span>Передано</span>
            <strong>Новая версия с рулона {submittedCorrection.recipeCorrectionRequest.appliesFromRollNumber}</strong>
            <small>Причина: {submittedCorrection.recipeCorrectionRequest.reason}</small>
          </div>
          <div>
            <span>Текущий рулон</span>
            <strong>{currentRollResolutionLabels[submittedCorrection.recipeCorrectionRequest.currentRollResolution]}</strong>
            <small>Владелец следующего решения: зав. производства.</small>
          </div>
        </div>
      )}

      {problem && !correctionRequested && (
        <CommercialCorrectionForm
          reason={reason}
          appliesFromRollNumber={appliesFromRollNumber}
          minAppliesFromRoll={minAppliesFromRoll}
          maxAppliesFromRoll={Math.max(minAppliesFromRoll, totalRolls)}
          currentRollResolution={currentRollResolution}
          onReasonChange={setReason}
          onAppliesFromRollNumberChange={setAppliesFromRollNumber}
          onCurrentRollResolutionChange={setCurrentRollResolution}
        />
      )}

      <div className="commercial-context-actions">
        {problem && !correctionRequested && (
          <button
            className="compact-action-button action-recommended"
            type="button"
            disabled={!reason.trim()}
            title={!reason.trim() ? 'Укажите причину изменения' : 'Передать изменение зав. производства'}
            onClick={submitCorrection}
          >
            <ix-icon name="warning" size="16" />
            <span>Передать изменение</span>
          </button>
        )}
        <button className="compact-action-button action-secondary" type="button" onClick={() => onAction?.('commercial-open-production')}>
          <ix-icon name="tasks-open" size="16" />
          <span>Статус производства</span>
        </button>
      </div>
    </section>
  );
}
