import { useEffect, useRef, useState } from 'react';

import { financeCoverageApi } from '../../api/finance';
import { IdempotentOperationGate } from '../../api/idempotentOperation';
import {
  coverageReasonLabel,
  type FinanceWarehouseCoverageRollView,
  type FinanceWarehouseCoverageView,
  type WarehouseCoverageAction,
  type WarehouseCoverageRollSpecificationView,
} from '../../domain/warehouseCoverage';

export interface WarehouseCoverageCardProps {
  financeOrderId: string;
  coverage: FinanceWarehouseCoverageView;
  busyAction: WarehouseCoverageAction | null;
  onCoverageChanged(next: FinanceWarehouseCoverageView): void;
}

export function FinanceWarehouseCoverage({
  financeOrderId,
  refreshGeneration = 0,
}: {
  financeOrderId: string;
  refreshGeneration?: number;
}) {
  const [coverage, setCoverage] = useState<FinanceWarehouseCoverageView | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void financeCoverageApi.read(financeOrderId).then(
      (result) => {
        if (active)
          setCoverage((current) =>
            !current || result.stateVersion >= current.stateVersion ? result : current,
          );
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [financeOrderId, attempt, refreshGeneration]);

  if (coverage) {
    return (
      <>
        {failed && <p role="alert">Не удалось обновить складское покрытие.</p>}
        <WarehouseCoverageCard
          financeOrderId={financeOrderId}
          coverage={coverage}
          busyAction={null}
          onCoverageChanged={setCoverage}
        />
      </>
    );
  }

  return (
    <section className="finance-coverage-decision" aria-label="Складское покрытие заказа">
      <h4>Складское покрытие</h4>
      {failed ? (
        <>
          <p role="alert">Не удалось загрузить складское покрытие.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить загрузку
          </button>
        </>
      ) : (
        <p role="status">Загружаем расчёт…</p>
      )}
    </section>
  );
}

const actionLabels: Partial<Record<WarehouseCoverageAction, string>> = {
  use_warehouse: 'Использовать рулоны со склада',
  produce_all: 'Произвести весь заказ',
  request_recheck: 'Отправить на перепроверку склада',
  refresh: 'Обновить расчёт',
};

const busyLabels: Partial<Record<WarehouseCoverageAction, string>> = {
  use_warehouse: 'Резервируем рулоны…',
  produce_all: 'Передаём заказ в производство…',
  request_recheck: 'Отправляем запрос складу…',
  refresh: 'Обновляем расчёт…',
};

function coverageSummary(coverage: FinanceWarehouseCoverageView): string {
  if (coverage.state === 'production_required') {
    return 'Заказ полностью направлен в производство';
  }
  if (coverage.state === 'warehouse_reserved') {
    return 'Рулоны со склада зарезервированы';
  }
  if (coverage.state === 'recheck_requested') {
    return 'Склад перепроверяет доступные рулоны';
  }
  if (coverage.state === 'order_spec_changed') {
    return 'Параметры заказа изменились — обновляем расчёт';
  }
  if (coverage.stale || coverage.state === 'stale') {
    return 'Остатки изменились — обновляем расчёт';
  }
  if (coverage.availability === 'verified_full') {
    return `Подтверждено ${coverage.matchedRollCount} из ${coverage.requiredRollCount} рулонов`;
  }
  if (coverage.availability === 'unavailable') {
    return 'Заказ полностью направлен в производство';
  }
  return 'Требуется безопасная проверка данных';
}

function safeCoverageError(): string {
  return 'Не удалось обновить складское покрытие. Данные не изменены — повторите действие.';
}

const coverageNumber = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 });

function formatNumber(value: number | null, unit: string): string {
  return value === null ? '—' : `${coverageNumber.format(value)} ${unit}`;
}

function formatThickness(spec: WarehouseCoverageRollSpecificationView): string {
  if (spec.actualThicknessMicron === null && spec.accountingThicknessMicron === null) return '—';
  const actual = formatNumber(spec.actualThicknessMicron, 'мкм');
  return spec.accountingThicknessMicron === null
    ? actual
    : `${actual} (бух. ${formatNumber(spec.accountingThicknessMicron, 'мкм')})`;
}

function formatDimensions(spec: WarehouseCoverageRollSpecificationView): string {
  if (spec.widthMm === null && spec.plannedLengthM === null) return '—';
  return `${formatNumber(spec.widthMm, 'мм')} × ${formatNumber(spec.plannedLengthM, 'м')}`;
}

function valueOrDash(value: string | null): string {
  return value ?? '—';
}

