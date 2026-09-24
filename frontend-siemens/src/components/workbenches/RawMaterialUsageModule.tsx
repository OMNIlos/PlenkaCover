import { useMemo, useState } from 'react';

import {
  buildRawMaterialModuleProjection,
  type RawMaterialModuleRow,
  type RawMaterialModuleTab,
} from '../../domain/rawMaterialUsage';
import type { Role, WorkObject } from '../../domain/types';
import { ActionPanel } from '../shell/ActionPanel';
import { ProductionBigBagSummaryPanel } from './ProductionBigBagSummaryPanel';

const tabIcons: Record<RawMaterialModuleTab, string> = {
  summary: 'capacity-check',
  stock: 'box-closed',
  usage: 'gaugechart',
  movements: 'history-list',
  conflicts: 'warning',
};

function rowStatusClass(row: RawMaterialModuleRow) {
  return `severity-${row.severity}`;
}

function summaryTab(summaryId: string): RawMaterialModuleTab {
  if (summaryId === 'actual' || summaryId === 'ruble-stock') return 'stock';
  if (summaryId === 'planned' || summaryId === 'recorded' || summaryId === 'ruble-plan') return 'usage';
  if (summaryId === 'risks') return 'conflicts';
  return 'summary';
}

function preferredRowForSummary(summaryId: string, rows: RawMaterialModuleRow[]) {
  if (rows.length === 0) return undefined;
  if (summaryId === 'recorded') return rows.find((row) => row.recordedQty !== 'нет события') ?? rows[0];
  if (summaryId === 'risks') return rows.find((row) => row.severity === 'critical') ?? rows.find((row) => row.severity === 'warning') ?? rows[0];
  if (summaryId === 'planned' || summaryId === 'ruble-plan') return rows.find((row) => row.severity !== 'info') ?? rows[0];
  if (summaryId === 'ruble-stock') return rows.find((row) => row.details.some((detail) => detail.label === 'Рублевый остаток' && !detail.value.includes('Нет'))) ?? rows[0];
  return rows[0];
}

