import { IxPill } from '@siemens/ix-react';
import { type KeyboardEvent, useEffect, useState } from 'react';

import { ActionPanel, HelpTooltip } from '../shell/ActionPanel';
import { FactList, InlineContextPanel, SeverityPill } from '../shell/viewPrimitives';
import { visibleAuditActionLabel } from '../../domain/displayContracts';
import { getObjectsForRole } from '../../domain/selectors';
import type { WorkObjectsByRole } from '../../domain/selectors';
import type { DirectorDashboardDrilldown, DirectorDashboardProjection } from '../../domain/runtime';
import type { Role, WorkObject } from '../../domain/types';
import {
  directorFinanceDecisionObject,
  shouldExposeFinanceToDirector,
} from './directorFinanceQrSurfaces';
import { DirectorQrScanSurface } from './directorTraceabilitySurface';
import { DirectorPayrollSurface } from './DirectorPayrollSurface';
import { ManagementCenter } from './directorManagementCenter';
import { PenaltyManagementSurface, type EmployeeOption } from './directorPenalties';
import type { PenaltySnapshotFilters, PenaltySnapshotRuntime } from '../../api/penalties';
import type { PenaltyFormPayload } from './directorPenalties';
import { directorSyntheticObject, factValue } from './directorWorkObjectUtils';
import type {
  DirectorSupplementalScope,
  DirectorSupplementalState,
} from '../../features/director/useDirectorSupplementalObjects';
import {
  BUSINESS_PERFORMANCE_SECTIONS,
  BusinessPerformanceWorkspace,
} from '../../features/business-performance/BusinessPerformanceWorkspace';
import { BusinessProblemsWorkspace } from '../../features/business-performance/BusinessProblemsWorkspace';
import { DirectorRefreshButton } from '../../features/director/DirectorRefreshButton';

export type DirectorViewMode = 'decisions' | 'orders';
export type DirectorQuickFilter = 'all' | 'money' | 'warehouse' | 'risk';
type DirectorRowTag = Exclude<DirectorQuickFilter, 'all'>;
type ManagementReportTone = 'info' | 'money' | 'warehouse' | 'risk' | 'admin';

type ManagementReport = {
  id: string;
  title: string;
  value: string;
  detail: string;
  tone: ManagementReportTone;
  actionLabel: string;
  action: () => void;
};

type DirectorTableRow = {
  id: string;
  type: string;
  objectLabel: string;
  status: string;
  impact: string;
  owner: string;
  lastEvent: string;
  sourceLabel: string;
  stalenessLabel: string;
  basisLabel: string;
  effectiveAtLabel: string;
  auditCompletenessLabel: string;
  severity: WorkObject['severity'];
  tags: DirectorRowTag[];
  attention: boolean;
  object: WorkObject;
};

type DirectorOverviewItem = {
  label: string;
  count: number;
  caption: string;
  sourceLabel: string;
  actionLabel: string;
  tone: DirectorRowTag | 'info';
  view: DirectorViewMode;
  filter: DirectorQuickFilter;
};

const DIRECTOR_SUPPLEMENTAL_LABELS: Record<DirectorSupplementalScope, string> = {
  finance: 'Финансовые решения',
  production: 'Производственные решения',
  warehouse: 'Складские исключения',
};

