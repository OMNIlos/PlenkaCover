import { useEffect, useRef, useState, type RefObject } from 'react';

import { roleConfigs } from '../../domain/demoData';
import { getListItems, getObjectsForRole, getRoleConfig } from '../../domain/selectors';
import {
  aggregateProductionRollDispatchItems,
  assignedProductionOperatorCount,
} from '../../domain/rollWork';
import type { WorkObjectsByRole } from '../../domain/selectors';
import { severityLabel } from '../../domain/copy';
import { OPERATOR_ROLLS_SECTION, operatorListItems } from '../../domain/operatorRuntime';
import type { OperatorRuntimeState } from '../../domain/operatorRuntime';
import type { NotificationItem, PermissionPolicy, Role, UserSession } from '../../domain/types';
import { BrandMark } from './BrandMark';
import { trapFocusWithin } from './focusTrap';
import { SiemensIcon } from './SiemensIcon';

type SectionNavVisual =
  | 'intake'
  | 'draft'
  | 'handover'
  | 'queue'
  | 'blocker'
  | 'ready'
  | 'finance'
  | 'payment'
  | 'sync'
  | 'dashboard'
  | 'decision'
  | 'money'
  | 'warehouse'
  | 'penalty'
  | 'task'
  | 'active'
  | 'done'
  | 'qr'
  | 'device'
  | 'directory'
  | 'users'
  | 'access'
  | 'audit'
  | 'shift';
type SectionNavMeta = {
  visual: SectionNavVisual;
  summary: string;
};
type ProductNavigationGroup = 'primary' | 'secondary' | 'alert' | 'system';
type ProductNavigationItem = {
  section: string;
  label: string;
  icon: string;
  count: number;
  showCount: boolean;
  active: boolean;
  disabledReason?: string;
  help: string;
  visual: SectionNavVisual;
  group: ProductNavigationGroup;
};

function roleCountHelp(roleLabel: string, count: number) {
  return `${roleLabel}: ${count} строк в очереди.`;
}

function sectionCountLabel(count: number) {
  if (count === 1) return '1 строка';
  if (count > 1 && count < 5) return `${count} строки`;
  return `${count} строк`;
}

function shouldShowSectionCount(section: string, count: number) {
  if (section === 'Смена') return false;
  if (section === 'Контроль' || section === 'Дашборд') return false;
  return count > 0;
}

function directorSectionCount(section: string, workObjectsByRole: WorkObjectsByRole) {
  if (section === 'Контроль' || section === 'Дашборд') return 0;
  // Live-режим: контурные бейджи считаем по реальным объектам (kind), иначе demo-фильтр.
  const liveProduction = getObjectsForRole('production', workObjectsByRole).filter(
    (object) => object.kind === 'productionOrder',
  );
  const liveWarehouse = getObjectsForRole('warehouse', workObjectsByRole).filter(
    (object) => object.kind === 'warehouseJob',
  );
  if (section === 'Требуют решения') return getObjectsForRole('director', workObjectsByRole).length;
  if (section === 'Производство')
    return (
      liveProduction.length ||
      getObjectsForRole('director', workObjectsByRole).filter(
        (object) => object.id.includes('PROD') || object.id.includes('2606-006'),
      ).length
    );
  if (section === 'Финансы') return getObjectsForRole('finance', workObjectsByRole).length;
  if (section === 'Склад')
    return (
      liveWarehouse.length ||
      getObjectsForRole('director', workObjectsByRole).filter(
        (object) => object.id.includes('WH') || object.statusLabel === 'Склад',
      ).length
    );
  if (section === 'Аудит / QR') {
    return getObjectsForRole('director', workObjectsByRole).filter(
      (object) => object.statusLabel === 'Аудит / QR' || object.filterTags?.includes('Аудит / QR'),
    ).length;
  }
  return getListItems('director', 'Все', section, workObjectsByRole).length;
}

function roleSectionCount(role: Role, section: string, workObjectsByRole: WorkObjectsByRole) {
  if (section === 'Смена') return 1;
  // «Проблемы» живут в отдельном live-стейте (не в workObjectsByRole); счётчик
  // показывается в стат-окне и заголовке секции, в nav бейдж не считаем.
  if (role === 'production' && section === 'Проблемы') return 0;
  if (role === 'director') return directorSectionCount(section, workObjectsByRole);
  if (role === 'production' && section === 'Все рулоны') {
    return aggregateProductionRollDispatchItems(workObjectsByRole.production).length;
  }
  if (role === 'production' && section === 'Операторы / загрузка') {
    return assignedProductionOperatorCount(
      aggregateProductionRollDispatchItems(workObjectsByRole.production),
    );
  }
  return getListItems(role, 'Все', section, workObjectsByRole).length;
}