export function RawMaterialUsageModule({
  role,
  sourceObject,
  onAction,
}: {
  role: Role;
  sourceObject?: WorkObject;
  onAction?: (actionId: string) => void;
}) {
  const projection = useMemo(() => buildRawMaterialModuleProjection(role, sourceObject), [role, sourceObject]);
  const [activeTabId, setActiveTabId] = useState<RawMaterialModuleTab>('summary');
  const [activeSummaryId, setActiveSummaryId] = useState<string | null>(projection.summaries[0]?.id ?? null);
  const activeTab = projection.tabs.find((tab) => tab.id === activeTabId) ?? projection.tabs[0];
  const [selectedRowIdByTab, setSelectedRowIdByTab] = useState<Partial<Record<RawMaterialModuleTab, string>>>({});
  const selectedRow = activeTab.rows.find((row) => row.id === selectedRowIdByTab[activeTab.id]) ?? activeTab.rows[0];
  const selectedDetails = (selectedRow?.details ?? []).slice(0, 12);

  function selectRow(row: RawMaterialModuleRow) {
    setActiveSummaryId(null);
    setSelectedRowIdByTab((current) => ({ ...current, [row.tab]: row.id }));
  }

  function selectSummary(summaryId: string) {
    const nextTabId = summaryTab(summaryId);
    const nextTab = projection.tabs.find((tab) => tab.id === nextTabId) ?? projection.tabs[0];
    const nextRow = preferredRowForSummary(summaryId, nextTab.rows);
    setActiveSummaryId(summaryId);
    setActiveTabId(nextTab.id);
    if (nextRow) {
      setSelectedRowIdByTab((current) => ({ ...current, [nextTab.id]: nextRow.id }));
    }
  }

  function selectTab(tabId: RawMaterialModuleTab) {
    setActiveSummaryId(null);
    setActiveTabId(tabId);
  }

  return (
    <section className="warehouse-inventory-cockpit raw-material-module" aria-label="Модуль сырья">
      {role === 'director' && (
        <div className="raw-material-role-note" role="note">
          <strong>Управленческий просмотр</strong>
          <span>Факт склада, план по заказам и учетный снимок показаны для решения. Директор может вернуть дефицит складу на разбор, но не меняет складской остаток вручную.</span>
        </div>
      )}
      {role === 'production' ? <ProductionBigBagSummaryPanel /> : null}
      <div className="warehouse-inventory-summary" aria-label="Сводка сырья">
        {projection.summaries.map((summary) => (
          <button
            key={summary.id}
            type="button"
            className={`warehouse-inventory-summary-card severity-${summary.severity} ${activeSummaryId === summary.id ? 'is-active' : ''}`}
            onClick={() => selectSummary(summary.id)}
          >
            <span>{summary.label}</span>
            <strong>{summary.value}</strong>
            <small>{summary.detail}</small>
          </button>
        ))}
      </div>

      <div className="warehouse-inventory-layout">
        <div className="warehouse-inventory-main">
          <div className="warehouse-inventory-tabs" role="tablist" aria-label="Разделы модуля сырья">
            {projection.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTab.id}
                className={tab.id === activeTab.id ? 'is-active' : ''}
                onClick={() => selectTab(tab.id)}
              >
                <ix-icon name={tabIcons[tab.id]} size="16" />
                <span>{tab.label}</span>
                <strong>{tab.rows.length}</strong>
              </button>
            ))}
          </div>

          <div className="warehouse-inventory-scroll">
            <div className="warehouse-inventory-table raw-material-usage-table" role="table" aria-label={activeTab.label}>
              <div className="warehouse-inventory-row is-head" role="row">
                <span role="columnheader">Сырье</span>
                <span role="columnheader">Факт</span>
                <span role="columnheader">План</span>
                <span role="columnheader">Записано</span>
                <span role="columnheader">Доступно</span>
              </div>
              {activeTab.rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className={`warehouse-inventory-row ${rowStatusClass(row)} ${selectedRow?.id === row.id ? 'is-selected' : ''}`}
                  role="row"
                  onClick={() => selectRow(row)}
                >
                  <span role="cell" data-label="Сырье">
                    <strong>{row.title}</strong>
                    <small>{row.subtitle} · {row.status}</small>
                  </span>
                  <span role="cell" data-label="Факт">{row.actualQty}</span>
                  <span role="cell" data-label="План">{row.plannedQty}</span>
                  <span role="cell" data-label="Записано">{row.recordedQty}</span>
                  <span role="cell" data-label="Доступно">{row.availableQty}</span>
                </button>
              ))}
              {activeTab.rows.length === 0 && (
                <div className="warehouse-inventory-empty" role="row">
                  <strong>Нет строк</strong>
                  <span>Для этой роли в разделе нет доступных данных или действий.</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <aside className="warehouse-inventory-detail" aria-label="Детали сырья">
          {selectedRow ? (
            <>
              <div className="warehouse-inventory-detail-head">
                <span>Материал</span>
                <h3>{selectedRow.title}</h3>
                <p>{selectedRow.source}</p>
                <div className={`warehouse-inventory-status-line ${rowStatusClass(selectedRow)}`}>
                  <strong>{selectedRow.status}</strong>
                  <small>{selectedRow.availableQty}</small>
                </div>
              </div>
              {selectedRow.actions.length > 0 && (
                <ActionPanel actions={selectedRow.actions} title="Действия" variant="default" embedded className="warehouse-inventory-actions" onAction={onAction} />
              )}
              <dl className="warehouse-inventory-detail-list">
                {selectedDetails.map((detail) => (
                  <div
                    key={`${selectedRow.id}:${detail.label}`}
                    className={/Рублевый|рублях|Расчет|Источник расчета/.test(detail.label) ? 'is-cost-detail' : undefined}
                  >
                    <dt>{detail.label}</dt>
                    <dd>{detail.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <div className="warehouse-inventory-empty">
              <strong>Нет выбранной строки</strong>
              <span>Открой другой раздел модуля сырья.</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
