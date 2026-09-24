import { useEffect, useMemo, useState, type ComponentType, type KeyboardEvent } from 'react';

import { fetchFinanceOrderHistory } from '../../api/finance';
import {
  getFinanceCalendarEvents,
  getFinancePaymentConditions,
  getFinanceCommandItem,
  getFinanceCommandItems,
  getFinanceNextStep,
  displayOrderModeForSection,
} from '../../domain/selectors';
import { financeDisplayContractFromObject } from '../../domain/displayContracts';
import { businessClockAt } from '../../domain/runtime/businessClock';
import { normalizeFinanceSection } from '../../domain/financeSections';
import { counterpartyForObject, templatesForCounterparty } from '../../domain/templates';
import type {
  ActionDescriptor,
  Fact,
  FinanceCorrectablePayment,
  FinancePaymentCorrectionTarget,
  WorkObject,
} from '../../domain/types';
import { actionDisplayLabel, actionIcon } from '../shell/actionPresentation';
import { SiemensIcon } from '../shell/SiemensIcon';
import { FinanceInstallmentControl } from './FinanceInstallmentControl';
import { FinanceInvoiceSyncAction } from './FinanceInvoiceSyncAction';
import { moneyDraftLabel, parseMoneyDraft } from './financeMoney';
import { financePaymentHistory } from './financePaymentHistory';
import { projectFinanceContextHistory } from './financeContextHistory';
import { FinancePaymentCalendar } from './FinancePaymentCalendar';
import { FinancePaymentCorrectionDialog } from './FinancePaymentCorrectionDialog';
import { FinanceWarehouseCoverage } from './WarehouseCoverageCard';

type FactValueReader = (object: WorkObject, label: string) => string | undefined;
type FactListComponent = ComponentType<{ facts: Fact[] }>;
type FinanceActionPayload = {
  operationAmount?: number;
  operationAmountLabel?: string;
};
type FinanceActionHandler = (actionId: string, payload?: FinanceActionPayload) => void;
type FinanceWorkbenchProps = {
  object: WorkObject;
  factValue: FactValueReader;
  FactList: FactListComponent;
  onAction?: FinanceActionHandler;
  siblingObjects?: WorkObject[];
  onSelectObject?: (objectId: string) => void;
  onBackToRegistry?: () => void;
  activeSection?: string;
  isRegistryPage?: boolean;
  onFinanceObjectUpdated?: (object: WorkObject) => void;
  onCorrectPayment?: (target: FinancePaymentCorrectionTarget, reason: string) => Promise<boolean>;
  businessNow?: Date;
  coverageRefreshGeneration?: number;
};

function invoiceNumberForObject(object: WorkObject, factValue: FactValueReader) {
  const explicitInvoice = factValue(object, 'Номер счета') ?? factValue(object, 'Счет');
  if (explicitInvoice && !explicitInvoice.toLowerCase().includes('статус')) return explicitInvoice;

  const auditInvoice = object.audit
    .map((entry) => `${entry.detail} ${entry.sourceSnapshot ?? ''}`)
    .join(' ')
    .match(/INV-\d{4}-\d{3}/)?.[0];
  if (auditInvoice) return auditInvoice;

  const invoiceStatus = (factValue(object, 'Статус счета') ?? object.statusLabel).toLowerCase();
  if (
    invoiceStatus.includes('не выставлен') ||
    invoiceStatus.includes('не создан') ||
    invoiceStatus.includes('не отправлен')
  ) {
    return 'Не создан';
  }

  const orderNumber = factValue(object, 'Номер') ?? object.id.replace(/^FIN-/, 'ЗН-');
  return `INV-${orderNumber.replace(/^ЗН-/, '')}`;
}

function orderRowsForFinanceObject(object: WorkObject, factValue: FactValueReader) {
  if (object.rollGroups && object.rollGroups.length > 0) {
    return object.rollGroups.map((group) => ({
      group: group.title,
      film: `${group.filmType}, ${group.micron} · ${group.sizeMeters}`,
      mark: group.color,
      rolls: `${group.plannedRolls} шт. · ${group.plannedNetKg} кг`,
      sleeve: group.sleeve,
    }));
  }

  if (object.commercialOrder?.positions.length) {
    return object.commercialOrder.positions.map((position, index) => {
      const dimensions = [
        position.widthMm == null ? null : `${position.widthMm.toLocaleString('ru-RU')} мм`,
        position.plannedLengthM == null
          ? null
          : `${position.plannedLengthM.toLocaleString('ru-RU')} м`,
      ]
        .filter(Boolean)
        .join(' × ');
      return {
        group: `Вид ${index + 1}`,
        film: `${position.filmType} · факт. ${position.actualThickness} · учёт. ${position.accountingThickness}${dimensions ? ` · ${dimensions}` : ''}`,
        mark: position.birka,
        rolls: `${position.rollCount} шт.${position.plannedWeightKg ? ` · ${position.plannedWeightKg} кг/рулон` : ''}`,
        sleeve: position.spoolType,
      };
    });
  }

  return [
    {
      group: 'Состав',
      film: factValue(object, 'Позиции') ?? factValue(object, 'Рулоны') ?? 'Нужен состав заказа',
      mark: factValue(object, 'Бирка') ?? factValue(object, 'Цвет') ?? 'по заказ-наряду',
      rolls: factValue(object, 'Рулоны') ?? 'нет структурных групп',
      sleeve: factValue(object, 'Втулка') ?? 'нет данных',
    },
  ];
}