function roleSurfaceLabel(role: Role) {
  const labels: Record<Role, string> = {
    commercial: 'Заявки и передача',
    production: 'Заказ-наряды',
    finance: 'Финансовый контур',
    director: 'Панель директора',
    operator: 'Рулоны и смена',
    warehouse: 'Сканирование',
    admin: 'Настройки',
  };
  return labels[role];
}

function sectionNavLabel(role: Role, section: string) {
  if (role === 'director' && section === 'Дашборд') return 'Контроль';
  return section;
}

function sectionNavMeta(role: Role, section: string): SectionNavMeta {
  if (role === 'warehouse' && section === 'Все рулоны') {
    return { visual: 'task', summary: 'Фактические рулоны и следующий маршрут' };
  }
  const common: Record<string, SectionNavMeta> = {
    'Входящие заявки': { visual: 'intake', summary: 'Новые обращения и первичная полнота' },
    Черновики: { visual: 'draft', summary: 'Сохраненные заявки без передачи' },
    'В работе': {
      visual: role === 'operator' ? 'active' : 'handover',
      summary:
        role === 'operator'
          ? 'Текущие операции и ввод фактов'
          : 'Активные заявки с маршрутом производства, склада, оплаты и отгрузки',
    },
    'Очередь заказ-нарядов': { visual: 'queue', summary: 'Производственная подготовка заказов' },
    'Заказ-наряды': { visual: 'queue', summary: 'Производственная подготовка заказов' },
    'Все рулоны': { visual: 'task', summary: 'Ручная очередь, операторы и станки' },
    'Операторы / загрузка': { visual: 'users', summary: 'Назначенные рулоны и запас смены' },
    Проблемы: { visual: 'blocker', summary: 'Брак, поломки станков, баланс смены' },
    'Контрагенты и шаблоны': { visual: 'directory', summary: 'Клиенты, шаблоны и правила заказа' },
    Неполные: { visual: 'blocker', summary: 'Не хватает данных, чтобы продолжить' },
    Обзор: { visual: 'dashboard', summary: 'Сводка финансовых дел и приоритетов' },
    Счета: { visual: 'finance', summary: 'Выставление и статус счетов' },
    Финансы: { visual: 'finance', summary: 'Счета, оплаты и связанный заказ' },
    'Ждут счета': { visual: 'draft', summary: 'Заказ-наряды без выставленного счета' },
    Оплаты: { visual: 'payment', summary: 'Факты оплат и рассрочка после выдачи' },
    Рассрочка: { visual: 'money', summary: 'График платежей и остаток' },
    'Оплата сегодня': {
      visual: 'payment',
      summary: 'Плановые выплаты, где нужно выставить или отправить счет',
    },
    Просрочка: { visual: 'blocker', summary: 'Денежные проблемы, требующие разбора' },
    Синхронизация: { visual: 'sync', summary: 'Проверка источника и расхождений' },
    'Сверка источников': { visual: 'sync', summary: 'Ручная проверка источника и расхождений' },
    Источники: { visual: 'sync', summary: 'Здоровье источника и ручная проверка' },
    '1С': { visual: 'sync', summary: 'Соединение, импорты и безопасные снимки 1С' },
    Исключения: { visual: 'blocker', summary: 'Проблемы, просрочки и ручной разбор' },
    История: { visual: 'audit', summary: 'Последние события и журнал изменений' },
    Контроль: { visual: 'dashboard', summary: 'Сводные цифры и переходы в контуры' },
    Дашборд: { visual: 'dashboard', summary: 'Сводные цифры и переходы в контуры' },
    'Требуют решения': { visual: 'decision', summary: 'Единственная очередь конкретных решений' },
    Производство: { visual: 'queue', summary: 'Рецепт и производственные риски' },
    Деньги: { visual: 'money', summary: 'Суммы, оплаты и просрочки' },
    Склад: { visual: 'warehouse', summary: 'Проблемы приемки и выдачи' },
    Штрафы: { visual: 'penalty', summary: 'Штрафы и ответственность' },
    'Аудит / QR': { visual: 'audit', summary: 'События, QR-история и источники' },
    [OPERATOR_ROLLS_SECTION]: {
      visual: 'task',
      summary: 'Рулоны смены с заказами и текущим действием',
    },
    'Мои рулоны': { visual: 'task', summary: 'Рулоны смены с заказами и текущим действием' },
    'Мои заказы': { visual: 'task', summary: 'Рулоны смены с заказами и текущим действием' },
    Ожидают: { visual: 'queue', summary: 'Задачи до старта операции' },
    Заблокированы: { visual: 'blocker', summary: 'Работа остановлена до причины и восстановления' },
    Отложены: { visual: 'blocker', summary: 'Незавершенные заказы с сохраненным остатком' },
    'Переданы на склад': { visual: 'done', summary: 'Заказы после операторской передачи' },
    Смена: { visual: 'shift', summary: 'Открытие, Big-bag и сдача смены' },
    Зарплата: { visual: 'money', summary: 'Личные начисления по закрытым сменам' },
    Приемка: { visual: 'qr', summary: 'Скан рулонов и счетчик приемки' },
    'Прием брака': { visual: 'qr', summary: 'Прием мешков брака по QR' },
    'Отгрузка брака': { visual: 'handover', summary: 'Отгрузка принятых мешков брака' },
    'Запасы / резерв': { visual: 'warehouse', summary: 'Остатки, резерв и доступность рулонов' },
    Отгрузка: { visual: 'handover', summary: 'Подбор и закрытие выдачи клиенту' },
    Выдача: { visual: 'handover', summary: 'Подбор и закрытие выдачи клиенту' },
    'Ошибки QR': { visual: 'blocker', summary: 'Дубли, чужие коды и ручной разбор' },
    Частичные: { visual: 'warehouse', summary: 'Не хватает или есть лишние рулоны' },
    Закрытые: { visual: 'done', summary: 'Завершенные складские операции' },
    'Пользователи и роли': { visual: 'users', summary: 'Email, роль и состояние доступа' },
    Доступы: { visual: 'users', summary: 'Email, шаблон роли и состояние доступа' },
    'Шаблоны ролей': { visual: 'access', summary: 'Готовые наборы доступа для ролей' },
    Устройства: { visual: 'device', summary: 'Статус и короткая ошибка устройства' },
    Посты: { visual: 'device', summary: 'Автономные посты станков и gateway-доступ' },
    'Макет палетного листа': {
      visual: 'directory',
      summary: 'Черновая раскладка блоков и точный PNG-предпросмотр',
    },
    'Виды сырья': {
      visual: 'directory',
      summary: 'Общий список сырья для заявок коммерции и Big-Bag',
    },
    'Состояние платформы': {
      visual: 'dashboard',
      summary: 'Readiness обязательных и опциональных компонентов',
    },
    Инциденты: { visual: 'blocker', summary: 'Операционные проблемы, проверка и восстановление' },
    'Проблемы / история': { visual: 'audit', summary: 'Журнал проблем, проверок и действий' },
  };

  return (
    common[section] ?? {
      visual: role === 'admin' ? 'directory' : 'queue',
      summary: 'Рабочий раздел текущей роли',
    }
  );
}