export function DirectorSupplementalAvailability({
  state,
  onRetry,
}: {
  state: DirectorSupplementalState;
  onRetry: (scope: DirectorSupplementalScope) => void;
}) {
  const unavailable = (Object.keys(DIRECTOR_SUPPLEMENTAL_LABELS) as DirectorSupplementalScope[])
    .filter((scope) => state[scope].status !== 'ready')
    .map((scope) => ({ scope, status: state[scope].status }));
  if (unavailable.length === 0) return null;

  return (
    <section
      className="surface director-supplemental-status"
      aria-label="Доступность детализации директора"
      aria-live="polite"
    >
      {unavailable.map(({ scope, status }) => (
        <div key={scope} data-director-supplemental={scope} data-load-state={status}>
          <span>{DIRECTOR_SUPPLEMENTAL_LABELS[scope]}</span>
          <strong>
            {status === 'error' ? 'Данные недоступны — прежние строки скрыты' : 'Обновляем данные'}
          </strong>
          {status === 'error' ? (
            <button type="button" onClick={() => onRetry(scope)}>
              Повторить
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}

export function DirectorWorkbench({
  activeSection,
  selectedId,
  selectedProblemId,
  isMobileViewport,
  workObjectsByRole,
  dashboard,
  viewMode,
  quickFilter,
  supplementalState,
  onRetrySupplemental,
  onSelect,
  onOpenRole,
  onAction,
  onClose,
  onDashboardDrilldown,
  penaltySnapshot,
  penaltyFilters,
  penaltyScopeObjectId,
  penaltyEmployees,
  canCreatePenalty,
  allowPenaltyUpdate,
  onPenaltyCreate,
  onPenaltyUpdate,
  onPenaltyFiltersChange,
  onViewModeChange,
  onQuickFilterChange,
  onRefresh,
  refreshing = false,
  refreshGeneration = 0,
  useLiveData = false,
}: {
  activeSection: string;
  selectedId: string | null;
  selectedProblemId?: string | null;
  isMobileViewport: boolean;
  workObjectsByRole: WorkObjectsByRole;
  dashboard: DirectorDashboardProjection;
  useLiveData?: boolean;
  viewMode: DirectorViewMode;
  quickFilter: DirectorQuickFilter;
  supplementalState?: DirectorSupplementalState;
  onRetrySupplemental?: (scope: DirectorSupplementalScope) => void;
  onSelect: (id: string) => void;
  onOpenRole: (role: Role) => void;
  onAction: (actionId: string, object: WorkObject) => void;
  onClose: () => void;
  onDashboardDrilldown: (drilldown: DirectorDashboardDrilldown) => void;
  penaltySnapshot: PenaltySnapshotRuntime;
  penaltyFilters: PenaltySnapshotFilters;
  penaltyScopeObjectId: string;
  penaltyEmployees?: EmployeeOption[];
  canCreatePenalty: boolean;
  allowPenaltyUpdate: boolean;
  onPenaltyCreate: (payload: PenaltyFormPayload) => void | boolean | Promise<void | boolean>;
  onPenaltyUpdate: (penaltyId: string, payload: PenaltyFormPayload) => void;
  onPenaltyFiltersChange: (filters: PenaltySnapshotFilters) => void | Promise<unknown>;
  onViewModeChange: (mode: DirectorViewMode) => void;
  onQuickFilterChange: (view: DirectorViewMode, filter: DirectorQuickFilter) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshGeneration?: string | number;
}) {
  const [actionFeedbackByObject, setActionFeedbackByObject] = useState<Record<string, string>>({});
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const decisionRows = directorDecisionRows(workObjectsByRole, useLiveData);
  const orderRows = directorOrderRows(decisionRows, workObjectsByRole, useLiveData);
  const sectionRows = directorRowsForSection(activeSection, decisionRows, orderRows);
  const activeRows = sectionRows ?? (viewMode === 'decisions' ? decisionRows : orderRows);
  const filteredRows =
    quickFilter === 'all' ? activeRows : activeRows.filter((row) => row.tags.includes(quickFilter));
  const rows = sortDirectorRows(filteredRows.length > 0 ? filteredRows : activeRows);
  const isControl = activeSection === 'Контроль' || activeSection === 'Дашборд';
  const isDecisionQueue = activeSection === 'Требуют решения';
  const isDirectorQr = activeSection === 'Аудит / QR';
  const isDirectorPayroll = activeSection === 'Зарплаты';
  const hasDedicatedSectionSurface =
    activeSection === 'Штрафы' || isDirectorQr || isDirectorPayroll;
  const useSectionRows =
    Boolean(sectionRows) || activeSection === 'Штрафы' || isDirectorQr || isDirectorPayroll;
  const selectedRow = selectedId
    ? (rows.find((row) => directorRowMatchesSelection(row, selectedId)) ?? null)
    : null;
  const activeSelectedRow = selectedRow ?? rows[0] ?? null;
  const showDecisionDetail = !hasDedicatedSectionSurface && !isControl;
  const overview = directorOverviewItems(decisionRows, orderRows);
  const sectionCopy = directorSectionCopy(activeSection);
  const closeMobileDrawer = () => setMobileDrawerOpen(false);
  const supplementalAvailability =
    supplementalState && onRetrySupplemental ? (
      <DirectorSupplementalAvailability state={supplementalState} onRetry={onRetrySupplemental} />
    ) : null;
  const refreshAction = onRefresh ? (
    <DirectorRefreshButton busy={refreshing} onRefresh={onRefresh} />
  ) : null;
  const handleRowSelect = (row: DirectorTableRow) => {
    onSelect(row.id);
    if (isMobileViewport) setMobileDrawerOpen(true);
  };
  const handleRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: DirectorTableRow) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleRowSelect(row);
  };
  const handleDirectorAction = (actionId: string, object: WorkObject) => {
    if (directorActionRequiresReason(actionId)) {
      setActionFeedbackByObject((current) => {
        const next = { ...current };
        delete next[object.id];
        return next;
      });
      onAction(actionId, object);
      return;
    }

    const feedback = directorActionFeedback(actionId, object);
    setActionFeedbackByObject((current) => ({ ...current, [object.id]: feedback }));
    onAction(actionId, object);
  };

  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [activeSection, viewMode, quickFilter]);

  const performanceSection = activeSection === 'Деньги' ? 'Финансы' : activeSection;
  if ((BUSINESS_PERFORMANCE_SECTIONS as readonly string[]).includes(performanceSection)) {
    return (
      <BusinessPerformanceWorkspace
        section={performanceSection as (typeof BUSINESS_PERFORMANCE_SECTIONS)[number]}
        refreshGeneration={refreshGeneration}
        role="director"
        headerAction={refreshAction}
        defectBags={dashboard.controlReport.defectBags}
      />
    );
  }

  if (activeSection === 'Проблемы') {
    return (
      <BusinessProblemsWorkspace
        refreshGeneration={refreshGeneration}
        allowProductionOverride
        selectedProblemId={selectedProblemId}
        headerAction={refreshAction}
      />
    );
  }

  return (
    <section className="director-workbench" aria-label="Директор">
      <header className="director-topbar">
        <div>
          <h1>{sectionCopy.title}</h1>
        </div>
        <div className="director-topbar-actions">
          {!useSectionRows && !isControl && (
            <div className="director-tabs" role="tablist" aria-label="Вид директора">
              <button
                className={viewMode === 'decisions' ? 'is-active' : ''}
                onClick={() => onViewModeChange('decisions')}
                type="button"
                title="Показывает только строки, где директор должен выбрать действие."
              >
                Нужно решение
              </button>
              <button
                className={viewMode === 'orders' ? 'is-active' : ''}
                onClick={() => onViewModeChange('orders')}
                type="button"
                title="Показывает общий срез заказов и проблем без изменения данных."
              >
                Все заказы
              </button>
            </div>
          )}
          {refreshAction}
        </div>
      </header>

      {supplementalAvailability}

      {!isControl && !isDecisionQueue && !hasDedicatedSectionSurface && (
        <div className="director-overview" aria-label="Срезы директора">
          {overview.map((item) => (
            <button
              key={item.label}
              className={`overview-tile tone-${item.tone} ${viewMode === item.view && quickFilter === item.filter ? 'is-active' : ''}`}
              onClick={() => onQuickFilterChange(item.view, item.filter)}
              type="button"
              title={`${item.label}: ${item.count}. Нажатие фильтрует таблицу директора по этому срезу.`}
            >
              <span>{item.label}</span>
              <strong>{item.count}</strong>
              <small>{item.caption}</small>
              <em>{item.sourceLabel}</em>
              <b>{item.actionLabel}</b>
            </button>
          ))}
        </div>
      )}

      {isControl ? (
        <ManagementCenter
          dashboard={dashboard}
          onDrilldown={onDashboardDrilldown}
          useLiveData={useLiveData}
        />
      ) : isDirectorQr ? (
        <DirectorQrScanSurface />
      ) : isDirectorPayroll ? (
        <DirectorPayrollSurface
          useLiveData={useLiveData}
          refreshGeneration={refreshGeneration}
        />
      ) : activeSection === 'Штрафы' ? (
        <PenaltyManagementSurface
          snapshot={penaltySnapshot}
          filters={penaltyFilters}
          scopedObjectId={penaltyScopeObjectId}
          assignmentEmployees={penaltyEmployees}
          canCreatePenalty={canCreatePenalty}
          allowUpdate={allowPenaltyUpdate}
          onCreate={onPenaltyCreate}
          onUpdate={onPenaltyUpdate}
          onFiltersChange={onPenaltyFiltersChange}
        />
      ) : (
        <>
          <div
            className={`director-main-grid ${showDecisionDetail ? 'has-detail' : 'is-list-only'}`}
          >
            <section
              className="surface director-table-surface"
              aria-label={viewMode === 'decisions' ? 'Нужно решение' : 'Все заказы'}
            >
              <div className="director-table-header">
                <div>
                  <span className="eyebrow">{sectionCopy.eyebrow}</span>
                  <h2>{sectionCopy.tableTitle}</h2>
                </div>
                <HelpTooltip
                  text={`В таблице сейчас ${rows.length} строк после выбранного среза директора.`}
                  placement="left"
                >
                  <IxPill>{rows.length}</IxPill>
                </HelpTooltip>
              </div>
              <div className="director-table-wrap">
                <table className="director-table">
                  <thead>
                    <tr>
                      <th>Вопрос</th>
                      <th>Объект</th>
                      <th>Риск / деньги</th>
                      <th>Кто решает</th>
                      <th>Когда</th>
                      <th>Источник</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`severity-${row.severity} ${row.attention ? 'has-attention' : ''} ${showDecisionDetail && activeSelectedRow?.id === row.id ? 'is-selected' : ''}`}
                        onClick={() => handleRowSelect(row)}
                        onKeyDown={(event) => handleRowKeyDown(event, row)}
                        role="button"
                        tabIndex={0}
                        title={`Открыть строку: ${row.objectLabel}. ${row.status}. ${row.owner}. ${row.lastEvent}.`}
                      >
                        <td data-label="Вопрос">
                          <span
                            className="director-row-pill"
                            title="Показывает, почему директору нужна эта строка."
                          >
                            {row.type}
                          </span>
                        </td>
                        <td data-label="Объект">{row.objectLabel}</td>
                        <td data-label="Риск / деньги">{row.impact}</td>
                        <td data-label="Кто решает">{row.owner}</td>
                        <td data-label="Когда">{row.lastEvent}</td>
                        <td data-label="Источник">
                          {row.sourceLabel} · {row.stalenessLabel}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {showDecisionDetail && !isMobileViewport && (
              <DirectorDrawer
                row={activeSelectedRow}
                mode="desktop"
                className="director-drawer-inline"
                actionFeedback={
                  activeSelectedRow
                    ? actionFeedbackByObject[activeSelectedRow.object.id]
                    : undefined
                }
                onClose={onClose}
                onAction={handleDirectorAction}
              />
            )}
            {showDecisionDetail && isMobileViewport && mobileDrawerOpen && activeSelectedRow && (
              <div
                className="director-mobile-detail-layer"
                role="dialog"
                aria-modal="true"
                aria-label="Карточка выбранного решения"
              >
                <button
                  className="director-mobile-detail-backdrop"
                  type="button"
                  onClick={closeMobileDrawer}
                  aria-label="Закрыть карточку"
                />
                <DirectorDrawer
                  row={activeSelectedRow}
                  mode="mobile"
                  className="director-drawer-mobile"
                  actionFeedback={actionFeedbackByObject[activeSelectedRow.object.id]}
                  onClose={closeMobileDrawer}
                  onAction={handleDirectorAction}
                />
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DirectorDrawer({
  row,
  mode,
  className = '',
  actionFeedback,
  onClose,
  onAction,
}: {
  row: DirectorTableRow | null;
  mode: 'desktop' | 'mobile';
  className?: string;
  actionFeedback?: string;
  onClose: () => void;
  onAction: (actionId: string, object: WorkObject) => void;
}) {
  if (!row) {
    return (
      <aside
        className={`surface director-drawer director-drawer-blank ${className}`.trim()}
        role="status"
        aria-label="Карточка директора не выбрана"
      >
        <div className="detail-blank-state" aria-hidden="true" />
      </aside>
    );
  }

  const object = row.object;
  const paymentDate = factValue(object, 'Дата оплаты');
  const notificationState = factValue(object, 'Уведомление');
  const sourceObjectId = factValue(object, 'Номер') ?? object.id.replace(/^DIR-/, '');
  const isProductionSupervisor = ['Рецепт/цена', 'Производство', 'Риск'].includes(row.type);
  const isWarehouseSupervisor =
    row.type !== 'Сырье' && (row.tags.includes('warehouse') || row.type === 'Склад');
  const strongActions = object.actions.some((action) => directorActionRequiresReason(action.id));
  const openProblem = object.problems.find((problem) => problem.status === 'open');
  const decisionLabel = factValue(object, 'Что решить') ?? openProblem?.title ?? row.status;
  const decisionAction =
    openProblem?.recovery ?? directorPrimaryActionLabel(object.actions) ?? row.status;
  const decisionReason =
    openProblem?.reason ??
    factValue(object, 'Причина') ??
    factValue(object, 'Комментарий') ??
    row.status;
  const detailFactCount =
    object.facts.length + object.sections.reduce((sum, section) => sum + section.facts.length, 0);
  const priorityItems: Array<{ label: string; value: string; tone?: WorkObject['severity'] }> = [
    { label: 'Объект', value: row.objectLabel },
    { label: 'Действие', value: decisionAction },
    { label: 'Риск', value: row.impact, tone: object.severity },
    { label: 'Владелец', value: row.owner },
  ];
  const sourceItems = [
    { label: 'Источник', value: row.sourceLabel },
    { label: 'Свежесть', value: row.stalenessLabel },
    { label: 'Основание', value: row.basisLabel },
    { label: 'Дата', value: row.effectiveAtLabel },
    { label: 'История', value: row.auditCompletenessLabel },
  ];

  return (
    <aside
      className={`surface director-drawer severity-${object.severity} ${className}`.trim()}
      aria-label="Карточка выбранного объекта"
    >
      <header className="drawer-header">
        <div>
          <span className="eyebrow">{row.type}</span>
          <h2>{object.title}</h2>
        </div>
        <div className="detail-header-actions">
          <SeverityPill severity={object.severity} />
          {mode === 'mobile' && (
            <button
              className="detail-close-button"
              type="button"
              onClick={onClose}
              aria-label="Закрыть карточку"
              title="Закрыть карточку"
            >
              <ix-icon name="close" size="16" />
            </button>
          )}
        </div>
      </header>

      <section className="director-decision-hero" aria-label="Почему нужно решение">
        <div>
          <span className="eyebrow">Почему нужно решение</span>
          <h3>{decisionLabel}</h3>
          <p>{decisionReason}</p>
        </div>
        <div className="director-decision-status">
          <span>{row.type}</span>
          <strong>{object.statusLabel}</strong>
          {paymentDate && (
            <small>
              {notificationState ? `${paymentDate} · ${notificationState}` : paymentDate}
            </small>
          )}
        </div>
      </section>

      {object.actions.length > 0 && (
        <ActionPanel
          actions={object.actions}
          title=""
          variant="large"
          embedded
          className="director-drawer-actions"
          onAction={(actionId) => onAction(actionId, object)}
        />
      )}

      <div className="drawer-evidence-grid director-priority-grid">
        {priorityItems.map((item) => (
          <div
            key={`${item.label}-${item.value}`}
            className={item.tone ? `tone-${item.tone}` : undefined}
          >
            <span>{item.label}</span>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>

      <dl className="director-source-strip" aria-label="Источник и основание решения">
        {sourceItems.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
      </dl>

      {strongActions && (
        <div className="director-reason-gate-note" role="note">
          <span>Нужна причина</span>
          <strong>{decisionAction}. Решение пишется в историю с доказательством.</strong>
        </div>
      )}

      {(isProductionSupervisor || isWarehouseSupervisor) && (
        <details className="director-supervisor-details" open>
          <summary>
            <span>Еще решения директора</span>
            <small>{isProductionSupervisor ? 'производство' : 'склад'}</small>
          </summary>
          {isProductionSupervisor ? (
            <div className="director-supervisor-actions">
              <button
                type="button"
                onClick={() =>
                  onAction(`director-production-override-owner:${sourceObjectId}`, object)
                }
              >
                Назначить владельца
              </button>
              <button
                type="button"
                onClick={() =>
                  onAction(`director-production-override-priority:${sourceObjectId}`, object)
                }
              >
                Поднять приоритет
              </button>
              <button
                type="button"
                onClick={() =>
                  onAction(`director-production-override-return:${sourceObjectId}`, object)
                }
              >
                Вернуть производству
              </button>
              <button
                type="button"
                onClick={() =>
                  onAction(`director-production-override-confirm:${sourceObjectId}`, object)
                }
              >
                Подтвердить исключение
              </button>
            </div>
          ) : (
            <div className="director-supervisor-actions">
              <button
                type="button"
                onClick={() =>
                  onAction(`director-warehouse-override-confirm:${sourceObjectId}`, object)
                }
              >
                Подтвердить складское исключение
              </button>
              <button
                type="button"
                onClick={() =>
                  onAction(`director-warehouse-override-return:${sourceObjectId}`, object)
                }
              >
                Вернуть складу
              </button>
            </div>
          )}
        </details>
      )}

      {actionFeedback && (
        <div className="director-action-feedback" role="status">
          <span>Результат действия</span>
          <strong>{actionFeedback}</strong>
        </div>
      )}

      <details className="director-detail-disclosure">
        <summary>
          <span>Подробности</span>
          <small>{detailFactCount}</small>
        </summary>
        <section className="drawer-section">
          <h3>Ключевые поля</h3>
          <FactList facts={object.facts} />
        </section>

        {object.sections.map((section) => (
          <section key={section.id} className="drawer-section">
            <h3>{section.title}</h3>
            <FactList facts={section.facts} />
          </section>
        ))}
      </details>

      <InlineContextPanel object={object} />
    </aside>
  );
}

function directorPrimaryActionLabel(actions: WorkObject['actions']) {
  const peerActions = actions.filter((action) => action.enabled && action.level === 'peer');
  if (peerActions.length >= 2)
    return peerActions
      .slice(0, 2)
      .map((action) => action.label)
      .join(' / ');
  return (
    actions.find((action) => action.enabled && action.level === 'recommended')?.label ??
    peerActions[0]?.label ??
    actions.find((action) => action.enabled)?.label ??
    actions[0]?.label
  );
}

function directorActionRequiresReason(actionId: string) {
  const normalized = actionId.toLowerCase();
  return (
    normalized.includes('override') ||
    normalized.includes('approve') ||
    normalized.includes('confirm') ||
    normalized.includes('return') ||
    normalized.includes('assign') ||
    normalized.includes('queue-reorder') ||
    normalized.startsWith('director-material-') ||
    normalized.includes('kickback')
  );
}

function sortDirectorRows(rows: DirectorTableRow[]) {
  const severityRank: Record<WorkObject['severity'], number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };
  const typeRank = (row: DirectorTableRow) => {
    if (row.status.toLowerCase().includes('просроч')) return 0;
    if (row.tags.includes('warehouse')) return 1;
    if (row.tags.includes('money')) return 2;
    if (row.type === 'Рецепт/цена' || row.type === 'Производство' || row.type === 'Риск') return 3;
    if (row.type === 'Аудит / QR') return 4;
    if (row.type === 'Плановое подтверждение') return 8;
    return 5;
  };

  return [...rows].sort(
    (left, right) =>
      severityRank[left.severity] - severityRank[right.severity] ||
      typeRank(left) - typeRank(right) ||
      Number(right.attention) - Number(left.attention) ||
      left.objectLabel.localeCompare(right.objectLabel, 'ru'),
  );
}

function directorRowMatchesSelection(row: DirectorTableRow, selectedId: string | null) {
  if (!selectedId) return false;
  return (
    row.id === selectedId ||
    row.object.id === selectedId ||
    row.objectLabel === selectedId ||
    row.id.endsWith(selectedId) ||
    row.object.id.endsWith(selectedId)
  );
}

function directorActionFeedback(actionId: string, object: WorkObject) {
  const normalized = actionId.toLowerCase();
  if (normalized.startsWith('director-material-confirm')) {
    return 'Исключение подтверждено; зав. производства продолжает по выбранному варианту.';
  }
  if (normalized.startsWith('director-material-return')) {
    return 'Возвращено на разбор: склад и зав. производства уточняют остаток или маршрут выпуска.';
  }
  if (normalized.includes('approve') || normalized.includes('confirm')) {
    return object.statusLabel === 'Склад'
      ? 'Частичная приемка подтверждена; склад может закрыть проблемную строку с записью в аудит.'
      : 'Решение подтверждено; зав. производства получает разрешение продолжить по выбранному варианту.';
  }
  if (normalized.includes('return')) {
    return object.statusLabel === 'Склад'
      ? 'Решение возвращено складу: нужен повторный разбор складской истории или недостающего рулона.'
      : 'Решение возвращено зав. производства: нужно исправить основание и отправить директору повторно.';
  }
  if (normalized.includes('assign')) {
    return 'Ответственный назначен: Артур, зав. производства. Он получает задачу закрыть основание решения.';
  }
  if (normalized.includes('queue-reorder')) {
    return 'Порядок очереди изменен для общей производственной очереди; изменение записано в историю.';
  }
  if (normalized.includes('open-scans')) {
    return 'Открыт связанный складской контекст с подтверждениями приемки и недостающими рулонами.';
  }
  if (normalized.includes('finance')) {
    if (normalized.includes('override'))
      return 'Решение директора записано в финансовую историю с причиной и подтверждением.';
    return 'Финансовая строка открыта в контексте бухгалтерии.';
  }
  if (normalized.includes('production-override')) {
    return 'Решение директора записано в производственную историю; зав. производства видит решение и причину.';
  }
  if (normalized.includes('warehouse-override')) {
    return 'Складское исключение разобрано директором; сканирование остается у склада.';
  }
  if (normalized.includes('kickback')) {
    return 'Откат подтвержден в закрытом директорском контуре; история фиксирует старое и новое значение.';
  }
  if (normalized.includes('penalty')) {
    return 'Открыта форма назначения штрафа; сотрудник увидит только свой личный контекст.';
  }
  return 'Действие записано в историю выбранного решения.';
}

function directorSectionCopy(section: string) {
  if (section === 'Контроль' || section === 'Дашборд') {
    return {
      title: 'Контроль',
      eyebrow: 'Финансы и производство',
      tableTitle: 'Очередь решений',
    };
  }
  if (section === 'Требуют решения') {
    return {
      title: 'Требуют решения',
      eyebrow: 'Очередь',
      tableTitle: 'Решения',
    };
  }
  if (section === 'Финансы' || section === 'Деньги') {
    return {
      title: 'Финансы',
      eyebrow: 'Финансовые решения',
      tableTitle: 'Счета, оплаты и просрочки',
    };
  }
  if (section === 'Производство') {
    return {
      title: 'Производство',
      eyebrow: 'Производственные решения',
      tableTitle: 'Рецепт и производственные риски',
    };
  }
  if (section === 'Зарплаты') {
    return {
      title: 'Зарплаты',
      eyebrow: 'Сдельный расчёт',
      tableTitle: 'Начисления по подтверждённой выработке',
    };
  }
  if (section === 'Склад') {
    return {
      title: 'Склад',
      eyebrow: 'Складские решения',
      tableTitle: 'Исключения приемки и выдачи',
    };
  }
  if (section === 'Сырье') {
    return {
      title: 'Сырье',
      eyebrow: 'Дефициты сырья',
      tableTitle: 'Строки, где не хватает материала',
    };
  }
  if (section === 'Штрафы') {
    return {
      title: 'Штрафы',
      eyebrow: 'Ответственность',
      tableTitle: 'Назначение и история штрафов',
    };
  }
  if (section === 'Аудит / QR') {
    return {
      title: 'Аудит / QR',
      eyebrow: 'Прослеживаемость',
      tableTitle: 'События, QR-история и источники',
    };
  }
  return {
    title: 'Что нужно решить',
    eyebrow: 'Нужно решение',
    tableTitle: 'Что ждет директора',
  };
}

function directorRowsForSection(
  section: string,
  decisionRows: DirectorTableRow[],
  orderRows: DirectorTableRow[],
) {
  if (section === 'Требуют решения') return decisionRows;
  if (section === 'Финансы' || section === 'Деньги')
    return orderRows.filter((row) => row.type === 'Деньги');
  if (section === 'Производство')
    return orderRows.filter(
      (row) => row.type === 'Рецепт/цена' || row.type === 'Производство' || row.type === 'Риск',
    );
  if (section === 'Сырье')
    return [...decisionRows, ...orderRows].filter((row) => row.type === 'Сырье');
  if (section === 'Склад') {
    const rowsById = new Map<string, DirectorTableRow>();
    for (const row of [...orderRows, ...decisionRows].filter((item) =>
      item.tags.includes('warehouse'),
    )) {
      rowsById.set(row.id, row);
    }
    return Array.from(rowsById.values());
  }
  if (section === 'Аудит / QR') return orderRows.filter((row) => row.type === 'Аудит / QR');
  return null;
}

export function directorDecisionRows(
  objectsByRole: WorkObjectsByRole,
  useLiveData = false,
): DirectorTableRow[] {
  if (useLiveData) {
    return getObjectsForRole('director', objectsByRole)
      .filter((object) => object.kind === 'directorDecision')
      .map((object) =>
        directorRowFromObject(
          object,
          object.problems.some((problem) => problem.status === 'open'),
        ),
      );
  }
  return [
    ...getObjectsForRole('director', objectsByRole).map((object) =>
      directorRowFromObject(object, true),
    ),
    ...directorMaterialShortageRows(objectsByRole),
  ];
}

export function directorOrderRows(
  decisionRows: DirectorTableRow[],
  objectsByRole: WorkObjectsByRole,
  useLiveData = false,
): DirectorTableRow[] {
  const decisionById = new Map(decisionRows.map((row) => [row.object.id, row]));
  const recipe = decisionById.get('DIR-2606-006');
  const warehouse = decisionById.get('DIR-2606-009');
  const financeRows = getObjectsForRole('finance', objectsByRole)
    .filter((object) => shouldExposeFinanceToDirector(object))
    .map((object) => directorRowFromObject(directorFinanceDecisionObject(object), true));

  // Live-режим: строки контуров строятся из реальных work-objects (kind → секция),
  // demo-синтетика (ЗН-/DIR- заглушки) не подмешивается.
  if (useLiveData) {
    const productionRows = getObjectsForRole('production', objectsByRole)
      .filter((object) => object.kind === 'productionOrder')
      .map((object) => directorRowFromObject(object, true));
    const warehouseRows = getObjectsForRole('warehouse', objectsByRole)
      .filter((object) => object.kind === 'warehouseJob')
      .map((object) => directorRowFromObject(object, true));
    return [...financeRows, ...productionRows, ...warehouseRows];
  }

  return [
    ...(recipe ? [{ ...recipe, id: 'ORDER-ZN-2606-014', type: 'Рецепт/цена' }] : []),
    ...(warehouse ? [{ ...warehouse, id: 'ORDER-WH-2606-044', type: 'Склад' }] : []),
    ...financeRows,
    directorRowFromObject(
      directorSyntheticObject({
        id: 'DIR-AUDIT-QR-2606-014',
        title: 'Аудит / QR ЗН-2606-014',
        statusLabel: 'Аудит / QR',
        severity: 'warning',
        facts: [
          { label: 'Номер', value: 'ЗН-2606-014' },
          { label: 'QR контекст', value: 'R-A17-03 связан с заказом и группой рулонов' },
          {
            label: 'Что проверить',
            value: 'Кто инициировал изменение и с какого рулона оно применяется',
          },
          { label: 'Источник', value: 'данные платформы + складской факт' },
        ],
        sections: [
          {
            id: 'audit-qr-proslezhivaemost',
            title: 'Прослеживаемость',
            facts: [
              { label: 'Событие', value: visibleAuditActionLabel('audit:correction_created') },
              { label: 'Инициатор', value: 'Зав. производства' },
              { label: 'Подтверждает', value: 'Директор' },
              { label: 'Было / стало', value: 'М1 -> М2 с рулона 3' },
              { label: 'Источник', value: 'учет + QR-история' },
            ],
          },
        ],
        actions: [
          {
            id: 'director-history:DIR-AUDIT-QR-2606-014',
            label: 'Открыть историю',
            level: 'secondary',
            enabled: true,
          },
          {
            id: 'director-open-qr:DIR-AUDIT-QR-2606-014',
            label: 'Открыть QR контекст',
            level: 'secondary',
            enabled: true,
          },
        ],
        problemTitle: 'Нужна проверка прослеживаемости',
        problemReason: 'Директор должен видеть основание изменения без складских действий.',
        recovery: 'Открыть историю или связанный QR контекст',
        auditLabel: 'QR-история поднята директору',
        auditDetail: 'Показаны только события, снимки источников и связанный объект.',
        time: '12:18',
      }),
      true,
    ),
    directorRowFromObject(
      directorSyntheticObject({
        id: 'DIR-PROD-2606-018',
        title: 'Производственный риск ЗН-2606-018',
        statusLabel: 'Риск',
        severity: 'critical',
        facts: [
          { label: 'Номер', value: 'ЗН-2606-018' },
          { label: 'Заказчик', value: 'ПакетПром', scope: 'legal' },
          { label: 'Что решить', value: 'Неполная рецептура' },
          { label: 'Риск', value: 'Нет причины замены сырья' },
        ],
        sections: [
          {
            id: 'production-risk',
            title: 'Производственные факты',
            facts: [
              { label: 'Материал', value: 'Не указана причина замены' },
              { label: 'Ответственный', value: 'Не назначен тот, кто продолжит' },
            ],
          },
        ],
        actions: [
          { id: 'return-production', label: 'Вернуть', level: 'peer', enabled: true },
          {
            id: 'assign-production',
            label: 'Назначить ответственного',
            level: 'secondary',
            enabled: true,
          },
        ],
        problemTitle: 'Неполный заказ-наряд',
        problemReason: 'Нет причины замены сырья и ответственного за продолжение.',
        recovery: 'Вернуть на доработку или назначить владельца',
        auditLabel: 'Риск поднят директору',
        auditDetail: 'Производственный блокер требует владельца.',
        time: '11:10',
      }),
      true,
    ),
    directorRowFromObject(
      directorSyntheticObject({
        id: 'ORDER-Z-2606-017',
        title: 'Заявка З-2606-017',
        statusLabel: 'Черновик',
        severity: 'warning',
        facts: [
          { label: 'Номер', value: 'З-2606-017' },
          { label: 'Заказчик', value: 'УралПак', scope: 'legal' },
          { label: 'Что решить', value: 'Директор не нужен' },
          { label: 'Риск', value: 'Черновик еще не передан зав. производства' },
        ],
        sections: [
          {
            id: 'intake-status',
            title: 'Состояние заявки',
            facts: [
              { label: 'Позиции', value: '3 рулона, рукав 80 мкм' },
              { label: 'Владелец', value: 'Коммерция' },
            ],
          },
        ],
        actions: [
          { id: 'history-intake', label: 'Открыть историю', level: 'secondary', enabled: true },
        ],
        problemTitle: 'Черновик не передан',
        problemReason:
          'Заявка остается у коммерции, пока не заполнены параметры позиции и контрагент.',
        recovery: 'Заполнить параметры и передать зав. производства',
        auditLabel: 'Заявка создана',
        auditDetail: 'Зафиксированы позиции и шаблон клиента.',
        time: '09:20',
      }),
      false,
    ),
  ];
}

function directorMaterialShortageRows(objectsByRole: WorkObjectsByRole): DirectorTableRow[] {
  return getObjectsForRole('commercial', objectsByRole).flatMap((object) =>
    (object.materialShortageBlockers ?? [])
      .filter((blocker) => blocker.shortageQty > 0)
      .map((blocker) => {
        const position = object.commercialOrder?.positions.find(
          (item) => item.id === blocker.positionId,
        );
        const positionLabel = position
          ? `${position.rollCount} рул. · ${position.filmType}, ${position.actualThickness}`
          : blocker.positionId;
        return directorRowFromObject(
          directorSyntheticObject({
            id: `DIR-MATERIAL-${blocker.id}`,
            title: `Дефицит сырья ${object.id}`,
            statusLabel: 'Сырье',
            severity: 'warning',
            facts: [
              { label: 'Номер', value: object.id },
              { label: 'Сырье', value: blocker.label },
              { label: 'Не хватает', value: `${blocker.shortageQty} ${blocker.unit}` },
              { label: 'Риск', value: `не хватает ${blocker.shortageQty} ${blocker.unit}` },
              { label: 'Владелец', value: 'Зав. производства + Склад' },
            ],
            sections: [
              {
                id: `material-shortage-${blocker.id}`,
                title: 'Складской факт',
                facts: [
                  { label: 'Позиция', value: positionLabel },
                  { label: 'Требуется', value: `${blocker.requiredQty} ${blocker.unit}` },
                  { label: 'Факт', value: `${blocker.factQty} ${blocker.unit}` },
                  { label: 'Резерв', value: `${blocker.usableReserveQty} ${blocker.unit}` },
                  { label: 'Блокируется до', value: 'решения по выпуску' },
                ],
              },
            ],
            actions: [
              {
                id: `director-material-confirm:${blocker.id}`,
                label: 'Подтвердить исключение',
                level: 'peer',
                enabled: true,
              },
              {
                id: `director-material-return:${blocker.id}`,
                label: 'Вернуть на разбор',
                level: 'secondary',
                enabled: true,
              },
            ],
            problemTitle: 'Нехватка сырья',
            problemReason: `${blocker.label}: не хватает ${blocker.shortageQty} ${blocker.unit}.`,
            recovery: 'Подтвердить исключение или вернуть на разбор',
            auditLabel: 'Дефицит сырья поднят директору',
            auditDetail: 'Показаны заказ, позиция, складской факт и два возможных решения.',
            time: blocker.createdAt,
          }),
          true,
        );
      }),
  );
}

export function managementReports(
  decisionRows: DirectorTableRow[],
  orderRows: DirectorTableRow[],
  onQuickFilterChange: (view: DirectorViewMode, filter: DirectorQuickFilter) => void,
  onOpenRole: (role: Role) => void,
  objectsByRole: WorkObjectsByRole,
): ManagementReport[] {
  const productionRows = getObjectsForRole('production', objectsByRole);
  const financeRows = getObjectsForRole('finance', objectsByRole);
  const warehouseRows = getObjectsForRole('warehouse', objectsByRole);
  const adminRows = getObjectsForRole('admin', objectsByRole);

  const productionBlocked = productionRows.filter(
    (object) =>
      object.severity !== 'info' || object.problems.some((problem) => problem.status === 'open'),
  ).length;
  const financeBlocked = financeRows.filter(
    (object) =>
      ['Оплата сегодня', 'Просрочка', 'Ошибка синхронизации'].includes(object.statusLabel) ||
      object.problems.some((problem) => problem.status === 'open'),
  ).length;
  const warehouseBlocked = warehouseRows.filter(
    (object) =>
      object.problems.some((problem) => problem.status === 'open') ||
      object.severity === 'critical',
  ).length;
  const adminBlocked = adminRows.filter(
    (object) =>
      object.problems.some((problem) => problem.status === 'open') || object.severity !== 'info',
  ).length;
  const riskCount = orderRows.filter((row) => row.tags.includes('risk')).length;

  return [
    {
      id: 'decisions',
      title: 'Решения директора',
      value: String(decisionRows.length),
      detail: 'Рецепт, деньги или склад ждут выбора.',
      tone: 'info',
      actionLabel: 'Открыть решения',
      action: () => onQuickFilterChange('decisions', 'all'),
    },
    {
      id: 'production',
      title: 'Производство',
      value: String(productionBlocked),
      detail: 'Заказ-наряды с блокером или вниманием.',
      tone: 'risk',
      actionLabel: 'Показать производство',
      action: () => onOpenRole('production'),
    },
    {
      id: 'finance',
      title: 'Финансы',
      value: String(financeBlocked),
      detail: 'Просрочки, счет или источник данных.',
      tone: 'money',
      actionLabel: 'Показать финансы',
      action: () => onOpenRole('finance'),
    },
    {
      id: 'warehouse',
      title: 'Склад',
      value: String(warehouseBlocked),
      detail: 'QR, недостача, частичная приемка или выдача.',
      tone: 'warehouse',
      actionLabel: 'Показать склад',
      action: () => onQuickFilterChange('orders', 'warehouse'),
    },
    {
      id: 'admin',
      title: 'Устройства и доступы',
      value: String(adminBlocked),
      detail: 'Что сломано, не привязано или требует проверки.',
      tone: 'admin',
      actionLabel: 'Показать устройства',
      action: () => onOpenRole('admin'),
    },
    {
      id: 'risk',
      title: 'Сводный риск',
      value: String(riskCount),
      detail: 'Все строки с критичным или спорным состоянием.',
      tone: 'risk',
      actionLabel: 'Показать риски',
      action: () => onQuickFilterChange('orders', 'risk'),
    },
  ];
}

function directorRowFromObject(object: WorkObject, attention: boolean): DirectorTableRow {
  const objectNumber = factValue(object, 'Номер') ?? object.id;
  const risk = factValue(object, 'Риск');
  const money =
    factValue(object, 'Влияние на стоимость') ??
    factValue(object, 'Сумма') ??
    factValue(object, 'Статус оплаты');
  const type = directorRowType(object);
  const tags: DirectorRowTag[] = [];

  if (money || type === 'Деньги') tags.push('money');
  if (
    type === 'Склад' ||
    type === 'Сырье' ||
    object.title.includes('склад') ||
    object.title.includes('WH-')
  )
    tags.push('warehouse');
  if (
    type === 'Сырье' ||
    object.severity === 'critical' ||
    object.problems.some((problem) => problem.status === 'open')
  )
    tags.push('risk');

  return {
    id: object.id,
    type,
    objectLabel: objectNumber,
    status: object.statusLabel,
    impact: money ?? risk ?? factValue(object, 'Что решить') ?? 'Без отличий',
    owner: object.problems[0]?.ownerRole ?? object.nextOwner,
    lastEvent: object.audit[0]?.time ?? '--:--',
    sourceLabel: directorRowSourceLabel(object, type),
    stalenessLabel: directorRowStalenessLabel(object, type),
    basisLabel: directorRowBasisLabel(object, type),
    effectiveAtLabel: directorRowEffectiveAtLabel(object, type),
    auditCompletenessLabel:
      object.audit.length > 0
        ? `записей в истории: ${object.audit.length}`
        : 'история требует данных',
    severity: object.severity,
    tags: Array.from(new Set(tags)),
    attention,
    object,
  };
}

function directorRowSourceLabel(object: WorkObject, type: string) {
  if (type === 'Деньги') return 'финансовый снимок';
  if (type === 'Склад') return 'складской факт';
  if (type === 'Сырье') return 'складской факт / учетный снимок';
  if (type === 'Штраф') return 'контур штрафов';
  if (type === 'Аудит / QR') return 'данные платформы + складской факт';
  return factValue(object, 'Источник') ?? 'данные платформы';
}

function directorRowStalenessLabel(object: WorkObject, type: string) {
  if (type === 'Сырье') return 'остаток сегодня, дата действия цены требует сверки';
  if (type === 'Деньги') return 'ручной снимок сегодня';
  if (type === 'Склад') return 'последний складской скан';
  if (type === 'Аудит / QR') return 'текущая QR-история';
  return object.audit[0]?.time ? `последнее событие ${object.audit[0].time}` : 'данные сейчас';
}

function directorRowBasisLabel(object: WorkObject, type: string) {
  if (type === 'Сырье') return 'план / факт / резерв / справочник цен';
  if (type === 'Деньги') return 'счет, оплата, срок, история источника';
  if (type === 'Склад') return 'ожидалось / просканировано, недостача, контрольный вес';
  if (type === 'Штраф') return 'сотрудник, причина, сумма, автор';
  if (type === 'Аудит / QR') return 'связанный заказ, рулон и история QR';
  return (
    factValue(object, 'Что решить') ??
    factValue(object, 'Риск') ??
    'объект, владелец, доказательство'
  );
}

function directorRowEffectiveAtLabel(object: WorkObject, type: string) {
  if (type === 'Сырье') return 'остаток: сейчас; дата действия цены не подтверждена';
  if (type === 'Деньги') return factValue(object, 'Дата оплаты') ?? 'снимок оплаты: сегодня';
  if (type === 'Склад')
    return object.audit[0]?.time ? `приемка ${object.audit[0].time}` : 'текущая приемка';
  return object.audit[0]?.time ? `событие ${object.audit[0].time}` : 'сейчас';
}

function directorRowType(object: WorkObject) {
  // Live work-objects несут точный kind — классифицируем по нему, не по тексту статуса.
  if (object.kind === 'financeOrder') return 'Деньги';
  if (object.kind === 'productionOrder') return 'Производство';
  if (object.kind === 'warehouseJob') return 'Склад';
  if (object.id.includes('PEN') || object.title.includes('Штраф')) return 'Штраф';
  if (object.statusLabel === 'Сырье') return 'Сырье';
  if (object.statusLabel === 'Склад' || object.title.includes('склад') || object.id.includes('WH'))
    return 'Склад';
  if (factValue(object, 'Статус оплаты') || object.title.includes('FIN')) return 'Деньги';
  if (factValue(object, 'Что решить') === 'Неполная рецептура') return 'Риск';
  if (
    object.statusLabel === 'Рецепт/цена' ||
    object.statusLabel === 'Рецептура' ||
    factValue(object, 'Причина') ||
    factValue(object, 'Влияние на стоимость')
  )
    return 'Рецепт/цена';
  return object.statusLabel;
}

function directorOverviewItems(
  decisionRows: DirectorTableRow[],
  orderRows: DirectorTableRow[],
): DirectorOverviewItem[] {
  return [
    {
      label: 'Что решить',
      count: decisionRows.length,
      caption: 'ждет выбора',
      sourceLabel: 'история и решения',
      actionLabel: 'Открыть',
      tone: 'info',
      view: 'decisions' as const,
      filter: 'all' as const,
    },
    {
      label: 'Финансы',
      count: orderRows.filter((row) => row.type === 'Деньги').length,
      caption: 'суммы и оплата',
      sourceLabel: 'финансовый снимок',
      actionLabel: 'К финансам',
      tone: 'money',
      view: 'orders' as const,
      filter: 'money' as const,
    },
    {
      label: 'Склад',
      count: orderRows.filter((row) => row.tags.includes('warehouse')).length,
      caption: 'проблемы склада',
      sourceLabel: 'складской факт',
      actionLabel: 'К складу',
      tone: 'warehouse',
      view: 'orders' as const,
      filter: 'warehouse' as const,
    },
    {
      label: 'Риски',
      count: orderRows.filter((row) => row.tags.includes('risk')).length,
      caption: 'критично / внимание',
      sourceLabel: 'события платформы',
      actionLabel: 'К рискам',
      tone: 'risk',
      view: 'orders' as const,
      filter: 'risk' as const,
    },
  ];
}
