import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import {
  focusableSelector,
  isEventFromNestedDialog,
  isUsableFocusTarget,
  trapFocusWithin,
} from '../shell/focusTrap';

export { isEventFromNestedDialog } from '../shell/focusTrap';

type Tone = 'info' | 'success' | 'warning' | 'critical' | 'muted' | 'money' | 'production' | 'risk' | 'neutral';

export const tablePageSize = {
  desktop: 25,
  mobile: 10,
};

function isMobileTableViewport() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 760px)').matches;
}

export function useResponsiveTablePageSize({
  desktop = tablePageSize.desktop,
  mobile = tablePageSize.mobile,
}: Partial<typeof tablePageSize> = {}) {
  const [pageSize, setPageSize] = useState(() => (isMobileTableViewport() ? mobile : desktop));

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mediaQuery = window.matchMedia('(max-width: 760px)');
    const syncPageSize = () => setPageSize(mediaQuery.matches ? mobile : desktop);
    syncPageSize();
    mediaQuery.addEventListener('change', syncPageSize);
    return () => mediaQuery.removeEventListener('change', syncPageSize);
  }, [desktop, mobile]);

  return pageSize;
}

export function useTablePagination<T>(items: T[], page: number, pageSize: number) {
  return useMemo(() => {
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(1, page), pageCount);
    const startIndex = items.length === 0 ? 0 : (safePage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, items.length);
    return {
      pageCount,
      safePage,
      startIndex,
      endIndex,
      pageRows: items.slice(startIndex, endIndex),
    };
  }, [items, page, pageSize]);
}

export function TablePager({
  page,
  pageCount,
  total,
  startIndex,
  endIndex,
  onPageChange,
  pageSize,
  pageSizeOptions,
  onPageSizeChange,
  className = '',
}: {
  page: number;
  pageCount: number;
  total: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
  className?: string;
}) {
  const rangeLabel = total > 0 ? `${startIndex + 1}-${endIndex} из ${total}` : `0 из ${total}`;
  const showPageSize = pageSize && pageSizeOptions?.length && onPageSizeChange;
  return (
    <footer className={`plenki-table-pager ${className}`.trim()} aria-label="Пагинация таблицы">
      <span>{rangeLabel}</span>
      <div>
        <button type="button" disabled={page <= 1} onClick={() => onPageChange(Math.max(1, page - 1))}>
          Назад
        </button>
        <strong>Стр. {page}/{pageCount}</strong>
        <button type="button" disabled={page >= pageCount} onClick={() => onPageChange(Math.min(pageCount, page + 1))}>
          Вперед
        </button>
      </div>
      {showPageSize ? (
        <label>
          <span>Строк</span>
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} aria-label="Строк на странице">
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
      ) : null}
    </footer>
  );
}

export type PlenkiDataTableColumn<T> = {
  id: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
  cellClassName?: string | ((row: T, index: number) => string | undefined);
  dataLabel?: string;
  width?: string;
  sortable?: boolean;
  sortDirection?: 'asc' | 'desc' | 'none';
  onSort?: () => void;
  ariaLabel?: string;
};