function FinanceActionButton({
  action,
  onAction,
  prominent = false,
}: {
  action: ActionDescriptor;
  onAction?: FinanceActionHandler;
  prominent?: boolean;
}) {
  const label = actionDisplayLabel(action);
  const disabledTitle = !action.enabled
    ? [action.disabledReason, action.recoveryOwner, action.recoveryAction]
        .filter(Boolean)
        .join(' · ')
    : undefined;

  return (
    <button
      className={`compact-action-button action-${action.level} ${prominent ? 'finance-command-primary' : ''}`.trim()}
      type="button"
      disabled={!action.enabled}
      title={disabledTitle ?? action.helpText ?? action.confirmation ?? action.label}
      aria-label={disabledTitle ? `${label}. ${disabledTitle}` : label}
      onClick={() => onAction?.(action.id)}
    >
      <SiemensIcon name={actionIcon(action)} size={prominent ? '24' : '16'} />
      <span>{label}</span>
    </button>
  );
}

function isInvoiceAction(action: ActionDescriptor) {
  return action.id === 'issue' || action.id.startsWith('finance-create-invoice:');
}

function FinanceOperationAmountAction({
  action,
  onAction,
}: {
  action: ActionDescriptor;
  onAction?: FinanceActionHandler;
}) {
  const [amountDraft, setAmountDraft] = useState('');
  const amount = parseMoneyDraft(amountDraft);
  const disabled = !action.enabled || amount === undefined;

  return (
    <div
      className="finance-invoice-amount-action finance-operation-amount-action"
      aria-label={action.label}
    >
      <label>
        <span>Сумма выплаты</span>
        <input
          inputMode="decimal"
          value={amountDraft}
          onChange={(event) => setAmountDraft(event.currentTarget.value)}
          placeholder="60000"
        />
      </label>
      <button
        className="compact-action-button action-secondary"
        type="button"
        disabled={disabled}
        title={disabled ? 'Введите сумму выплаты' : (action.helpText ?? action.label)}
        onClick={() =>
          amount &&
          onAction?.(action.id, {
            operationAmount: amount,
            operationAmountLabel: moneyDraftLabel(amount),
          })
        }
      >
        <SiemensIcon name={actionIcon(action)} size="16" />
        <span>{actionDisplayLabel(action)}</span>
      </button>
    </div>
  );
}

const financeRegistryFilterLabels = {
  all: 'Все',
  action: 'Действия',
  problem: 'Проблемы',
  overdue: 'Просрочка',
  paid: 'Закрыто',
} as const;

type FinanceRegistryFilter = keyof typeof financeRegistryFilterLabels;
type FinanceRegistrySort = 'priority' | 'due' | 'amount' | 'customer';

function financeProblemCopy(problem: WorkObject['problems'][number]) {
  if (problem.stage === 'Источник данных') {
    return {
      title: 'Ручная проверка перед оплатой',
      reason: 'Автоматическое подтверждение счета и оплаты остановлено до повторной проверки.',
      recovery: problem.recovery,
    };
  }
  return {
    title: problem.title,
    reason: problem.reason,
    recovery: problem.recovery,
  };
}

function financeItemMatchesSection(
  _item: ReturnType<typeof getFinanceCommandItem>,
  section: string,
  object?: WorkObject,
) {
  if (section === 'Счета') return true;
  if (section === 'Рассрочка') {
    return Boolean(
      object?.paymentPolicy || object?.paymentSchedule || object?.paymentSchedules?.length,
    );
  }
  if (section === 'Просрочки') return object?.financeBusinessPayment?.isOverdue === true;
  return false;
}

function financeItemMatchesRegistryFilter(
  item: ReturnType<typeof getFinanceCommandItem>,
  filter: FinanceRegistryFilter,
) {
  if (filter === 'all') return true;
  if (filter === 'action') return item.recommendedAction.trim().length > 0;
  if (filter === 'problem') return item.severity !== 'info' || item.exceptionKind !== 'none';
  if (filter === 'overdue')
    return item.exceptionKind === 'overdue' || item.paymentStatus === 'overdue';
  if (filter === 'paid') return item.paymentStatus === 'paid';
  return true;
}

function financeAmountNumber(label: string) {
  const normalized = label.replace(/[^\d-]/g, '');
  return normalized ? Number(normalized) : 0;
}