function evidenceRows(roll: FinanceWarehouseCoverageRollView) {
  return [
    {
      label: 'Плёнка',
      requested: valueOrDash(roll.requested.filmType),
      matched: valueOrDash(roll.matched.filmType),
    },
    {
      label: 'Толщина',
      requested: formatThickness(roll.requested),
      matched: formatThickness(roll.matched),
    },
    {
      label: 'Размер',
      requested: formatDimensions(roll.requested),
      matched: formatDimensions(roll.matched),
    },
    {
      label: 'Нетто',
      requested: formatNumber(roll.requested.netKg, 'кг'),
      matched: formatNumber(roll.matched.netKg, 'кг'),
    },
    {
      label: 'Шпуля',
      requested: valueOrDash(roll.requested.spoolType),
      matched: valueOrDash(roll.matched.spoolType),
    },
    {
      label: 'Бирка',
      requested: valueOrDash(roll.requested.birka),
      matched: valueOrDash(roll.matched.birka),
    },
    {
      label: 'Состав',
      requested: valueOrDash(roll.requested.materialLabel),
      matched: valueOrDash(roll.matched.materialLabel),
    },
  ];
}

function equivalentEvidence(left: string, right: string): boolean {
  const normalize = (value: string) =>
    value.toLocaleLowerCase('ru-RU').replace(/\s+/gu, '').replace(/ё/gu, 'е');
  return normalize(left) === normalize(right);
}

function sourceLabel(source: FinanceWarehouseCoverageRollView['source']): string {
  if (source === 'platform') return 'Платформа';
  if (source === 'production') return 'Производство';
  return 'Ранее учтённый резерв';
}

function receivedLabel(value: string | null): string {
  if (value === null) return 'Дата приёмки не указана';
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}