function sectionNavIcon(visual: SectionNavVisual) {
  const icons: Record<SectionNavVisual, string> = {
    intake: 'add',
    draft: 'app-document-filled',
    handover: 'truck',
    queue: 'tasks-open',
    blocker: 'warning-square',
    ready: 'check',
    finance: 'table-tag',
    payment: 'check-out',
    sync: 'cloud-success',
    dashboard: 'gaugechart',
    decision: 'warning',
    money: 'calendar',
    warehouse: 'box-closed',
    penalty: 'warning-rhomb',
    task: 'tasks-open',
    active: 'play-stepwise-filled',
    done: 'shield-check',
    qr: 'qr-code',
    device: 'network-device',
    directory: 'table-settings',
    users: 'user-management-settings-filled',
    access: 'lock-key',
    audit: 'history-list',
    shift: 'capacity-check',
  };
  return icons[visual];
}

function sectionNavGroup(
  role: Role,
  section: string,
  visual: SectionNavVisual,
): ProductNavigationGroup {
  if (visual === 'blocker' || visual === 'penalty') return 'alert';
  const secondaryByRole: Record<Role, string[]> = {
    commercial: [],
    production: ['Контрагенты и шаблоны'],
    finance: ['Синхронизация'],
    director: [],
    operator: ['Ожидают', 'Отложены', 'Переданы на склад'],
    warehouse: ['Выдача', 'Запасы / резерв', 'Закрытые'],
    admin: [
      'Шаблоны ролей',
      'Макет палетного листа',
      'Виды сырья',
      'Состояние платформы',
      'Проблемы / история',
    ],
  };
  if (secondaryByRole[role]?.includes(section)) return role === 'admin' ? 'system' : 'secondary';
  return 'primary';
}

