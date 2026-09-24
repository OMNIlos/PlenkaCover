export const visualNoisePrimarySelectors = {
  commercial: [
    '.order-primary-action',
    '.commercial-next-action',
    '.commercial-overview-focus',
    '.queue-row.is-selected',
    '.queue-row',
  ],
  production: [
    '.production-orders-hub',
    '.production-orders-table-panel',
    '.production-operator-load-surface',
    '.production-decision-strip',
    '.template-directory-toolbar',
    '.template-card-list',
    '.action-surface',
  ],
  finance: [
    '.finance-workbench',
    '.finance-calendar-card',
    '.finance-primary-action-panel',
    '.finance-mobile-primary-action',
    '.finance-command-grid',
  ],
  director: [
    '.commercial-performance-workspace',
    '.management-executive-kpis',
    '.management-report-kpi',
    '.director-table-wrap',
    '.director-qr-surface',
    '.director-finance-surface',
    '.penalty-workbench',
  ],
  operator: [
    '.operator-rolls-hub-page',
    '.operator-rolls-hub-table',
    '.operator-focus',
    '.operator-current-roll',
    '.operator-table-summary',
    '.operator-shift-panel',
    '.terminal-actions',
  ],
  warehouse: [
    '.warehouse-scan-station-page',
    '.warehouse-scan-station-layout',
    '.scan-focus-strip',
    '.warehouse-scan-session-strip',
    '.warehouse-action-deck',
    '.warehouse-inventory-cockpit',
  ],
  admin: [
    '.detail-panel',
    '.admin-primary-safe-action',
    '.admin-access-surface',
    '.admin-system-focus',
    '.admin-action-led-table',
    '.admin-assignment-panel',
  ],
};

export function hasFirstViewportPrimarySurface(role, findVisible) {
  return (visualNoisePrimarySelectors[role] ?? []).some(findVisible);
}