export function WarehouseCoverageCard({
  financeOrderId,
  coverage,
  busyAction,
  onCoverageChanged,
}: WarehouseCoverageCardProps): JSX.Element {
  const operationGateRef = useRef(new IdempotentOperationGate());
  const refreshedSnapshotsRef = useRef(new Set<string>());
  const currentOrderRef = useRef(financeOrderId);
  const [localBusyAction, setLocalBusyAction] = useState<WarehouseCoverageAction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [recheckReason, setRecheckReason] = useState('');
  const effectiveBusyAction = busyAction ?? localBusyAction;
  const serializationKey = `finance:warehouse-coverage:${financeOrderId}`;
  const reasonLabels = Array.from(
    new Set(coverage.reasonCodes.map((reason) => coverageReasonLabel(reason))),
  );

  currentOrderRef.current = financeOrderId;

  const startAction = (
    action: WarehouseCoverageAction,
    execute: (clientRequestId: string) => Promise<FinanceWarehouseCoverageView>,
  ) => {
    const orderAtStart = financeOrderId;
    const request = operationGateRef.current.start(action, execute, serializationKey);
    if (!request) return;

    setErrorMessage(null);
    setLocalBusyAction(action);
    void request
      .then((next) => {
        if (currentOrderRef.current !== orderAtStart) return;
        onCoverageChanged(next);
        if (action === 'request_recheck') {
          setRecheckOpen(false);
          setRecheckReason('');
        }
      })
      .catch(() => {
        if (currentOrderRef.current === orderAtStart) {
          setErrorMessage(safeCoverageError());
        }
      })
      .finally(() => {
        if (currentOrderRef.current === orderAtStart) {
          setLocalBusyAction(null);
        }
      });
  };

  const startRefresh = () => {
    startAction('refresh', (clientRequestId) =>
      financeCoverageApi.refresh(financeOrderId, {
        clientRequestId,
        expectedGeneration: coverage.generation,
        expectedStateVersion: coverage.stateVersion,
      }),
    );
  };

  useEffect(() => {
    if (!coverage.stale && coverage.state !== 'stale') return;
    if (!coverage.availableActions.includes('refresh')) return;
    const snapshotKey = [financeOrderId, coverage.generation ?? 'none', coverage.stateVersion].join(
      ':',
    );
    if (refreshedSnapshotsRef.current.has(snapshotKey)) return;
    refreshedSnapshotsRef.current.add(snapshotKey);
    startRefresh();
  }, [
    coverage.availableActions,
    coverage.generation,
    coverage.stale,
    coverage.state,
    coverage.stateVersion,
    financeOrderId,
  ]);

  const startDecision = (decision: 'use_warehouse' | 'produce_all') => {
    const expectedGeneration = coverage.generation;
    if (expectedGeneration === null) {
      setErrorMessage(safeCoverageError());
      return;
    }
    startAction(decision, (clientRequestId) =>
      financeCoverageApi.decide(financeOrderId, {
        clientRequestId,
        expectedGeneration,
        expectedStateVersion: coverage.stateVersion,
        decision,
      }),
    );
  };

  const submitRecheck = () => {
    const reason = recheckReason.trim();
    if (reason.length < 3) {
      setErrorMessage('Укажите причину перепроверки — минимум 3 символа.');
      return;
    }
    if (reason.length > 500) {
      setErrorMessage('Причина перепроверки должна быть короче 500 символов.');
      return;
    }
    const expectedGeneration = coverage.generation;
    if (expectedGeneration === null) {
      setErrorMessage(safeCoverageError());
      return;
    }
    startAction('request_recheck', async (clientRequestId) => {
      const next = await financeCoverageApi.requestRecheck(financeOrderId, {
        clientRequestId,
        expectedGeneration,
        expectedStateVersion: coverage.stateVersion,
        reason,
      });
      return next;
    });
  };

  return (
    <section
      className="finance-coverage-decision"
      aria-label="Складское покрытие заказа"
      data-coverage-state={coverage.state}
    >
      <div className="finance-coverage-heading">
        <div>
          <span>Автоматическая проверка</span>
          <h4>Складское покрытие</h4>
        </div>
        <strong>{coverageSummary(coverage)}</strong>
      </div>

      {reasonLabels.length > 0 && coverage.availability !== 'verified_full' ? (
        <ul className="finance-coverage-reasons" aria-label="Причины расчёта">
          {reasonLabels.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}

      {coverage.financeRolls.length > 0 ? (
        <div className="finance-coverage-rolls" aria-label="Рулоны для решения">
          <span>Рулоны, подтверждённые расчётом</span>
          <ul>
            {coverage.financeRolls.map((roll) => {
              const rows = evidenceRows(roll);
              return (
                <li key={`${roll.rollCode}:${roll.positionId}`} data-coverage-roll={roll.rollCode}>
                  <header>
                    <div>
                      <strong>{roll.rollCode}</strong>
                      <small>
                        {sourceLabel(roll.source)} · {roll.locationLabel}
                      </small>
                    </div>
                    <div>
                      <small>{roll.batchCode ? `Партия ${roll.batchCode}` : 'Без партии'}</small>
                      <small>{receivedLabel(roll.receivedAt)}</small>
                    </div>
                  </header>
                  <div
                    className="finance-coverage-roll-comparison"
                    role="table"
                    aria-label={`Сверка рулона ${roll.rollCode}`}
                  >
                    <div className="is-head" role="row">
                      <span role="columnheader">Параметр</span>
                      <span role="columnheader">Запрошено</span>
                      <span role="columnheader">Найдено</span>
                    </div>
                    {rows.map((row) => (
                      <div
                        key={row.label}
                        role="row"
                        className={
                          equivalentEvidence(row.requested, row.matched)
                            ? 'is-match'
                            : 'is-different'
                        }
                      >
                        <span role="rowheader">{row.label}</span>
                        <span role="cell">{row.requested}</span>
                        <span role="cell">{row.matched}</span>
                      </div>
                    ))}
                  </div>
                  <p className="finance-coverage-roll-weights">
                    <span>Нетто {formatNumber(roll.matched.netKg, 'кг')}</span>
                    <span>Брутто {formatNumber(roll.grossKg, 'кг')}</span>
                    <span>Шпуля {formatNumber(roll.spoolKg, 'кг')}</span>
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {coverage.availableActions.some((action) => actionLabels[action]) ? (
        <div className="finance-coverage-actions" aria-label="Действия по покрытию">
          {coverage.availableActions.map((action) => {
            const label = actionLabels[action];
            if (!label) return null;
            if (action === 'request_recheck') {
              return (
                <button
                  key={action}
                  className="compact-action-button action-secondary"
                  type="button"
                  disabled={effectiveBusyAction !== null}
                  onClick={() => {
                    setErrorMessage(null);
                    setRecheckOpen(true);
                  }}
                >
                  {label}
                </button>
              );
            }
            return (
              <button
                key={action}
                className={`compact-action-button ${
                  action === 'use_warehouse' ? 'action-recommended' : 'action-secondary'
                }`}
                type="button"
                disabled={effectiveBusyAction !== null}
                onClick={() => {
                  if (action === 'refresh') startRefresh();
                  if (action === 'use_warehouse' || action === 'produce_all') {
                    startDecision(action);
                  }
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}

      {recheckOpen && coverage.availableActions.includes('request_recheck') ? (
        <div className="finance-coverage-recheck">
          <label htmlFor={`coverage-recheck-${financeOrderId}`}>Причина перепроверки</label>
          <textarea
            id={`coverage-recheck-${financeOrderId}`}
            value={recheckReason}
            rows={2}
            maxLength={500}
            disabled={effectiveBusyAction !== null}
            onChange={(event) => setRecheckReason(event.target.value)}
          />
          <div>
            <button
              className="compact-action-button action-secondary"
              type="button"
              disabled={effectiveBusyAction !== null}
              onClick={() => setRecheckOpen(false)}
            >
              Отмена
            </button>
            <button
              className="compact-action-button action-recommended"
              type="button"
              disabled={effectiveBusyAction !== null || recheckReason.trim().length < 3}
              onClick={submitRecheck}
            >
              Подтвердить перепроверку
            </button>
          </div>
        </div>
      ) : null}

      {effectiveBusyAction ? (
        <p className="finance-coverage-feedback" role="status" aria-live="polite">
          {busyLabels[effectiveBusyAction] ?? 'Обновляем данные…'}
        </p>
      ) : errorMessage ? (
        <p className="finance-coverage-feedback is-error" role="alert">
          {errorMessage}
        </p>
      ) : (
        <p className="finance-coverage-feedback" aria-hidden="true" />
      )}
    </section>
  );
}