function primaryMobileItemLimit(role: Role) {
  if (role === 'commercial') return 3;
  if (role === 'operator') return 3;
  if (role === 'warehouse') return 3;
  return 4;
}

function splitNavigationItems(role: Role, items: ProductNavigationItem[]) {
  const primary = items.filter(
    (item) => item.group === 'primary' || (item.group === 'alert' && item.active),
  );
  const primarySet = new Set(primary.map((item) => item.section));
  const secondary = items.filter((item) => !primarySet.has(item.section));
  const limit = primaryMobileItemLimit(role);
  return {
    primary: primary.slice(0, limit),
    secondary: [...primary.slice(limit), ...secondary],
  };
}

function roleTopSectionCount(
  role: Role,
  section: string,
  operatorRuntime?: OperatorRuntimeState,
  workObjectsByRole?: WorkObjectsByRole,
) {
  if (role === 'operator' && section === 'Смена') return 1;
  if (role === 'operator' && operatorRuntime)
    return operatorListItems(operatorRuntime, 'Все', section).length;
  if (role === 'director')
    return workObjectsByRole ? roleSectionCount(role, section, workObjectsByRole) : 0;
  return getListItems(role, 'Все', section, workObjectsByRole).length;
}

function ProductNavigationButton({
  item,
  className,
  onSelect,
}: {
  item: ProductNavigationItem;
  className: string;
  onSelect: (section: string) => void;
}) {
  return (
    <button
      key={item.section}
      className={`${className} visual-${item.visual} group-${item.group} ${item.active ? 'is-active' : ''}`}
      onClick={() => {
        if (!item.disabledReason) onSelect(item.section);
      }}
      type="button"
      disabled={Boolean(item.disabledReason)}
      title={item.disabledReason ?? item.help}
      aria-label={item.label}
      aria-current={item.active ? 'page' : undefined}
    >
      <span className={`section-nav-visual visual-${item.visual}`} aria-hidden="true">
        <ix-icon name={item.icon} size="16" />
      </span>
      <span className="section-nav-copy">
        <strong>{item.label}</strong>
      </span>
      {item.showCount && (
        <span className="section-nav-meta">
          <span className="role-count" aria-label={`${item.count} строк`}>
            {item.count}
          </span>
        </span>
      )}
    </button>
  );
}

function ProductNavigationMoreButton({
  count,
  isOpen,
  onOpen,
  triggerRef,
}: {
  count: number;
  isOpen: boolean;
  onOpen: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      className={`mobile-section-nav-item mobile-section-nav-more ${isOpen ? 'is-active' : ''}`}
      type="button"
      onClick={onOpen}
      aria-expanded={isOpen}
      aria-label={`Еще разделы: ${count}`}
      ref={triggerRef}
    >
      <span className="section-nav-visual" aria-hidden="true">
        <ix-icon name="context-menu" size="16" />
      </span>
      <span className="section-nav-copy">
        <strong>Еще</strong>
      </span>
      <span className="section-nav-meta">
        <span className="role-count">{count}</span>
      </span>
    </button>
  );
}