export function PlenkiDataTable<T>({
  caption,
  columns,
  rows,
  getRowKey,
  getRowClassName,
  isRowSelected,
  onRowClick,
  renderExpandedRow,
  empty,
  className = '',
  tableClassName = '',
}: {
  caption?: string;
  columns: Array<PlenkiDataTableColumn<T>>;
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  getRowClassName?: (row: T, index: number) => string | undefined;
  isRowSelected?: (row: T, index: number) => boolean;
  onRowClick?: (row: T, index: number, trigger?: HTMLTableRowElement) => void;
  renderExpandedRow?: (row: T, index: number) => ReactNode;
  empty?: ReactNode;
  className?: string;
  tableClassName?: string;
}) {
  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) {
    if (!onRowClick) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.currentTarget.focus();
    onRowClick(row, index, event.currentTarget);
  }

  function handleRowClick(
    event: MouseEvent<HTMLTableRowElement> | undefined,
    row: T,
    index: number,
  ) {
    if (!onRowClick) return;
    event?.currentTarget.focus();
    onRowClick(row, index, event?.currentTarget);
  }

  return (
    <div className={`plenki-data-table-shell ${className}`.trim()}>
      <table className={`plenki-data-table ${tableClassName}`.trim()}>
        {caption ? <caption>{caption}</caption> : null}
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.width ? { width: column.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.id}
                className={[
                  column.align ? `align-${column.align}` : '',
                  column.headerClassName,
                ].filter(Boolean).join(' ')}
                aria-sort={column.sortDirection && column.sortDirection !== 'none' ? (column.sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {column.sortable && column.onSort ? (
                  <button type="button" className={column.sortDirection && column.sortDirection !== 'none' ? 'is-active' : undefined} onClick={column.onSort} aria-label={column.ariaLabel}>
                    <span>{column.header}</span>
                    <small aria-hidden="true">{column.sortDirection === 'asc' ? '↑' : column.sortDirection === 'desc' ? '↓' : '↕'}</small>
                  </button>
                ) : column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = getRowKey(row, index);
            const selected = isRowSelected?.(row, index) ?? false;
            const expanded = renderExpandedRow?.(row, index);
            return (
              <Fragment key={key}>
                <tr
                  className={[
                    onRowClick ? 'is-interactive' : '',
                    selected ? 'is-selected' : '',
                    getRowClassName?.(row, index),
                  ].filter(Boolean).join(' ')}
                  role={onRowClick ? 'button' : undefined}
                  aria-selected={selected || undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? (event) => handleRowClick(event, row, index) : undefined}
                  onKeyDown={(event) => handleRowKeyDown(event, row, index)}
                >
                  {columns.map((column) => {
                    const cellClassName = typeof column.cellClassName === 'function'
                      ? column.cellClassName(row, index)
                      : column.cellClassName;
                    return (
                      <td
                        key={column.id}
                        className={[
                          column.align ? `align-${column.align}` : '',
                          column.className,
                          cellClassName,
                        ].filter(Boolean).join(' ')}
                        data-label={column.dataLabel ?? (typeof column.header === 'string' ? column.header : column.id)}
                      >
                        {column.render(row, index)}
                      </td>
                    );
                  })}
                </tr>
                {expanded ? (
                  <tr key={`${key}:expanded`} className="plenki-data-table-expanded-row">
                    <td colSpan={columns.length}>{expanded}</td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {rows.length === 0 ? (
            <tr className="plenki-data-table-empty-row">
              <td colSpan={columns.length}>
                {empty ?? (
                  <div className="plenki-empty-state">
                    <strong>Нет строк</strong>
                    <span>Измените поиск или фильтры.</span>
                  </div>
                )}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

export function PlenkiToolbar({
  eyebrow,
  title,
  searchValue,
  searchPlaceholder = 'Поиск',
  onSearchChange,
  filters = [],
  meta,
  actions,
  children,
  className = '',
}: {
  eyebrow?: string;
  title?: ReactNode;
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  filters?: Array<{ id: string; label: string; count?: number; active: boolean; onClick: () => void }>;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`plenki-toolbar ${className}`.trim()} aria-label={typeof title === 'string' ? title : 'Панель таблицы'}>
      {(eyebrow || title || actions) && (
        <header className="plenki-toolbar-head">
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            {title ? <strong>{title}</strong> : null}
          </div>
          {actions ? <div className="plenki-toolbar-actions">{actions}</div> : null}
        </header>
      )}
      <div className="plenki-toolbar-row">
        {onSearchChange ? (
          <label className="plenki-search-field">
            <ix-icon name="search" size="16" />
            <span className="sr-only">{searchPlaceholder}</span>
            <input value={searchValue ?? ''} onChange={(event) => onSearchChange(event.target.value)} placeholder={searchPlaceholder} />
          </label>
        ) : null}
        {filters.length > 0 ? (
          <div className="plenki-filter-row" role="radiogroup" aria-label="Фильтры">
            {filters.map((filter) => (
              <button key={filter.id} type="button" className={filter.active ? 'is-active' : undefined} role="radio" aria-checked={filter.active} onClick={filter.onClick}>
                <span>{filter.label}</span>
                {typeof filter.count === 'number' ? <small>{filter.count}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
        {meta ? <div className="plenki-toolbar-meta">{meta}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function PlenkiMetricStrip({
  metrics,
  className = '',
  cardClassName = '',
}: {
  metrics: Array<{
    id: string;
    label: string;
    value: ReactNode;
    caption?: ReactNode;
    source?: ReactNode;
    showSource?: boolean;
    tone?: Tone;
    onClick?: () => void;
    actionLabel?: string;
  }>;
  className?: string;
  cardClassName?: string;
}) {
  return (
    <section className={`plenki-metric-strip ${className}`.trim()} aria-label="Ключевые показатели">
      {metrics.map((metric) => {
        const metricClassName = `plenki-metric-card tone-${metric.tone ?? 'info'} ${cardClassName}`.trim();
        const title = typeof metric.source === 'string' ? metric.source : metric.actionLabel;
        const content = (
          <>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            {metric.caption ? <em>{metric.caption}</em> : null}
            {metric.source && metric.showSource ? <small>{metric.source}</small> : null}
          </>
        );
        return metric.onClick ? (
          <button key={metric.id} type="button" className={metricClassName} onClick={metric.onClick} aria-label={metric.actionLabel ?? metric.label} title={title}>
            {content}
          </button>
        ) : (
          <article key={metric.id} className={metricClassName} title={title}>
            {content}
          </article>
        );
      })}
    </section>
  );
}

export function PlenkiModal({
  title,
  eyebrow,
  headerActions,
  children,
  footer,
  onClose,
  className = '',
  headerClassName = '',
  bodyClassName = '',
  footerClassName = '',
  closeDisabled = false,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  headerActions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  closeDisabled?: boolean;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return undefined;

    const requestedAutofocus = modal.querySelector<HTMLElement>('[autofocus]');
    const activeElement = document.activeElement;
    const initialFocus =
      (requestedAutofocus && isUsableFocusTarget(requestedAutofocus)
        ? requestedAutofocus
        : null) ??
      (activeElement instanceof HTMLElement &&
        modal.contains(activeElement) &&
        isUsableFocusTarget(activeElement)
        ? activeElement
        : null) ??
      Array.from(modal.querySelectorAll<HTMLElement>(focusableSelector)).find(
        isUsableFocusTarget,
      ) ??
      modal;
    initialFocus.focus();
    if (!modal.contains(document.activeElement)) modal.focus();

    return () => {
      restorePlenkiModalFocus(previousFocusRef.current);
    };
  }, []);

  const requestClose = () => {
    if (!closeDisabled) onClose();
  };
  const overlay = (
    <div className="plenki-overlay" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section
        ref={modalRef}
        className={`plenki-modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Диалог'}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            isEventFromNestedDialog(event.currentTarget, event.target)
          ) {
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            requestClose();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <header
          className={`plenki-modal-head ${headerClassName}`.trim()}
        >
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h3>{title}</h3>
          </div>
          <div className="plenki-modal-head-actions">
            {headerActions}
            <button
              className="plenki-icon-button"
              type="button"
              aria-label="Закрыть"
              disabled={closeDisabled}
              onClick={requestClose}
            >
              <ix-icon name="close" size="16" />
            </button>
          </div>
        </header>
        <div className={`plenki-modal-body ${bodyClassName}`.trim()}>{children}</div>
        {footer ? (
          <footer className={`plenki-modal-footer ${footerClassName}`.trim()}>
            {footer}
          </footer>
        ) : null}
      </section>
    </div>
  );

  return typeof document === 'undefined' ? overlay : createPortal(overlay, document.body);
}

export function restorePlenkiModalFocus(previousFocus: HTMLElement | null): void {
  if (previousFocus && isUsableFocusTarget(previousFocus)) {
    previousFocus.focus();
  }
}

export function PlenkiDrawer({
  title,
  eyebrow,
  children,
  footer,
  onClose,
  className = '',
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  return (
    <div className="plenki-overlay plenki-drawer-overlay" role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className={`plenki-drawer ${className}`.trim()} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Панель'} onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}>
        <header className="plenki-modal-head">
          <div>
            {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
            <h3>{title}</h3>
          </div>
          <button className="plenki-icon-button" type="button" aria-label="Закрыть" onClick={onClose}>
            <ix-icon name="close" size="16" />
          </button>
        </header>
        <div className="plenki-drawer-body">{children}</div>
        {footer ? <footer className="plenki-modal-footer">{footer}</footer> : null}
      </aside>
    </div>
  );
}

export function PlenkiBulkBar({
  count,
  label = 'выбрано',
  actions,
  onClear,
}: {
  count: number;
  label?: string;
  actions: ReactNode;
  onClear: () => void;
}) {
  if (count <= 0) return null;
  return (
    <aside className="plenki-bulk-bar" aria-label="Массовые действия">
      <strong>{count} {label}</strong>
      <div>{actions}</div>
      <button type="button" onClick={onClear}>Снять выбор</button>
    </aside>
  );
}

export function PlenkiSwitch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`plenki-switch ${checked ? 'is-on' : ''} ${disabled ? 'is-disabled' : ''}`.trim()}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="plenki-switch-track" aria-hidden="true"><i /></span>
      <span className="plenki-switch-copy">
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}