function financeDueSortValue(item: ReturnType<typeof getFinanceCommandItem>, todayIso: string) {
  if (item.dueDateIso) return item.dueDateIso;
  if (item.dueBucket === 'сегодня') return todayIso;
  if (item.exceptionKind === 'overdue') return '2026-01-01';
  return '9999-12-31';
}

function financeRegistryBackLabel(section: string) {
  if (section === 'Рассрочка') return 'К списку рассрочек';
  if (section === 'Просрочки') return 'К списку просрочек';
  return 'К списку счетов';
}

function FinanceInstallmentSchedule({ object }: { object: WorkObject }) {
  const schedules = object.paymentSchedules ?? [];
  if (schedules.length === 0) return null;
  const statusLabel = (status: (typeof schedules)[number]['status']) => {
    if (status === 'paid') return 'Оплачен';
    if (status === 'overdue') return 'Просрочен';
    if (status === 'due_today') return 'Срок сегодня';
    return 'Ожидает оплаты';
  };
  return (
    <section
      className="finance-panel finance-installment-schedule"
      aria-label="Полный график рассрочки"
    >
      <div className="finance-panel-heading">
        <h4>Полный график рассрочки</h4>
        <span>{schedules.length} этап.</span>
      </div>
      <div className="finance-installment-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Этап</th>
              <th>Условие / дата</th>
              <th>Сумма</th>
              <th>Оплачено</th>
              <th>Остаток</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((schedule, index) => (
              <tr key={schedule.id}>
                <td data-label="Этап">Этап {schedule.sequence ?? index + 1}</td>
                <td data-label="Условие / дата">{schedule.dueDateLabel}</td>
                <td data-label="Сумма">{schedule.amountLabel}</td>
                <td data-label="Оплачено">{schedule.paidAmountLabel ?? 'Нет данных'}</td>
                <td data-label="Остаток">{schedule.remainingAmountLabel ?? 'Нет данных'}</td>
                <td data-label="Статус">{statusLabel(schedule.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function FinanceWorkbench({
  object,
  factValue,
  FactList,
  onAction,
  siblingObjects = [object],
  onSelectObject,
  onBackToRegistry,
  activeSection = 'Счета',
  isRegistryPage = false,
  onFinanceObjectUpdated,
  onCorrectPayment,
  businessNow,
  coverageRefreshGeneration,
}: FinanceWorkbenchProps) {
  const resolvedSection = normalizeFinanceSection(activeSection);
  const effectiveBusinessNow = businessNow ?? new Date();
  const financeClock = businessClockAt(effectiveBusinessNow);
  const primaryProblem = object.problems.find((problem) => problem.status === 'open');
  const nextStep = getFinanceNextStep(object, effectiveBusinessNow);
  const showRegistry = isRegistryPage;
  const showSelectedDetail = !showRegistry;
  const commandObjects = siblingObjects.length > 0 ? siblingObjects : [object];
  const commandObjectById = new Map(commandObjects.map((item) => [item.id, item]));
  const financeSortMode = displayOrderModeForSection(resolvedSection);
  const commandItems = getFinanceCommandItems(
    commandObjects,
    financeSortMode,
    effectiveBusinessNow,
  );
  const sectionCommandItems = commandItems.filter((item) =>
    financeItemMatchesSection(item, resolvedSection, commandObjectById.get(item.id)),
  );
  const sectionObjectIds = new Set(sectionCommandItems.map((item) => item.id));
  const sectionObjects = commandObjects.filter((item) => sectionObjectIds.has(item.id));
  const registryScheduleEvents = getFinanceCalendarEvents(sectionObjects, effectiveBusinessNow);
  const registryPaymentConditions = getFinancePaymentConditions(
    sectionObjects,
    effectiveBusinessNow,
  );
  const registryCalendarMonthKey = registryScheduleEvents.find((event) => event.monthKey)?.monthKey;
  const selectedCommand =
    sectionCommandItems.find((item) => item.id === object.id) ??
    getFinanceCommandItem(object, effectiveBusinessNow);
  const detailCommandItems = sectionCommandItems.some((item) => item.id === selectedCommand.id)
    ? sectionCommandItems
    : [selectedCommand];
  const selectedCommandIndex = Math.max(
    0,
    detailCommandItems.findIndex((item) => item.id === selectedCommand.id),
  );
  const previousCommand =
    selectedCommandIndex > 0 ? detailCommandItems[selectedCommandIndex - 1] : undefined;
  const nextCommand =
    selectedCommandIndex < detailCommandItems.length - 1
      ? detailCommandItems[selectedCommandIndex + 1]
      : undefined;
  const selectedDisplay = financeDisplayContractFromObject(object, effectiveBusinessNow);
  const orderScheduleEvents = useMemo(
    () => getFinanceCalendarEvents([object], effectiveBusinessNow),
    [effectiveBusinessNow, object],
  );
  const orderPaymentConditions = useMemo(
    () => getFinancePaymentConditions([object], effectiveBusinessNow),
    [effectiveBusinessNow, object],
  );
  const [historyLoad, setHistoryLoad] = useState<{
    orderId: string;
    status: 'idle' | 'loading' | 'ready' | 'error';
    entries: WorkObject['audit'];
  }>(() => ({ orderId: object.id, status: 'idle', entries: object.audit }));
  const [paymentHistoryOpen, setPaymentHistoryOpen] = useState(false);
  const contextualHistory = useMemo(
    () =>
      projectFinanceContextHistory(
        historyLoad.orderId === object.id ? historyLoad.entries : object.audit,
      ),
    [historyLoad.entries, historyLoad.orderId, object.audit, object.id],
  );
  const paymentHistory = useMemo(
    () => financePaymentHistory({ ...object, audit: contextualHistory }),
    [
      contextualHistory,
      object,
      object.financePaymentCorrections,
      object.financePaymentTimeline,
      object.paymentOperations,
    ],
  );
  const detailCalendarDay =
    orderScheduleEvents.find((event) => event.kind !== 'paid' && event.day)?.day ??
    orderScheduleEvents.find((event) => event.day)?.day;
  const detailCalendarMonthKey =
    orderScheduleEvents.find((event) => event.kind !== 'paid' && event.monthKey)?.monthKey ??
    orderScheduleEvents.find((event) => event.monthKey)?.monthKey;
  const [calendarDay, setCalendarDay] = useState<number | undefined>(detailCalendarDay);
  const [registryCalendarDay, setRegistryCalendarDay] = useState<number | undefined>();
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryFilter, setRegistryFilter] = useState<FinanceRegistryFilter>('all');
  const [registrySort, setRegistrySort] = useState<FinanceRegistrySort>('priority');
  const [registryPage, setRegistryPage] = useState(1);
  const [paymentCorrectionTarget, setPaymentCorrectionTarget] =
    useState<FinanceCorrectablePayment | null>(null);
  const [paymentCorrectionBusy, setPaymentCorrectionBusy] = useState(false);
  const registryPageSize = 7;
  const correctablePayments = object.correctablePayments ?? [];
  const registryItems = useMemo(() => {
    const searchValue = registrySearch.trim().toLowerCase();
    return sectionCommandItems
      .filter((item) => financeItemMatchesRegistryFilter(item, registryFilter))
      .filter((item) => {
        if (!searchValue) return true;
        return [
          item.orderNumber,
          item.customer,
          item.invoiceLabel,
          item.paymentLabel,
          item.paymentShipmentLabel,
          item.remaining,
          item.dueLabel,
          item.recommendedAction,
        ]
          .join(' ')
          .toLowerCase()
          .includes(searchValue);
      })
      .sort((left, right) => {
        if (registrySort === 'priority') return 0;
        if (registrySort === 'due')
          return (
            financeDueSortValue(left, financeClock.dateIso).localeCompare(
              financeDueSortValue(right, financeClock.dateIso),
            ) || left.priority - right.priority
          );
        if (registrySort === 'amount')
          return (
            financeAmountNumber(right.remaining) - financeAmountNumber(left.remaining) ||
            left.priority - right.priority
          );
        return left.customer.localeCompare(right.customer, 'ru') || left.priority - right.priority;
      });
  }, [
    financeClock.dateIso,
    financeSortMode,
    registryFilter,
    registrySearch,
    registrySort,
    sectionCommandItems,
  ]);
  const registryPageCount = Math.max(1, Math.ceil(registryItems.length / registryPageSize));
  const registryVisibleItems = registryItems.slice(
    (registryPage - 1) * registryPageSize,
    registryPage * registryPageSize,
  );

  const correctPayment = async (
    target: FinancePaymentCorrectionTarget,
    reason: string,
  ): Promise<boolean> => {
    if (!onCorrectPayment || paymentCorrectionBusy) return false;
    setPaymentCorrectionBusy(true);
    try {
      return await onCorrectPayment(target, reason);
    } finally {
      setPaymentCorrectionBusy(false);
    }
  };
  const disabledActions = object.actions.filter((action) => action.level === 'disabled');
  const secondaryActions = nextStep.secondaryActions.filter(
    (action) => action.level !== 'disabled' && !action.id.startsWith('finance-payment-terms:'),
  );
  const counterparty = counterpartyForObject(object);
  const counterpartyLabel =
    factValue(object, 'Заказчик') ?? factValue(object, 'Контрагент') ?? 'Контрагент не указан';
  const orderRows = orderRowsForFinanceObject(object, factValue);
  const primaryContact =
    counterparty?.contacts?.find((contact) => contact.preferred) ?? counterparty?.contacts?.[0];
  const counterpartyTemplatesCount = counterparty
    ? templatesForCounterparty(counterparty.id).length
    : 0;
  const counterpartyHistoryCount = commandItems.filter(
    (item) => item.customer === counterpartyLabel,
  ).length;
  const counterpartyFacts = [
    { label: 'Контрагент', value: counterparty?.legalName ?? counterpartyLabel },
    { label: 'Псевдоним', value: counterparty?.alias ?? '[нужен факт]' },
    {
      label: 'Контактное лицо',
      value: primaryContact ? `${primaryContact.name} · ${primaryContact.role}` : '[нужен факт]',
    },
    { label: 'Телефон', value: primaryContact?.phone ?? '[нужен факт]' },
    {
      label: 'ИНН / КПП',
      value: `${counterparty?.inn ?? '[нужен факт]'} / ${counterparty?.kpp ?? '[нужен факт]'}`,
    },
    { label: 'ОГРН', value: counterparty?.ogrn ?? '[нужен факт]' },
    { label: 'Юр. адрес', value: counterparty?.legalAddress ?? '[нужен факт]' },
    {
      label: 'Условия',
      value: counterparty?.installmentTermsSource ?? factValue(object, 'Вид оплаты') ?? 'по счету',
    },
    { label: 'История заказов', value: `${counterpartyHistoryCount} фин. дел в текущем контуре` },
    {
      label: 'Шаблоны',
      value:
        counterpartyTemplatesCount > 0
          ? `${counterpartyTemplatesCount} активн.`
          : 'нет активных шаблонов',
    },
  ];
  const paymentFacts = [
    { label: 'Оплачено', value: selectedDisplay.amountPaidLabel },
    { label: 'Дата оплаты', value: selectedDisplay.dueDateLabel },
    { label: 'Рассрочка', value: selectedDisplay.installmentLabel },
    ...(factValue(object, 'Старт рассрочки')
      ? [
          {
            label: 'Условие старта',
            value: factValue(object, 'Старт рассрочки') ?? 'Срок не установлен',
          },
        ]
      : []),
  ];
  const problemCopy = primaryProblem ? financeProblemCopy(primaryProblem) : undefined;
  const selectCommand = (objectId: string) => {
    onSelectObject?.(objectId);
  };
  const handleFinanceAction: FinanceActionHandler = (actionId, payload) => {
    if (actionId.startsWith('finance-view-payments:')) {
      setPaymentHistoryOpen(true);
      return;
    }
    onAction?.(actionId, payload);
  };
  const renderPrimaryAction = () =>
    isInvoiceAction(nextStep.primaryAction) ? (
      <FinanceInvoiceSyncAction
        action={nextStep.primaryAction}
        object={object}
        onCreated={onFinanceObjectUpdated}
      />
    ) : (
      <FinanceActionButton
        action={nextStep.primaryAction}
        prominent
        onAction={handleFinanceAction}
      />
    );
  const handleLedgerKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, objectId: string) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectCommand(objectId);
  };

  useEffect(() => {
    setCalendarDay(detailCalendarDay);
  }, [detailCalendarDay, object.id]);

  useEffect(() => {
    setPaymentHistoryOpen(false);
  }, [object.id]);

  useEffect(() => {
    if (!showSelectedDetail) {
      setHistoryLoad({ orderId: object.id, status: 'idle', entries: [] });
      return;
    }
    if (object.audit.length > 0) {
      setHistoryLoad({ orderId: object.id, status: 'ready', entries: object.audit });
      return;
    }
    const controller = new AbortController();
    setHistoryLoad({ orderId: object.id, status: 'loading', entries: [] });
    void fetchFinanceOrderHistory(object.id, { signal: controller.signal })
      .then((entries) => {
        if (!controller.signal.aborted) {
          setHistoryLoad({ orderId: object.id, status: 'ready', entries });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHistoryLoad({ orderId: object.id, status: 'error', entries: [] });
        }
      });
    return () => controller.abort();
  }, [object.audit, object.id, showSelectedDetail]);

  useEffect(() => {
    setRegistryPage(1);
  }, [resolvedSection, registryFilter, registrySearch, registrySort]);

  useEffect(() => {
    setRegistryPage((current) => Math.min(current, registryPageCount));
  }, [registryPageCount]);

  return (
    <section
      className="surface finance-workbench finance-action-surface severity-info"
      data-object-severity={object.severity}
      aria-label="Рабочая поверхность бухгалтерии"
    >
      <div className="finance-command-header" aria-label="Финансовый контур">
        <div>
          <span className="eyebrow">Бухгалтерия</span>
          <h3>{resolvedSection}</h3>
        </div>
      </div>

      {showSelectedDetail && (
        <nav
          className={`finance-record-nav ${onBackToRegistry ? 'has-back' : ''}`.trim()}
          aria-label="Навигация выбранного финансового дела"
        >
          {onBackToRegistry && (
            <button className="finance-record-back" type="button" onClick={onBackToRegistry}>
              <SiemensIcon name="chevron-left-small" size="16" />
              <span>{financeRegistryBackLabel(resolvedSection)}</span>
            </button>
          )}
          <span className="finance-record-current">
            <small>Открыто дело</small>
            <strong>{selectedCommand.orderNumber}</strong>
          </span>
          <div className="finance-record-stepper" aria-label="Перейти к соседнему финансовому делу">
            <button
              type="button"
              disabled={!previousCommand}
              onClick={() => previousCommand && selectCommand(previousCommand.id)}
              aria-label={
                previousCommand
                  ? `Предыдущее дело: ${previousCommand.orderNumber}`
                  : 'Предыдущее дело недоступно'
              }
              title={
                previousCommand
                  ? `Предыдущее дело: ${previousCommand.orderNumber}`
                  : 'Это первое дело в текущем списке'
              }
            >
              <SiemensIcon name="chevron-left-small" size="16" />
              <span>Пред.</span>
            </button>
            <span>
              {selectedCommandIndex + 1}/{detailCommandItems.length}
            </span>
            <button
              type="button"
              disabled={!nextCommand}
              onClick={() => nextCommand && selectCommand(nextCommand.id)}
              aria-label={
                nextCommand
                  ? `Следующее дело: ${nextCommand.orderNumber}`
                  : 'Следующее дело недоступно'
              }
              title={
                nextCommand
                  ? `Следующее дело: ${nextCommand.orderNumber}`
                  : 'Это последнее дело в текущем списке'
              }
            >
              <span>След.</span>
              <SiemensIcon name="chevron-right-small" size="16" />
            </button>
          </div>
        </nav>
      )}

      <div
        className={`finance-command-grid is-section-detail ${isRegistryPage ? 'is-registry-page' : ''}`.trim()}
      >
        {showRegistry && (
          <FinancePaymentCalendar
            events={registryScheduleEvents}
            conditions={registryPaymentConditions}
            initialMonthKey={registryCalendarMonthKey}
            now={effectiveBusinessNow}
            onSelectDay={setRegistryCalendarDay}
            selectedDay={registryCalendarDay}
            onSelectEvent={selectCommand}
          />
        )}

        {showRegistry && (
          <section
            className="finance-command-ledger finance-registry-table"
            aria-label="Финансовые дела заказов"
          >
            <div className="finance-panel-heading">
              <h4>Реестр: {resolvedSection}</h4>
              <span>
                {registryItems.length} из {sectionCommandItems.length}
              </span>
            </div>
            <div className="finance-registry-toolbar" aria-label="Фильтры реестра финансовых дел">
              <label className="finance-registry-search">
                <span>Поиск</span>
                <input
                  type="search"
                  value={registrySearch}
                  onChange={(event) => setRegistrySearch(event.target.value)}
                  placeholder="Заказ, контрагент или счёт"
                />
              </label>
              <div
                className="finance-registry-filter-row"
                role="tablist"
                aria-label="Тип строк реестра"
              >
                {(Object.keys(financeRegistryFilterLabels) as FinanceRegistryFilter[]).map(
                  (filter) => (
                    <button
                      key={filter}
                      type="button"
                      className={registryFilter === filter ? 'is-active' : ''}
                      onClick={() => setRegistryFilter(filter)}
                      aria-pressed={registryFilter === filter}
                    >
                      {financeRegistryFilterLabels[filter]}
                    </button>
                  ),
                )}
              </div>
              <label className="finance-registry-sort">
                <span>Сортировка</span>
                <select
                  value={registrySort}
                  onChange={(event) => setRegistrySort(event.target.value as FinanceRegistrySort)}
                >
                  <option value="priority">Приоритет</option>
                  <option value="due">Срок</option>
                  <option value="amount">Остаток</option>
                  <option value="customer">Заказчик</option>
                </select>
              </label>
            </div>
            <div className="finance-ledger-table-wrap">
              <table className="finance-ledger-table">
                <thead>
                  <tr>
                    <th>Счёт / заказ</th>
                    <th>Контрагент</th>
                    <th>Выставлен</th>
                    <th>Срок</th>
                    <th>Сумма</th>
                    <th>Оплачено</th>
                    <th>Остаток</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {registryVisibleItems.map((item) => {
                    const rowObject = commandObjectById.get(item.id);
                    const rowDisplay = rowObject
                      ? financeDisplayContractFromObject(rowObject, effectiveBusinessNow)
                      : null;
                    const rowInvoiceNumber = rowObject
                      ? invoiceNumberForObject(rowObject, factValue)
                      : 'Счёт не выставлен';
                    return (
                      <tr
                        key={item.id}
                        className={`finance-ledger-row severity-${item.severity} ${item.id === object.id ? 'is-selected' : ''}`.trim()}
                        data-object-id={item.id}
                        role="button"
                        tabIndex={0}
                        aria-label={`Открыть счёт по заказу ${item.orderNumber}: ${item.customer}`}
                        onClick={() => selectCommand(item.id)}
                        onKeyDown={(event) => handleLedgerKeyDown(event, item.id)}
                      >
                        <td data-label="Счёт / заказ">
                          <div className="finance-ledger-object">
                            <strong>{rowInvoiceNumber}</strong>
                            <small>{item.orderNumber}</small>
                          </div>
                        </td>
                        <td data-label="Контрагент">{item.customer}</td>
                        <td data-label="Выставлен">
                          {rowObject
                            ? (factValue(rowObject, 'Дата выставления') ?? 'Не выставлен')
                            : 'Нет данных'}
                        </td>
                        <td data-label="Срок">{item.dueLabel || 'Срок не установлен'}</td>
                        <td data-label="Сумма">{item.amount}</td>
                        <td data-label="Оплачено">{rowDisplay?.amountPaidLabel ?? 'Нет данных'}</td>
                        <td data-label="Остаток">{item.remaining}</td>
                        <td data-label="Статус">
                          <span className="finance-ledger-status">{item.paymentLabel}</span>
                          {rowObject?.paymentSchedules?.length ? <small>Рассрочка</small> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="finance-registry-pagination" aria-label="Пагинация реестра">
              <span>
                {registryVisibleItems.length > 0
                  ? `${(registryPage - 1) * registryPageSize + 1}-${(registryPage - 1) * registryPageSize + registryVisibleItems.length}`
                  : '0'}{' '}
                из {registryItems.length}
              </span>
              <div>
                <button
                  type="button"
                  disabled={registryPage <= 1}
                  onClick={() => setRegistryPage((current) => Math.max(1, current - 1))}
                >
                  <SiemensIcon name="chevron-left-small" size="16" />
                  <span>Назад</span>
                </button>
                <strong>
                  {registryPage}/{registryPageCount}
                </strong>
                <button
                  type="button"
                  disabled={registryPage >= registryPageCount}
                  onClick={() =>
                    setRegistryPage((current) => Math.min(registryPageCount, current + 1))
                  }
                >
                  <span>Вперед</span>
                  <SiemensIcon name="chevron-right-small" size="16" />
                </button>
              </div>
            </div>
          </section>
        )}

        {showSelectedDetail && (
          <>
            <main className="finance-main finance-selected-command">
              <section
                className={`finance-now-block finance-primary-action-panel finance-action-brief severity-${object.severity}`}
                aria-label="Действие сейчас"
              >
                <div className="finance-brief-copy">
                  <span className="finance-action-eyebrow">Действие</span>
                  <h4>{nextStep.now}</h4>
                </div>
                <div className="finance-command-stack" aria-label="Действия по финансовому объекту">
                  {renderPrimaryAction()}
                  {secondaryActions.length > 0 && (
                    <details className="finance-secondary-toolbar" aria-label="Связанные действия">
                      <summary>Дополнительно</summary>
                      <div>
                        {secondaryActions.map((action) =>
                          action.id.startsWith('finance-distribute-payment:') ? (
                            <FinanceOperationAmountAction
                              key={action.id}
                              action={action}
                              onAction={handleFinanceAction}
                            />
                          ) : (
                            <FinanceActionButton
                              key={action.id}
                              action={action}
                              onAction={handleFinanceAction}
                            />
                          ),
                        )}
                      </div>
                    </details>
                  )}
                  {disabledActions.length > 0 && (
                    <div className="finance-disabled-actions" aria-label="Недоступные действия">
                      {disabledActions.map((action) => (
                        <div key={action.id} className="finance-disabled-action">
                          <strong>{action.label}</strong>
                          <span>{action.disabledReason}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {object.warehouseCoverageWorkflowVersion === 2 && (
                <FinanceWarehouseCoverage
                  key={`coverage:${object.id}`}
                  financeOrderId={object.id}
                  refreshGeneration={coverageRefreshGeneration}
                />
              )}

              {correctablePayments.length > 0 && (
                <section
                  className="finance-panel finance-payment-correction-panel"
                  aria-label="Корректировки оплаты"
                >
                  <div className="finance-panel-heading">
                    <div>
                      <span>Исправление ошибочного действия</span>
                      <h4>Подтверждения оплаты</h4>
                    </div>
                  </div>
                  <ul>
                    {correctablePayments.map((payment) => (
                      <li key={`${payment.target.kind}:${payment.target.id}`}>
                        <div>
                          <strong>{payment.label.replace(/1[СC]/gu, 'учётная система')}</strong>
                          <small>
                            {payment.amount ? `${payment.amount} ₽` : 'сумма не указана'} ·{' '}
                            {payment.source === '1C' ? 'учётный источник' : 'внесено в платформе'}
                          </small>
                        </div>
                        {payment.source === '1C' ? (
                          <p>Отмените проведение в учётной системе и обновите источник.</p>
                        ) : payment.canCorrect ? (
                          <button
                            type="button"
                            disabled={paymentCorrectionBusy || !onCorrectPayment}
                            onClick={() => setPaymentCorrectionTarget(payment)}
                          >
                            Отменить подтверждение
                          </button>
                        ) : (
                          <p>{payment.blockedReason ?? 'Корректировка недоступна.'}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {primaryProblem && problemCopy && (
                <section className="finance-panel finance-problem-panel">
                  <h4>Проблема</h4>
                  <div className={`finance-inline-problem severity-${primaryProblem.severity}`}>
                    <strong>{problemCopy.title}</strong>
                    <span>{problemCopy.reason}</span>
                    <small>{problemCopy.recovery}</small>
                  </div>
                </section>
              )}

              <FinanceInstallmentSchedule object={object} />

              <FinanceInstallmentControl
                key={object.id}
                object={object}
                onSaved={onFinanceObjectUpdated}
              />

              <FinancePaymentCalendar
                events={orderScheduleEvents}
                conditions={orderPaymentConditions}
                initialMonthKey={detailCalendarMonthKey}
                now={effectiveBusinessNow}
                onSelectDay={setCalendarDay}
                selectedDay={calendarDay}
                selectedObjectId={object.id}
                title="График платежей"
                subtitle={`выплаты по ${selectedCommand.orderNumber}`}
                agendaTitle="Платежи дня"
              />
            </main>

            <aside className="finance-evidence-column" aria-label="Сведения выбранного счёта">
              <section className="finance-panel finance-rail-panel">
                <h4>Счет и сумма</h4>
                <FactList
                  facts={[
                    { label: 'Статус счета', value: selectedCommand.invoiceLabel },
                    { label: 'Сумма', value: selectedCommand.amount },
                    { label: 'Остаток', value: selectedCommand.remaining },
                  ]}
                />
              </section>

              <section className="finance-panel finance-rail-panel">
                <h4>Оплата и рассрочка</h4>
                <FactList facts={paymentFacts} />
              </section>
            </aside>

            <section className="finance-panel finance-order-table-panel">
              <div className="finance-panel-heading">
                <h4>Состав заказа</h4>
                <span>Видов: {orderRows.length}</span>
              </div>
              <div className="finance-order-table-wrap">
                <table className="finance-order-table">
                  <thead>
                    <tr>
                      <th>Вид</th>
                      <th>Плёнка и толщина</th>
                      <th>Количество / вес</th>
                      <th>Втулка</th>
                      <th>Бирка / цвет</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((row) => (
                      <tr key={`${row.group}-${row.film}-${row.mark}`}>
                        <td data-label="Вид">{row.group}</td>
                        <td data-label="Плёнка и толщина">{row.film}</td>
                        <td data-label="Количество / вес">{row.rolls}</td>
                        <td data-label="Втулка">{row.sleeve}</td>
                        <td data-label="Бирка / цвет">{row.mark}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <details className="finance-panel finance-collapsed-panel finance-counterparty-panel">
              <summary>
                <span>Реквизиты</span>
                <strong>{counterparty?.source === 'mock_1C' ? 'карточка' : 'сверить'}</strong>
              </summary>
              <div className="finance-counterparty-contact-strip" aria-label="Контакт контрагента">
                <div>
                  <span>Контактное лицо</span>
                  <strong>{primaryContact?.name ?? '[нужен факт]'}</strong>
                  <small>{primaryContact?.role ?? 'роль требует сверки'}</small>
                </div>
                <div>
                  <span>Телефон</span>
                  {primaryContact?.phone ? (
                    <a href={`tel:${primaryContact.phone.replace(/[\s()-]/g, '')}`}>
                      {primaryContact.phone}
                    </a>
                  ) : (
                    <strong>[нужен факт]</strong>
                  )}
                </div>
                <div>
                  <span>История / шаблоны</span>
                  <strong>
                    {counterpartyHistoryCount} дел · {counterpartyTemplatesCount} шабл.
                  </strong>
                </div>
              </div>
              <FactList facts={counterpartyFacts} />
            </details>

            <details
              className="finance-panel finance-collapsed-panel finance-payment-history-panel"
              open={paymentHistoryOpen}
              onToggle={(event) => setPaymentHistoryOpen(event.currentTarget.open)}
            >
              <summary>
                <span>История выплат</span>
                <strong>
                  {paymentHistory.length > 0 ? `${paymentHistory.length} зап.` : 'нет выплат'}
                </strong>
              </summary>
              {paymentHistory.length > 0 ? (
                <ol className="finance-payment-history-list" aria-label="История выплат заказа">
                  {paymentHistory.map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <strong>{entry.label}</strong>
                        {entry.source && <small>{entry.source}</small>}
                      </div>
                      <div>
                        {entry.amountLabel && <strong>{entry.amountLabel}</strong>}
                        {entry.dateLabel && <small>{entry.dateLabel}</small>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="finance-calendar-empty-day">
                  <strong>Выплат пока не было</strong>
                  <span>Записи появятся после проверки оплаты или разнесения выплат.</span>
                </div>
              )}
            </details>
          </>
        )}
      </div>
      {paymentCorrectionTarget && (
        <FinancePaymentCorrectionDialog
          target={paymentCorrectionTarget}
          busy={paymentCorrectionBusy}
          onClose={() => setPaymentCorrectionTarget(null)}
          onConfirm={(reason) => correctPayment(paymentCorrectionTarget.target, reason)}
        />
      )}
    </section>
  );
}
