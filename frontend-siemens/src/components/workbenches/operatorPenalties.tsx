import { IxEmptyState } from '@siemens/ix-react';

import { SeverityPill } from '../shell/viewPrimitives';
import type { PenaltyRuntime } from '../../domain/runtime';
import {
  penaltyHistoryActionLabel,
  penaltyStatusLabel,
} from '../../domain/runtime/penaltyView';

export function OperatorPenaltiesSurface({
  penalties,
  selectedPenaltyId,
}: {
  penalties: PenaltyRuntime[];
  selectedPenaltyId: string | null;
}) {
  const selectedPenalty = penalties.find((penalty) => `OP-${penalty.penaltyId}` === selectedPenaltyId || penalty.penaltyId === selectedPenaltyId) ?? penalties[0] ?? null;

  if (!selectedPenalty) {
    return (
      <section className="operator-shift-surface" aria-label="Мои штрафы">
        <IxEmptyState header="Штрафов нет" subHeader="Здесь появятся только ваши назначенные штрафы и история уведомлений." />
      </section>
    );
  }

  return (
    <section className="operator-shift-surface" aria-label="Мои штрафы">
      <div className="operator-shift-panel shift-active">
        <div className="operator-panel-title">
          <div>
            <span>Мои штрафы</span>
            <h2>{selectedPenalty.penaltyId}</h2>
          </div>
          <SeverityPill severity="warning" />
        </div>

        <div className="operator-roll-facts">
          <div className="roll-fact">
            <small>Дата</small>
            <strong>{selectedPenalty.updatedAt ?? selectedPenalty.createdAt}</strong>
          </div>
          <div className="roll-fact">
            <small>Сумма штрафа</small>
            <strong>{selectedPenalty.amountLabel}</strong>
          </div>
          <div className="roll-fact">
            <small>Статус</small>
            <strong>{penaltyStatusLabel(selectedPenalty.status)}</strong>
          </div>
          <div className="roll-fact">
            <small>Связанный объект</small>
            <strong>{selectedPenalty.scopeObjectId}</strong>
          </div>
          <div className="roll-fact is-wide">
            <small>Причина</small>
            <strong>{selectedPenalty.reason}</strong>
          </div>
        </div>
      </div>

      <div className="operator-shift-panel">
        <div className="operator-panel-title">
          <div>
            <span>История</span>
            <h2>Уведомления и изменения</h2>
          </div>
        </div>
        <div className="audit-list compact">
          {selectedPenalty.history.map((item) => (
            <article key={item.id} className="audit-entry">
              <span>{item.time} · {item.actorLabel}</span>
              <strong>{penaltyHistoryActionLabel(item.actionLabel)}</strong>
              <p>{item.detail}</p>
              {(item.oldValue || item.newValue) && (
                <small>Было: {item.oldValue ?? 'нет'} · Стало: {item.newValue ?? 'нет'}</small>
              )}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