function ProductNavigationDrawer({
  title,
  items,
  onSelect,
  onDismiss,
}: {
  title: string;
  items: ProductNavigationItem[];
  onSelect: (section: string) => void;
  onDismiss: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (items.length > 0) closeButtonRef.current?.focus();
  }, [items.length]);

  if (items.length === 0) return null;
  return (
    <div className="mobile-nav-drawer-layer" role="presentation">
      <button
        className="mobile-nav-drawer-backdrop"
        type="button"
        aria-label="Закрыть меню разделов"
        onClick={onDismiss}
        tabIndex={-1}
      />
      <div
        className="mobile-nav-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onDismiss();
            return;
          }
          trapFocusWithin(event);
        }}
      >
        <div className="mobile-nav-drawer-header">
          <span className="eyebrow">Разделы</span>
          <strong>{title}</strong>
          <button
            className="icon-close-button"
            type="button"
            onClick={onDismiss}
            aria-label="Закрыть меню разделов"
            ref={closeButtonRef}
          >
            <ix-icon name="close" size="24" />
          </button>
        </div>
        <div className="mobile-nav-drawer-list">
          {items.map((item) => (
            <ProductNavigationButton
              key={item.section}
              item={item}
              className="mobile-nav-drawer-item"
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function buildNavigationItem({
  role,
  section,
  count,
  activeSection,
  disabledReason,
}: {
  role: Role;
  section: string;
  count: number;
  activeSection: string;
  disabledReason?: string;
}): ProductNavigationItem {
  const meta = sectionNavMeta(role, section);
  const label = sectionNavLabel(role, section);
  const help = shouldShowSectionCount(section, count)
    ? `${label}: ${sectionCountLabel(count)}. ${meta.summary}.`
    : `${label}: ${meta.summary}.`;
  return {
    section,
    label,
    icon: sectionNavIcon(meta.visual),
    count,
    showCount: shouldShowSectionCount(section, count) && !disabledReason,
    active: activeSection === section,
    disabledReason,
    help,
    visual: meta.visual,
    group: sectionNavGroup(role, section, meta.visual),
  };
}

function unreadCount(notifications: NotificationItem[]) {
  return notifications.filter((notification) => !notification.readAt).length;
}

export function canAcknowledgeNotification(notification: NotificationItem) {
  return (
    notification.requiresAck &&
    notification.eventType !== 'notification:penalty_created' &&
    !notification.acknowledgedAt
  );
}

function TopMenuActionButton({
  icon,
  label,
  summary,
  count,
  tone = 'default',
  active,
  onClick,
  className,
  ariaLabel,
}: {
  icon: string;
  label: string;
  summary?: string;
  count?: number;
  tone?: 'default' | 'critical' | 'account';
  active: boolean;
  onClick: () => void;
  className: string;
  ariaLabel: string;
}) {
  return (
    <button
      className={`${className} top-menu-action tone-${tone} ${active ? 'is-active' : ''}`}
      onClick={onClick}
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      <span className="top-menu-action-icon" aria-hidden="true">
        <SiemensIcon name={icon} size="24" />
      </span>
      <span className="top-menu-action-copy">
        <strong>{label}</strong>
        {summary ? <small>{summary}</small> : null}
      </span>
      {count !== undefined && count > 0 && <span className="notification-badge">{count}</span>}
    </button>
  );
}

export function DemoRoleSwitcher({
  activeRole,
  operatorCount,
  workObjectsByRole,
  onChangeRole,
}: {
  activeRole: Role;
  operatorCount: number;
  workObjectsByRole: WorkObjectsByRole;
  onChangeRole: (role: Role) => void;
}) {
  return (
    <div className="demo-role-switcher" aria-label="Проверочный переключатель ролей">
      <span>Открыть роль</span>
      <div className="demo-role-buttons">
        {roleConfigs.map((role) => {
          const count =
            role.id === 'operator'
              ? operatorCount
              : getListItems(role.id, 'Все', undefined, workObjectsByRole).length;
          const help = roleCountHelp(role.label, count);
          return (
            <button
              key={role.id}
              className={`demo-role-button ${activeRole === role.id ? 'is-active' : ''}`}
              onClick={() => onChangeRole(role.id)}
              type="button"
              title={help}
            >
              <span>{role.label}</span>
              <span className="role-count">{count}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ProductHeader({
  activeSection,
  configLabel,
  session,
  unread,
  pendingAck,
  openPanel,
  onOpenPanel,
}: {
  activeSection: string;
  configLabel: string;
  session: UserSession;
  unread: number;
  pendingAck: number;
  openPanel: 'none' | 'notifications' | 'account';
  onOpenPanel: (panel: 'none' | 'notifications' | 'account') => void;
}) {
  const criticalCount = pendingAck > 0 ? pendingAck : undefined;
  const unreadSummary = unread > 0 ? `${unread} непрочитано` : 'нет новых';
  return (
    <header className="product-header">
      <div className="product-title">
        <BrandMark />
        <span className="product-title-copy">
          <span className="product-context-line">
            <span className="eyebrow">{configLabel}</span>
          </span>
          <strong>{activeSection}</strong>
        </span>
      </div>
      <div className="header-actions">
        <TopMenuActionButton
          className={`header-icon-button ${pendingAck > 0 ? 'has-critical' : ''}`}
          icon="warning"
          label="Контроль"
          summary={pendingAck > 0 ? 'есть реакция' : unreadSummary}
          count={criticalCount ?? (unread > 0 ? unread : undefined)}
          tone={pendingAck > 0 ? 'critical' : 'default'}
          active={openPanel === 'notifications'}
          onClick={() => onOpenPanel(openPanel === 'notifications' ? 'none' : 'notifications')}
          ariaLabel={`Контроль: ${pendingAck > 0 ? `${pendingAck} требуют реакции` : unreadSummary}`}
        />
        <TopMenuActionButton
          className="account-button"
          icon="user-management-settings-filled"
          label={session.name}
          tone="account"
          active={openPanel === 'account'}
          onClick={() => onOpenPanel(openPanel === 'account' ? 'none' : 'account')}
          ariaLabel={`Личный кабинет: ${session.name}, ${configLabel}`}
        />
      </div>
    </header>
  );
}

export function RoleNavigation({
  role,
  activeSection,
  workObjectsByRole,
  sectionCounts,
  sections,
  onChangeSection,
  hideCounts = false,
}: {
  role: Role;
  activeSection: string;
  workObjectsByRole?: WorkObjectsByRole;
  sectionCounts?: Partial<Record<string, number>>;
  sections?: readonly string[];
  onChangeSection: (section: string) => void;
  hideCounts?: boolean;
}) {
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const config = getRoleConfig(role);
  const visibleSections = sections ?? config.nav;
  const totalCount =
    role === 'director'
      ? visibleSections.reduce(
          (sum, section) =>
            sum +
            (sectionCounts?.[section] ??
              (workObjectsByRole ? roleSectionCount(role, section, workObjectsByRole) : 0)),
          0,
        )
      : workObjectsByRole
        ? getListItems(role, 'Все', undefined, workObjectsByRole).length
        : Object.values(sectionCounts ?? {}).reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const items = visibleSections.map((section) =>
    buildNavigationItem({
      role,
      section,
      count: hideCounts
        ? 0
        : (sectionCounts?.[section] ??
          (workObjectsByRole ? roleSectionCount(role, section, workObjectsByRole) : 0)),
      activeSection,
    }),
  );
  const mobileItems = splitNavigationItems(role, items);
  const dismissMore = () => {
    setIsMoreOpen(false);
    window.requestAnimationFrame(() => moreButtonRef.current?.focus());
  };
  const selectMore = (section: string) => {
    onChangeSection(section);
    setIsMoreOpen(false);
  };
  return (
    <aside className="role-nav" aria-label="Разделы текущей роли">
      <div className="role-nav-header">
        <div>
          {role !== 'finance' && <div className="rail-title">Рабочая поверхность</div>}
          <strong>{roleSurfaceLabel(role)}</strong>
        </div>
        {!hideCounts && role !== 'finance' && (
          <span className="role-nav-total" title={roleCountHelp(config.label, totalCount)}>
            {totalCount}
          </span>
        )}
      </div>
      <div className="section-nav-list">
        {items.map((item) => (
          <ProductNavigationButton
            key={item.section}
            item={item}
            className="section-nav-button"
            onSelect={onChangeSection}
          />
        ))}
      </div>
      <div className="mobile-section-nav" aria-label="Основные разделы текущей роли">
        {mobileItems.primary.map((item) => (
          <ProductNavigationButton
            key={item.section}
            item={item}
            className="mobile-section-nav-item"
            onSelect={onChangeSection}
          />
        ))}
        {mobileItems.secondary.length > 0 && (
          <ProductNavigationMoreButton
            count={mobileItems.secondary.length}
            isOpen={isMoreOpen}
            onOpen={() => setIsMoreOpen(true)}
            triggerRef={moreButtonRef}
          />
        )}
      </div>
      {isMoreOpen && (
        <ProductNavigationDrawer
          title={roleSurfaceLabel(role)}
          items={mobileItems.secondary}
          onSelect={selectMore}
          onDismiss={dismissMore}
        />
      )}
    </aside>
  );
}

export function RoleTopNavigation({
  role,
  activeSection,
  operatorRuntime,
  workObjectsByRole,
  sectionCounts,
  onChangeSection,
}: {
  role: Role;
  activeSection: string;
  operatorRuntime?: OperatorRuntimeState;
  workObjectsByRole?: WorkObjectsByRole;
  sectionCounts?: Partial<Record<string, number>>;
  onChangeSection: (section: string) => void;
}) {
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const config = getRoleConfig(role);
  const isOperatorStartLocked =
    role === 'operator' && operatorRuntime?.shift.status === 'start_missing';
  const items = config.nav.map((section) => {
    const count =
      sectionCounts?.[section] ??
      roleTopSectionCount(role, section, operatorRuntime, workObjectsByRole);
    const disabledReason =
      isOperatorStartLocked && section !== 'Смена' && section !== 'Зарплата' && section !== 'Штрафы'
        ? 'Сначала зафиксируйте стартовый вес Big-bag'
        : undefined;
    return buildNavigationItem({ role, section, count, activeSection, disabledReason });
  });
  const mobileItems = splitNavigationItems(role, items);
  const dismissMore = () => {
    setIsMoreOpen(false);
    window.requestAnimationFrame(() => moreButtonRef.current?.focus());
  };
  const selectMore = (section: string) => {
    onChangeSection(section);
    setIsMoreOpen(false);
  };
  return (
    <nav className="role-top-nav" aria-label="Разделы текущей роли">
      <div className="role-top-nav-list">
        {items.map((item) => (
          <ProductNavigationButton
            key={item.section}
            item={item}
            className="role-top-nav-item"
            onSelect={onChangeSection}
          />
        ))}
      </div>
      <div
        className="mobile-section-nav floor-mobile-section-nav"
        aria-label="Основные разделы текущей роли"
      >
        {mobileItems.primary.map((item) => (
          <ProductNavigationButton
            key={item.section}
            item={item}
            className="mobile-section-nav-item"
            onSelect={onChangeSection}
          />
        ))}
        {mobileItems.secondary.length > 0 && (
          <ProductNavigationMoreButton
            count={mobileItems.secondary.length}
            isOpen={isMoreOpen}
            onOpen={() => setIsMoreOpen(true)}
            triggerRef={moreButtonRef}
          />
        )}
      </div>
      {isMoreOpen && (
        <ProductNavigationDrawer
          title={roleSurfaceLabel(role)}
          items={mobileItems.secondary}
          onSelect={selectMore}
          onDismiss={dismissMore}
        />
      )}
    </nav>
  );
}

export function NotificationCenter({
  notifications,
  unreadCount,
  soundEnabled,
  hasMore,
  loadingMore,
  onLoadMore,
  onRead,
  onAck,
  onOpen,
  onClose,
}: {
  notifications: NotificationItem[];
  unreadCount: number;
  soundEnabled: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore?: () => void;
  onRead: (id: string) => void;
  onAck: (id: string) => void;
  onOpen?: (notification: NotificationItem) => void;
  onClose: () => void;
}) {
  return (
    <aside className="floating-panel notification-panel" aria-label="Уведомления">
      <div className="floating-panel-header">
        <div>
          <span className="eyebrow">Уведомления</span>
          <h3>{unreadCount} непрочитано</h3>
        </div>
        <button
          className="icon-close-button"
          type="button"
          onClick={onClose}
          aria-label="Закрыть уведомления"
        >
          <ix-icon name="close" size="24" />
        </button>
      </div>
      <div className="notification-sound-state">
        <ix-icon name={soundEnabled ? 'info' : 'close'} size="16" />
        <span>
          {soundEnabled
            ? 'Звук включен для выбранной роли'
            : 'Звук выключен. Визуальные уведомления остаются активны.'}
        </span>
      </div>
      <div className="notification-list">
        {notifications.length === 0 ? (
          <p className="muted">Нет уведомлений для текущей роли.</p>
        ) : (
          notifications.map((notification) => (
            <article
              key={notification.id}
              className={`notification-card severity-${notification.severity} ${notification.readAt ? 'is-read' : ''}`}
            >
              <div className="notification-card-head">
                <span className="eyebrow">{severityLabel(notification.severity)}</span>
                <time>{notification.createdAt}</time>
              </div>
              <strong>{notification.title}</strong>
              <p>{notification.body}</p>
              {notification.eventType ===
                'notification:production_order_fully_handed_over' &&
                notification.orderNumber && (
                  <details className="notification-order-info">
                    <summary>Информация о заказе</summary>
                    <span>
                      Номер заказа: <strong>{notification.orderNumber}</strong>
                    </span>
                    {notification.orderInfo && (
                      <>
                        <span>
                          Передано рулонов: <strong>{notification.orderInfo.rollCount}</strong>
                        </span>
                        {notification.orderInfo.rollCodes.length > 0 && (
                          <span>
                            Коды рулонов:{' '}
                            <strong>{notification.orderInfo.rollCodes.join(', ')}</strong>
                          </span>
                        )}
                        {notification.orderInfo.omittedRollCount > 0 && (
                          <span>Ещё {notification.orderInfo.omittedRollCount} рулонов</span>
                        )}
                      </>
                    )}
                  </details>
                )}
              {notification.objectId && (
                <span className="notification-object">Объект: {notification.objectId}</span>
              )}
              <div className="notification-actions">
                {notification.navigation && onOpen && (
                  <button
                    className="notification-secondary-button"
                    type="button"
                    onClick={() => onOpen(notification)}
                  >
                    Открыть
                  </button>
                )}
                {!notification.readAt && (
                  <button
                    className="notification-secondary-button"
                    type="button"
                    onClick={() => onRead(notification.id)}
                  >
                    <ix-icon name="check" size="16" />
                    Прочитано
                  </button>
                )}
                {canAcknowledgeNotification(notification) && (
                  <button
                    type="button"
                    className="ack-button"
                    onClick={() => onAck(notification.id)}
                  >
                    <ix-icon name="check" size="16" />
                    Подтвердить
                  </button>
                )}
                {notification.eventType !== 'notification:penalty_created' &&
                  notification.acknowledgedAt && <span className="ack-state">Подтверждено</span>}
              </div>
            </article>
          ))
        )}
      </div>
      {hasMore && onLoadMore ? (
        <div className="notification-pagination">
          <button
            className="notification-secondary-button"
            type="button"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? 'Загрузка…' : 'Показать ещё'}
          </button>
        </div>
      ) : null}
    </aside>
  );
}

export function AccountCabinet({
  session,
  policy,
  onToggleSound,
  onToggleReducedMotion,
  onLogout,
  onClose,
}: {
  session: UserSession;
  policy: PermissionPolicy;
  onToggleSound: () => void;
  onToggleReducedMotion: () => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="floating-panel account-panel" aria-label="Личный кабинет">
      <div className="floating-panel-header">
        <div>
          <span className="eyebrow">Личный кабинет</span>
          <h3>{session.name}</h3>
        </div>
        <button
          className="icon-close-button"
          type="button"
          onClick={onClose}
          aria-label="Закрыть личный кабинет"
        >
          <ix-icon name="close" size="24" />
        </button>
      </div>
      <section className="account-section">
        <h4>Доступные разделы</h4>
        <div className="account-chip-row">
          {policy.visibleSections.map((section) => (
            <span key={section}>{section}</span>
          ))}
        </div>
      </section>
      <section className="account-section">
        <h4>Настройки уведомлений</h4>
        <button
          className={`setting-toggle ${session.notificationSound ? 'is-active' : ''}`}
          type="button"
          onClick={onToggleSound}
          aria-pressed={session.notificationSound}
        >
          <ix-icon name={session.notificationSound ? 'check' : 'close'} size="16" />
          {session.notificationSound ? 'Звук включен' : 'Включить звук'}
        </button>
        <button
          className={`setting-toggle ${session.reducedMotion ? 'is-active' : ''}`}
          type="button"
          onClick={onToggleReducedMotion}
          aria-pressed={session.reducedMotion}
        >
          <ix-icon name="check" size="16" />
          {session.reducedMotion ? 'Анимация снижена' : 'Обычная анимация'}
        </button>
      </section>
      <button className="logout-button" type="button" onClick={onLogout}>
        <ix-icon name="close" size="16" />
        Выйти
      </button>
    </aside>
  );
}
