import { useState } from 'react';

import type { WarehouseCoverResolutionOutcome } from '../../domain/types';
import { SiemensIcon } from '../shell/SiemensIcon';

export const warehouseOutcomeCopy: Record<WarehouseCoverResolutionOutcome, { label: string; detail: string; nextOwner: string; nextState: string; auditLabel: string; productionEffect: string; icon: string }> = {
  warehouse_recheck_requested: {
    label: 'Попросить склад перепроверить',
    detail: 'Склад сверит остатки.',
    nextOwner: 'Склад',
    nextState: 'Ждет перепроверку',
    auditLabel: 'Запрошена перепроверка склада',
    productionEffect: 'Производство ждет итог',
    icon: 'capacity-check',
  },
  edited_position: {
    label: 'Изменить позицию',
    detail: 'Коммерция меняет параметры.',
    nextOwner: 'Коммерция',
    nextState: 'Позиция на правке',
    auditLabel: 'Позиция изменена после покрытия склада',
    productionEffect: 'Заказ-наряд ждет новую версию',
    icon: 'table-settings',
  },
  rejected_send_all_to_production: {
    label: 'Не использовать складское покрытие',
    detail: 'Вся позиция уйдет в производство.',
    nextOwner: 'Зав. производства',
    nextState: 'Весь объем в производство',
    auditLabel: 'Покрытие разобрано коммерцией',
    productionEffect: 'В производство уйдет весь объем',
    icon: 'tasks-open',
  },
  accepted_with_missing_to_production: {
    label: 'Передать недостачу в производство',
    detail: 'Резерв остается на складе, недостача идет в выпуск.',
    nextOwner: 'Склад и зав. производства',
    nextState: 'Резерв принят, недостача в выпуск',
    auditLabel: 'Недостача передана в производство',
    productionEffect: 'В выпуск уйдет недостача',
    icon: 'check',
  },
};

type WarehouseCoverResolutionPanelProps = {
  requestedQty: number;
  reserveQty: number;
  missingQty: number;
  onSubmit: (outcome: WarehouseCoverResolutionOutcome, reason: string) => void;
};

const recheckReasons = [
  'Остатки не сходятся',
  'Проверить другой рулон',
  'Не та характеристика',
  'Другое',
];

const directOutcomes: WarehouseCoverResolutionOutcome[] = [
  'accepted_with_missing_to_production',
  'edited_position',
  'rejected_send_all_to_production',
];

function outcomeReason(outcome: WarehouseCoverResolutionOutcome, reserveQty: number, requestedQty: number, missingQty: number) {
  if (outcome === 'accepted_with_missing_to_production') {
    return missingQty > 0
      ? `Коммерция принимает ${reserveQty} из ${requestedQty} рул.; ${missingQty} рул. передается зав. производства.`
      : `Коммерция принимает складское покрытие ${reserveQty} из ${requestedQty} рул.; производство по позиции не требуется.`;
  }
  if (outcome === 'edited_position') return 'Коммерция меняет позицию; склад пересчитает покрытие.';
  if (outcome === 'rejected_send_all_to_production') return 'Складское покрытие не используется; вся позиция передана в производство.';
  return 'Причина указана коммерцией.';
}

function outcomeTooltip(copy: (typeof warehouseOutcomeCopy)[WarehouseCoverResolutionOutcome]) {
  const handoff = copy.nextOwner === 'Коммерция' ? '' : `Передается: ${copy.nextOwner}. `;
  return `${handoff}Статус: ${copy.nextState}. ${copy.productionEffect}.`;
}

export function WarehouseCoverResolutionPanel({ requestedQty, reserveQty, missingQty, onSubmit }: WarehouseCoverResolutionPanelProps) {
  const [recheckReason, setRecheckReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const recheckSubmitReason = recheckReason === 'Другое' ? customReason.trim() : recheckReason;

  return (
    <div className="commercial-resolution-panel" aria-label="Разбор складского покрытия">
      <div className="commercial-resolution-head">
        <div>
          <span className="eyebrow">Решение по резерву</span>
          <h5>{missingQty > 0 ? 'Склад не закрывает позицию' : 'Склад закрывает позицию'}</h5>
          <p>Со склада: {reserveQty} из {requestedQty} рул. Остаток: {missingQty} рул.</p>
        </div>
      </div>
      <div className="commercial-resolution-outcomes" aria-label="Исходы по складскому покрытию">
        {directOutcomes.map((outcome) => {
          const copy = warehouseOutcomeCopy[outcome];
          const tooltip = outcomeTooltip(copy);
          return (
            <button
              key={outcome}
              type="button"
              className={`commercial-resolution-outcome outcome-${outcome}`}
              title={tooltip}
              aria-label={`${copy.label}. ${copy.detail}. ${tooltip}`}
              onClick={() => onSubmit(outcome, outcomeReason(outcome, reserveQty, requestedQty, missingQty))}
            >
              <span className="commercial-resolution-outcome-icon"><SiemensIcon name={copy.icon} size="16" /></span>
              <span className="commercial-resolution-outcome-main">
                <strong>{copy.label}</strong>
                <small>{copy.detail}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="commercial-resolution-secondary" aria-label="Перепроверка складского покрытия">
        <div className="commercial-recheck-box">
          <strong>Если склад мог ошибиться</strong>
          <small>{warehouseOutcomeCopy.warehouse_recheck_requested.detail}</small>
          <div className="commercial-reason-chips" role="radiogroup" aria-label="Причина перепроверки склада">
            {recheckReasons.map((item) => (
              <button
                key={item}
                type="button"
                className={recheckReason === item ? 'is-selected' : ''}
                role="radio"
                aria-checked={recheckReason === item}
                onClick={() => setRecheckReason(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {recheckReason === 'Другое' && (
            <textarea
              value={customReason}
              onChange={(event) => setCustomReason(event.target.value)}
              placeholder="Коротко напишите, что проверить складу"
            />
          )}
          <button
            type="button"
            className="compact-action-button action-secondary"
            disabled={!recheckSubmitReason}
            title={!recheckSubmitReason ? 'Сначала выберите причину перепроверки склада' : undefined}
            aria-label={!recheckSubmitReason ? 'Попросить склад перепроверить: сначала выберите причину' : undefined}
            onClick={() => onSubmit('warehouse_recheck_requested', recheckSubmitReason)}
          >
            <SiemensIcon name={warehouseOutcomeCopy.warehouse_recheck_requested.icon} size="16" />
            <span>{warehouseOutcomeCopy.warehouse_recheck_requested.label}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
