import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { IxEmptyState, IxMessageBar, IxPill } from '@siemens/ix-react';

import { isLiveContour } from '../../api/liveContours';
import {
  canReorderStatus,
  factValue,
  intakePositionMissingFields,
  type IntakeDraftPosition,
} from '../../domain/prototypeRuntime';
import { businessSourceLabel } from '../../domain/displayContracts';
import {
  activeVersionForTemplate,
  counterparties,
  counterpartyForObject,
  resolveOrderTemplateForObject,
  sortedTemplates,
  templateDisplayModel,
  templateDiffsForObject,
  templateNameFromFields,
  templateNameFromPositions,
  templatesForCounterparty,
} from '../../domain/templates';
import type { TemplateSortMode } from '../../domain/templates';
import type { BigBagWeightDraft, OperatorRuntimeState } from '../../domain/operatorRuntime';
import type {
  Counterparty,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateField,
  CounterpartyOrderTemplateVersion,
  Fact,
  FinancePaymentCorrectionTarget,
  Role,
  RoleAssignmentDraft,
  RoleTemplate,
  UserAccessEntry,
  WarehouseCoverFreeRoll,
  WarehouseCoverTask,
  WarehouseStockMutationDraft,
  WorkListItem,
  WorkObject,
} from '../../domain/types';
import { ActionPanel } from './ActionPanel';
import type { OfficeActionOutcome } from './OfficeCommandBar';
import {
  ActionFirstSummary,
  FactList,
  InlineContextPanel,
  SeverityPill,
  StepIllustration,
  evidenceItems,
  factHelpText,
  largeActionVariant,
} from './viewPrimitives';
import { Workbench } from '../workbenches/floorWorkbenches';
import {
  CommercialIntakeWorkbench,
  FinanceWorkbench,
  ProductionOrderWorkbench,
} from '../workbenches/officeWorkbenches';
import { RawMaterialUsageModule } from '../workbenches/RawMaterialUsageModule';
import { SharedBigBagRegister } from '../../features/raw-materials/SharedBigBagRegister';
import { SpoolStockSummary } from '../../features/warehouse/SpoolStockSummary';
import { FinanceRawMaterialsSurface } from '../workbenches/FinanceRawMaterialsSurface';
import {
  TemplateDirectoryModeTabs,
  type TemplateDirectoryMode,
} from '../workbenches/StockProductionTemplateDirectory';
import {
  WarehouseInventoryDashboard,
  type WarehouseMaterialRecipeCatalog,
  type WarehouseRawMaterialAdjustmentInput,
  type WarehouseRawMaterialReceiptInput,
} from '../workbenches/WarehouseInventoryDashboard';
import { WarehouseStockWorkspace } from '../workbenches/WarehouseStockWorkspace';
import type { WarehouseBigBagCreateCommand } from '../workbenches/WarehouseBigBagCreateModal';
import { shouldShowInlineContextPanel } from './detailContextVisibility';
import { isWarehouseStockSection } from '../../domain/warehouseSections';
import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import type { MaterialRecipeCatalogStatus } from '../../features/recipes/useMaterialRecipeCatalog';
import { isCommercialMaterialSelectionAvailable } from '../../domain/materialRecipeCatalog';
import { IntakePositionsEditor } from './IntakePositionsEditor';

export type TemplateEditorMode = 'add' | 'edit' | 'duplicate';

export type TemplateEditorState = {
  mode: TemplateEditorMode;
  counterpartyId: string;
  templateId?: string;
  sourceTemplateName?: string;
  name: string;
  ownerRole: string;
  reason: string;
  positions: IntakeDraftPosition[];
};

function rowHelp(item: WorkListItem) {
  if (item.queueBucket === 'completed' || item.queueBucket === 'archived') {
    return `${item.title}. Завершено: ${item.archiveReason ?? item.statusLabel}. Закрыто: ${item.completedAt ?? item.lastEventAt}. Только просмотр и история.`;
  }
  if (item.kind === 'operatorTask' && item.operatorCard) {
    return `${item.operatorCard.customerAlias}. ${item.operatorCard.templateName}. ${item.operatorCard.progressLabel}. Текущий шаг: ${item.operatorCard.stepLabel}.`;
  }
  if (item.kind === 'adminEntity') return `${item.title}. Статус: ${item.statusLabel}.`;
  if (item.orderStage) {
    return `${item.title}. Этап заказа: ${item.orderStage.label}. ${item.orderStage.detail}. Кто дальше: ${item.nextOwner}. Последнее событие: ${item.lastEventAt}.`;
  }
  return `${item.title}. Статус: ${item.statusLabel}. Кто дальше: ${item.nextOwner}. Последнее событие: ${item.lastEventAt}.`;
}

function textKey(value: string | undefined | null) {
  return (value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .replace(/[.:;,\u00a0]/g, '')
    .trim();
}

function isSameText(left: string | undefined | null, right: string | undefined | null) {
  const leftKey = textKey(left);
  const rightKey = textKey(right);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function isStandaloneZero(value: string | undefined | null) {
  return textKey(value) === '0';
}

function uniqueFacts(facts: Fact[], hiddenValues: string[] = []) {
  const seen = new Set(hiddenValues.map(textKey).filter(Boolean));

  return facts.filter((fact) => {
    if (isStandaloneZero(fact.value)) return false;
    const valueKey = textKey(fact.value);
    const combinedKey = textKey(`${fact.label} ${fact.value}`);
    const alreadyVisible = Array.from(seen).some(
      (key) =>
        key === valueKey || key === combinedKey || key.includes(valueKey) || valueKey.includes(key),
    );
    if (!valueKey || alreadyVisible) return false;
    seen.add(valueKey);
    seen.add(combinedKey);
    return true;
  });
}

function listFacts(item: WorkListItem, role: Role) {
  if (role === 'admin')
    return uniqueFacts(item.roleFields, [item.title, item.summary, item.statusLabel]).slice(0, 4);
  return uniqueFacts(item.roleFields, [item.title, item.summary, item.statusLabel])
    .filter((fact) => fact.scope !== 'legal' && fact.scope !== 'rawDiagnostics')
    .filter(
      (fact) =>
        ![
          'Контрагент',
          'Тип контрагента',
          'ИНН',
          'КПП',
          'ОГРН',
          'Юр. адрес',
          'Источник реквизитов',
        ].includes(fact.label),
    )
    .slice(0, 2);
}

function listMeta(role: Role, item: WorkListItem, visibleFacts: Fact[]) {
  if (item.queueBucket === 'completed' || item.queueBucket === 'archived') {
    return [
      `Архив: ${item.archiveReason ?? item.statusLabel.toLowerCase()}`,
      `Закрыто: ${item.completedAt ?? item.lastEventAt}`,
    ];
  }
  if (role === 'admin')
    return [item.statusLabel].filter(
      (value) => !visibleFacts.some((fact) => isSameText(value, fact.value)),
    );
  const factValues = visibleFacts.map((fact) => fact.value);
  const values =
    role === 'commercial' && item.orderStage
      ? [item.lastEventAt]
      : [item.statusLabel, item.nextOwner, item.lastEventAt];
  return values.filter((value) => {
    if (isStandaloneZero(value)) return false;
    if (isSameText(value, item.summary)) return false;
    return !factValues.some((factValue) => isSameText(value, factValue));
  });
}

function factMap(item: WorkListItem, object?: WorkObject) {
  const sourceFacts = object
    ? [...object.facts, ...object.sections.flatMap((section) => section.facts)]
    : item.roleFields;
  return new Map(sourceFacts.map((fact) => [fact.label, fact.value]));
}

function financeQueueProjection(item: WorkListItem, activeSection = 'Счета', object?: WorkObject) {
  const facts = factMap(item, object);
  const order = facts.get('Номер') ?? item.title.replace(/^Финансы\s+/, '');
  const customer = facts.get('Заказчик') ?? facts.get('Контрагент') ?? item.summary;
  const amount = facts.get('Сумма') ?? 'нет суммы';
  const paid = facts.get('Оплачено') ?? '0 ₽';
  const remaining = facts.get('Остаток') ?? amount;
  const invoice = facts.get('Статус счета') ?? item.statusLabel;
  const payment = facts.get('Статус оплаты') ?? item.statusLabel;
  const due = facts.get('Дата оплаты') ?? facts.get('Следующий платеж') ?? item.lastEventAt;
  const source = facts.get('Источник данных') ?? item.lastEventAt;
  const schedule = facts.get('График') ?? facts.get('Рассрочка') ?? 'нет графика';
  const problem = item.problemCount > 0 ? `${item.problemCount} проблема` : '';
  const lowerSection = activeSection.toLowerCase();

  if (lowerSection.includes('счет')) {
    return {
      variant: 'invoice',
      title: `${order} · ${customer}`,
      status: invoice,
      primary: invoice.toLowerCase().includes('не') ? 'Счет нужно выставить' : invoice,
      metric: amount,
      evidence: [`Остаток ${remaining}`, `Оплата: ${payment}`],
    };
  }

  if (lowerSection.includes('оплат')) {
    return {
      variant: 'payment',
      title: `${order} · ${customer}`,
      status: payment,
      primary: payment,
      metric: `Остаток ${remaining}`,
      evidence: [`Оплачено ${paid}`, `Счет: ${invoice}`],
    };
  }

  if (lowerSection.includes('рассроч')) {
    return {
      variant: 'installment',
      title: `${order} · ${customer}`,
      status: due,
      primary: due.toLowerCase().includes('сегодня')
        ? `Сегодня платеж ${remaining}`
        : `Платеж: ${due}`,
      metric: remaining,
      evidence: [schedule, `Счет: ${invoice}`],
    };
  }

  if (lowerSection.includes('свер')) {
    return {
      variant: 'source',
      title: `${order} · ${customer}`,
      status: businessSourceLabel(source),
      primary: source.toLowerCase().includes('ошибка')
        ? 'Источник не подтвердил данные'
        : businessSourceLabel(source),
      metric: item.lastEventAt,
      evidence: [`Счет: ${invoice}`, `Оплата: ${payment}`],
    };
  }

  if (lowerSection.includes('исключ')) {
    return {
      variant: 'exception',
      title: `${order} · ${customer}`,
      status: item.statusLabel,
      primary: item.statusLabel.toLowerCase().includes('проср')
        ? `Просрочено · риск ${remaining}`
        : item.summary,
      metric: remaining,
      evidence: [problem || `Источник: ${source}`, `Оплата: ${payment}`],
    };
  }

  if (lowerSection.includes('истор')) {
    return {
      variant: 'history',
      title: `${order} · ${customer}`,
      status: item.lastEventAt,
      primary: `Последнее событие: ${item.summary}`,
      metric: item.lastEventAt,
      evidence: [`Счет: ${invoice}`, `Оплата: ${payment}`],
    };
  }

  return {
    variant:
      item.severity === 'critical'
        ? 'exception'
        : due.toLowerCase().includes('сегодня')
          ? 'installment'
          : invoice.toLowerCase().includes('не')
            ? 'invoice'
            : 'overview',
    title: `${order} · ${customer}`,
    status: item.statusLabel,
    primary: item.statusLabel.toLowerCase().includes('проср')
      ? `Просрочено · риск ${remaining}`
      : due.toLowerCase().includes('сегодня')
        ? `Сегодня платеж ${remaining}`
        : item.summary,
    metric: remaining,
    evidence: [`Счет: ${invoice}`, `Оплата: ${payment}`],
  };
}

function FinanceQueueCard({
  item,
  object,
  selected,
  activeSection,
  reducedMotion,
  onSelect,
}: {
  item: WorkListItem;
  object?: WorkObject;
  selected: boolean;
  activeSection?: string;
  reducedMotion: boolean;
  onSelect: (id: string) => void;
}) {
  const card = financeQueueProjection(item, activeSection, object);
  const isArchived = item.queueBucket === 'completed' || item.queueBucket === 'archived';
  const evidence = isArchived
    ? [
        `Архив: ${item.archiveReason ?? item.statusLabel.toLowerCase()}`,
        `Закрыто: ${item.completedAt ?? item.lastEventAt}`,
      ]
    : card.evidence;
  return (
    <article
      className={`finance-queue-card variant-${card.variant} severity-${item.severity} ${isArchived ? 'is-archived' : ''} ${selected ? 'is-selected' : ''} ${item.newness && !reducedMotion ? 'is-new-animated' : ''}`}
      data-object-id={item.id}
      data-queue-bucket={item.queueBucket}
    >
      <button
        className="finance-queue-card-button"
        type="button"
        onClick={() => onSelect(item.id)}
        title={rowHelp(item)}
      >
        <span className="finance-queue-card-head">
          <strong>{card.title}</strong>
          <span>{isArchived ? 'Завершено' : card.status}</span>
        </span>
        <span className="finance-queue-card-primary">{card.primary}</span>
        <span className="finance-queue-card-metric">{card.metric}</span>
        <span className="finance-queue-card-evidence">
          {evidence
            .filter(Boolean)
            .slice(0, 3)
            .map((value) => (
              <small key={`${item.id}-${value}`}>{value}</small>
            ))}
        </span>
      </button>
    </article>
  );
}

function detailHiddenValues(role: Role, object: WorkObject) {
  const values = [object.title, object.statusLabel, object.nextOwner];
  if (role !== 'operator' && role !== 'warehouse') {
    values.push(...evidenceItems(role, object).map((item) => item.value));
  }
  return values;
}

function stateClass(statusLabel: string) {
  if (
    [
      'Готово',
      'Закрыто',
      'Передано',
      'Передано на склад',
      'Готово к счету',
      'Принято',
      'Выдано',
      'Счет к оплате отправлен',
    ].includes(statusLabel)
  )
    return 'state-done';
  if (
    [
      'Заблокировано',
      'Ошибка QR',
      'Чужой QR',
      'Просрочка',
      'Нет связи',
      'Не привязано',
      'Риск',
    ].includes(statusLabel)
  )
    return 'state-blocked';
  if (
    [
      'Новая',
      'Черновик',
      'Неполный заказ-наряд',
      'Ждет счет',
      'Счет выставлен',
      'Счет отправлен',
      'К оплате',
      'Ждет выдачу',
      'Рассрочка',
      'Ошибка синхронизации',
      'Ошибка источника',
      'Ожидает назначения',
      'Ожидает принятия',
      'Стартовый вес',
      'В работе',
      'Сканировать QR',
      'Ждет передачу',
      'Готово к приемке',
      'Готово к выдаче',
      'Принято частично',
      'Офлайн',
      'Конфликт источника',
      'Требует проверки',
    ].includes(statusLabel)
  )
    return 'state-active';
  return 'state-neutral';
}

function OperatorOrderCardContent({ item }: { item: WorkListItem }) {
  const card = item.operatorCard;
  if (!card) return null;

  const progress = Math.max(0, Math.min(1, card.progressValue));
  const progressPercent = `${Math.round(progress * 100)}%`;

  return (
    <>
      <span className="operator-card-head">
        <span className="operator-card-identity">
          <strong>{card.customerAlias}</strong>
          <span>
            {card.templateName} / {card.filmType}
          </span>
        </span>
        <span className="operator-card-code">{card.orderCode}</span>
      </span>

      <span className="operator-card-params" aria-label="Ключевые параметры заказа">
        <span>
          <strong>{card.micron}</strong>
          <small>толщина</small>
        </span>
        <span>
          <strong>{card.size}</strong>
          <small>размер</small>
        </span>
        <span>
          <strong>{card.kgPerRoll}</strong>
          <small>на рулон</small>
        </span>
      </span>

      <span className="operator-card-progress">
        <span className="operator-progress-line" aria-hidden="true">
          <span style={{ width: progressPercent }} />
        </span>
        <span>{card.progressLabel}</span>
      </span>

      <span className={`operator-card-step ${card.blocker ? 'has-blocker' : ''}`}>
        <span>{card.blocker ?? card.stepLabel}</span>
        <small>{card.blocker ? 'блокер' : 'текущий шаг'}</small>
      </span>

      <span className="operator-card-recipe">{card.recipe}</span>
    </>
  );
}

function OperatorOrdersTable({
  items,
  selectedId,
  emptyText,
  reducedMotion,
  activeSection,
  onSelect,
}: {
  items: WorkListItem[];
  selectedId: string | null;
  emptyText: string;
  reducedMotion: boolean;
  activeSection?: string;
  onSelect: (id: string) => void;
}) {
  if (items.length === 0) {
    return <IxEmptyState header="Очередь пуста" subHeader={emptyText} />;
  }
  const isRollMode = activeSection === 'Мои рулоны';

  return (
    <div
      className={`operator-orders-table is-compact ${isRollMode ? 'is-roll-mode' : ''}`}
      role="table"
      aria-label={isRollMode ? 'Мои рулоны оператора' : 'Мои заказы оператора'}
    >
      <div className="operator-orders-row is-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">{isRollMode ? 'Рулон' : 'Заказ'}</span>
        <span role="columnheader">
          {isRollMode ? 'Параметры рулона' : 'Параметры текущего рулона'}
        </span>
        <span role="columnheader">Шаг</span>
        <span role="columnheader">Действие</span>
      </div>
      {items.map((item, index) => {
        const card = item.operatorCard;
        if (!card) return null;
        const progress = Math.max(0, Math.min(1, card.progressValue));
        const progressPercent = `${Math.round(progress * 100)}%`;
        const isSelected = selectedId === item.id;
        const openOrder = () => onSelect(item.id);
        const handleOrderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openOrder();
        };

        return (
          <div
            key={item.id}
            className={`operator-orders-row severity-${item.severity} ${stateClass(item.statusLabel)} ${isSelected ? 'is-selected' : ''} ${item.newness && !reducedMotion ? 'is-new-animated' : ''} ${card.isMuted ? 'is-muted' : ''}`}
            role="row"
            tabIndex={0}
            title={rowHelp(item)}
            aria-label={
              isRollMode
                ? `Открыть рулон ${item.title} заказа ${card.orderCode}. ${rowHelp(item)}`
                : `Открыть заказ ${card.orderCode}. ${rowHelp(item)}`
            }
            onClick={openOrder}
            onKeyDown={handleOrderKeyDown}
          >
            <span role="cell" data-label="#">
              <strong>#{index + 1}</strong>
            </span>
            <span
              role="cell"
              data-label={isRollMode ? 'Рулон' : 'Заказ'}
              className="operator-orders-main"
            >
              <strong>{isRollMode ? item.title : card.orderCode}</strong>
              <small>
                {[isRollMode ? `Заказ ${card.orderCode}` : card.customerAlias, card.templateName]
                  .filter(Boolean)
                  .join(' · ')}
              </small>
              {card.groupCount > 1 && <em>{card.groupCount} группы</em>}
            </span>
            <span
              role="cell"
              data-label="Параметры текущего рулона"
              className="operator-roll-params-cell"
            >
              <span
                className="operator-roll-facts"
                aria-label={`Параметры: ${card.currentRollLabel}`}
              >
                <span className="roll-fact is-wide">
                  <small>Рулон</small>
                  <strong>{card.currentRollLabel}</strong>
                </span>
                <span className="roll-fact">
                  <small>Толщина</small>
                  <strong>{card.currentRollMicron}</strong>
                </span>
                <span className="roll-fact">
                  <small>План</small>
                  <strong>{card.currentRollPlanKg}</strong>
                </span>
              </span>
            </span>
            <span role="cell" data-label="Шаг" className="operator-orders-step-cell">
              <strong>{card.progressLabel}</strong>
              <span className="operator-orders-progress" aria-hidden="true">
                <span style={{ width: progressPercent }} />
              </span>
              <strong>{card.stepLabel}</strong>
              <small>{card.blocker ?? card.recipe}</small>
            </span>
            <span role="cell" data-label="Действие" className="operator-orders-status-action">
              <SeverityPill severity={item.severity} compact />
              {item.problemCount > 0 && <small>{item.problemCount} проблема</small>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function ObjectList({
  role,
  items,
  selectedId,
  emptyText,
  reducedMotion,
  reorderable = false,
  onReorder,
  onMove,
  onSelect,
  activeSection,
  workObjects,
}: {
  role: Role;
  items: WorkListItem[];
  selectedId: string | null;
  emptyText: string;
  reducedMotion: boolean;
  reorderable?: boolean;
  onReorder?: (sourceId: string, targetId: string) => void;
  onMove?: (id: string, direction: 'up' | 'down') => void;
  onSelect: (id: string) => void;
  activeSection?: string;
  workObjects?: WorkObject[];
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  if (items.length === 0) {
    return <IxEmptyState header="Очередь пуста" subHeader={emptyText} />;
  }

  if (role === 'operator') {
    return (
      <OperatorOrdersTable
        items={items}
        selectedId={selectedId}
        emptyText={emptyText}
        reducedMotion={reducedMotion}
        activeSection={activeSection}
        onSelect={onSelect}
      />
    );
  }

  if (role === 'finance') {
    return (
      <div className="object-list finance-object-list" aria-label="Финансовый список">
        {items.map((item) => (
          <FinanceQueueCard
            key={item.id}
            item={item}
            object={workObjects?.find((object) => object.id === item.id)}
            selected={selectedId === item.id}
            activeSection={activeSection}
            reducedMotion={reducedMotion}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="object-list"
      aria-label={role === 'production' ? 'Согласовать заказ-наряд' : undefined}
    >
      {items.map((item) => {
        const visibleFacts = listFacts(item, role);
        const meta = listMeta(role, item, visibleFacts);
        const canReorder = reorderable && canReorderStatus(item.statusLabel);
        const isSelected = selectedId === item.id;
        return (
          <article
            key={item.id}
            className={`queue-row severity-${item.severity} ${stateClass(item.statusLabel)} ${item.queueBucket === 'completed' || item.queueBucket === 'archived' ? 'is-archived' : ''} ${isSelected ? 'is-selected' : ''} ${item.newness ? 'is-new' : ''} ${item.newness && !reducedMotion ? 'is-new-animated' : ''} ${draggingId === item.id ? 'is-dragging' : ''} ${draggingId && draggingId !== item.id && canReorder ? 'is-drop-target' : ''}`}
            data-object-id={item.id}
            data-queue-bucket={item.queueBucket}
            aria-current={isSelected ? 'true' : undefined}
            draggable={canReorder}
            onDragStart={(event) => {
              if (!canReorder) return;
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
              setDraggingId(item.id);
            }}
            onDragOver={(event) => {
              if (!canReorder || !draggingId || draggingId === item.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              const sourceId = event.dataTransfer.getData('text/plain') || draggingId;
              setDraggingId(null);
              if (!sourceId || sourceId === item.id || !canReorder) return;
              onReorder?.(sourceId, item.id);
            }}
            onDragEnd={() => setDraggingId(null)}
            title={rowHelp(item)}
          >
            <button
              className="queue-row-main"
              onClick={() => onSelect(item.id)}
              type="button"
              title={rowHelp(item)}
            >
              <span className="row-top">
                <span className="row-title-stack">
                  <strong>{item.title}</strong>
                  {item.newness && <span className="newness-pill">Новая</span>}
                </span>
                <span className="row-pill-stack">
                  {item.orderStage && (
                    <span
                      className={`order-stage-pill severity-${item.orderStage.severity}`}
                      title={`Этап заказа: ${item.orderStage.detail}`}
                    >
                      {item.orderStage.label}
                    </span>
                  )}
                  <SeverityPill severity={item.severity} compact />
                </span>
              </span>
              <span className="row-summary">{item.summary}</span>
              {visibleFacts.length > 0 && (
                <span className="row-facts">
                  {visibleFacts.map((fact) => (
                    <span key={`${item.id}-${fact.label}`} title={factHelpText(fact)}>
                      {fact.label}: {fact.value}
                    </span>
                  ))}
                </span>
              )}
              {meta.length > 0 && (
                <span className="row-meta" title={rowHelp(item)} aria-label={rowHelp(item)}>
                  {meta.map((value) => (
                    <span key={`${item.id}-${value}`}>{value}</span>
                  ))}
                </span>
              )}
              {role !== 'admin' && item.problemCount > 0 && (
                <span className="problem-inline" title="Объект имеет открытую проблему.">
                  {item.problemCount} проблема
                </span>
              )}
            </button>
          </article>
        );
      })}
    </div>
  );
}

export function CounterpartyTemplateList({
  counterpartyCatalog = counterparties,
  templates,
  selectedCounterpartyId,
  onSelect,
  query,
  onQueryChange,
  loading = false,
  hasMore = false,
  onLoadMore,
}: {
  counterpartyCatalog?: Counterparty[];
  templates: CounterpartyOrderTemplate[];
  selectedCounterpartyId: string;
  onSelect: (counterpartyId: string) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  loading?: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
}) {
  return (
    <div className="counterparty-list">
      {onQueryChange ? (
        <label className="counterparty-list-search">
          <span>Контрагент</span>
          <input
            type="search"
            aria-label="Поиск контрагентов"
            placeholder="Название контрагента"
            value={query ?? ''}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      ) : null}
      <div className="counterparty-list-items" role="list" aria-label="Контрагенты">
        {counterpartyCatalog.map((counterparty) => {
          const count = templatesForCounterparty(counterparty.id, templates, true).length;
          return (
            <button
              key={counterparty.id}
              className={`counterparty-row ${selectedCounterpartyId === counterparty.id ? 'is-selected' : ''}`}
              type="button"
              onClick={() => onSelect(counterparty.id)}
              title={`${counterparty.legalName}: ${count} шаблонов`}
            >
              <span>
                <strong>{counterparty.legalName}</strong>
                <small>{counterparty.alias}</small>
              </span>
              <IxPill>{count}</IxPill>
            </button>
          );
        })}
        {counterpartyCatalog.length === 0 && !loading ? (
          <IxEmptyState
            header="Контрагенты не найдены"
            subHeader="Уточните название или проверьте доступную производству выборку."
          />
        ) : null}
        {counterpartyCatalog.length === 0 && loading ? (
          <span className="counterparty-list-loading" role="status">
            Загружаем контрагентов…
          </span>
        ) : null}
      </div>
      {hasMore && onLoadMore ? (
        <button
          type="button"
          className="counterparty-list-more"
          disabled={loading}
          onClick={onLoadMore}
        >
          {loading ? 'Загружаем…' : 'Показать ещё'}
        </button>
      ) : null}
    </div>
  );
}

export function TemplateDirectorySurface({
  counterpartyCatalog = counterparties,
  selectedCounterpartyId,
  templates,
  versions,
  query,
  sortMode,
  editor,
  onQueryChange,
  onSortChange,
  onOpenEditor,
  onArchive,
  onActivate,
  onEditorChange,
  onSafeFieldChange,
  onSave,
  onCancelEdit,
  mode,
  onModeChange,
  allowLifecycleActions = true,
  allowEditingActions = true,
  allowOwnerRoleEdit = true,
  requireVersionReason = true,
  materials = [],
  recipes = [],
  materialCatalogStatus = 'idle',
  materialCatalogError = null,
  onRetryMaterialCatalog = () => undefined,
}: {
  counterpartyCatalog?: Counterparty[];
  selectedCounterpartyId: string;
  templates: CounterpartyOrderTemplate[];
  versions: CounterpartyOrderTemplateVersion[];
  query: string;
  sortMode: TemplateSortMode;
  editor: TemplateEditorState | null;
  onQueryChange: (query: string) => void;
  onSortChange: (sortMode: TemplateSortMode) => void;
  onOpenEditor: (mode: TemplateEditorMode, templateId?: string) => void;
  onArchive: (templateId: string) => void;
  onActivate: (templateId: string) => void;
  onEditorChange: (editor: TemplateEditorState | null) => void;
  onSafeFieldChange: (key: 'name' | 'ownerRole', value: string) => void;
  onSave: () => void;
  onCancelEdit: () => void;
  mode: TemplateDirectoryMode;
  onModeChange: (mode: TemplateDirectoryMode) => void;
  allowLifecycleActions?: boolean;
  allowEditingActions?: boolean;
  allowOwnerRoleEdit?: boolean;
  requireVersionReason?: boolean;
  materials?: readonly RawMaterialCatalogItem[];
  recipes?: readonly RecipeCatalogItem[];
  materialCatalogStatus?: MaterialRecipeCatalogStatus;
  materialCatalogError?: string | null;
  onRetryMaterialCatalog?: () => void;
}) {
  const counterparty =
    counterpartyCatalog.find((item) => item.id === selectedCounterpartyId) ??
    counterpartyCatalog[0];
  if (!counterparty) {
    return (
      <article className="template-directory-view">
        <TemplateDirectoryModeTabs mode={mode} onChange={onModeChange} />
        <IxEmptyState
          header="Контрагенты не найдены"
          subHeader={
            allowEditingActions
              ? 'Добавить клиентский шаблон можно после появления доступного контрагента.'
              : 'В доступной производству выборке пока нет клиентов.'
          }
        />
      </article>
    );
  }
  const filteredTemplates = sortedTemplates(
    templatesForCounterparty(counterparty.id, templates, true),
    sortMode,
    query,
    versions,
  );

  return (
    <article className="template-directory-view">
      <TemplateDirectoryModeTabs mode={mode} onChange={onModeChange} />
      <header className="detail-header">
        <div>
          <div className="eyebrow">Зав. производства</div>
          <h2>Контрагенты и шаблоны</h2>
        </div>
        <IxPill>{counterparty.legalName}</IxPill>
      </header>

      {!allowEditingActions ? (
        <div className="production-route-blocked" role="status">
          <strong>Шаблоны доступны для просмотра</strong>
          <p>Создание и изменение временно недоступны. Текущие версии остаются без изменений.</p>
        </div>
      ) : null}

      <section
        className="surface template-directory-toolbar"
        aria-label="Поиск и сортировка шаблонов"
      >
        <div>
          <span className="eyebrow">Шаблоны клиента</span>
          <h3>{counterparty.legalName}</h3>
          <p>{counterparty.visibilityPolicy}</p>
          <p>{counterparty.installmentTermsSource}</p>
        </div>
        <div className="template-directory-controls">
          <label>
            <span>Поиск шаблона</span>
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={
                allowEditingActions
                  ? 'Название, пленка, толщина, сырье, втулка'
                  : 'Название шаблона или число позиций'
              }
            />
          </label>
          <label>
            <span>Сортировка</span>
            <select
              value={sortMode}
              onChange={(event) => onSortChange(event.target.value as TemplateSortMode)}
            >
              <option value="recent">Последние</option>
              <option value="popular">Частые</option>
              <option value="name">По названию</option>
              <option value="updated">По дате изменения</option>
            </select>
          </label>
          {allowEditingActions ? (
            <button
              className="create-intake-button"
              type="button"
              onClick={() => onOpenEditor('add')}
            >
              Добавить шаблон
            </button>
          ) : null}
        </div>
      </section>

      <div
        className={`template-directory-grid ${allowEditingActions ? '' : 'is-read-only'} ${editor ? 'is-editing' : ''}`}
      >
        <section
          className="surface template-card-list"
          aria-label="Список шаблонов выбранного контрагента"
        >
          {filteredTemplates.map((templateItem) => {
            const versionItem = activeVersionForTemplate(templateItem, versions);
            const display = templateDisplayModel(templateItem, versions, counterparty);
            return (
              <article key={templateItem.id} className="template-card">
                <div className="template-card-head">
                  <div>
                    <h3>{display.title}</h3>
                    <p>{display.systemName}</p>
                    <p>
                      {versionItem?.version ?? 'Версия не найдена'} · {templateItem.ownerRole}
                    </p>
                  </div>
                  <IxPill>
                    {templateItem.status === 'active'
                      ? 'Активен'
                      : templateItem.status === 'archived'
                        ? 'В архиве'
                        : 'Черновик'}
                  </IxPill>
                </div>
                <div className="template-name-strip">
                  <span>
                    <strong>Состав</strong>
                    <small>{display.descriptor || 'Параметры не указаны'}</small>
                  </span>
                  <span>
                    <strong>Ручное имя</strong>
                    <small>{display.manualName || 'Не задано, используется системное имя'}</small>
                  </span>
                </div>
                <div className="template-card-metrics">
                  <span>
                    <strong>{templateItem.usageCount}</strong>
                    <small>применений</small>
                  </span>
                  <span>
                    <strong>{templateItem.lastUsedAt}</strong>
                    <small>последний</small>
                  </span>
                  <span>
                    <strong>{templateItem.updatedAt}</strong>
                    <small>изменен</small>
                  </span>
                </div>
                <FactList facts={(versionItem?.fields ?? []).slice(0, 5)} />
                {allowEditingActions ? (
                  <div className="template-card-actions">
                    <button type="button" onClick={() => onOpenEditor('edit', templateItem.id)}>
                      Редактировать
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenEditor('duplicate', templateItem.id)}
                    >
                      Дублировать
                    </button>
                    {allowLifecycleActions ? (
                      <>
                        {templateItem.status !== 'active' ? (
                          <button type="button" onClick={() => onActivate(templateItem.id)}>
                            Сделать активным
                          </button>
                        ) : null}
                        {templateItem.status !== 'archived' ? (
                          <button type="button" onClick={() => onArchive(templateItem.id)}>
                            Архивировать
                          </button>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
          {filteredTemplates.length === 0 && (
            <IxEmptyState
              header="Шаблоны не найдены"
              subHeader="Измените поиск или добавьте шаблон для выбранного контрагента."
            />
          )}
        </section>

        {allowEditingActions ? (
          <TemplateEditorPanel
            editor={editor}
            counterpartyName={counterparty.legalName}
            onEditorChange={onEditorChange}
            onSafeFieldChange={onSafeFieldChange}
            onSave={onSave}
            onCancel={onCancelEdit}
            allowOwnerRoleEdit={allowOwnerRoleEdit}
            requireVersionReason={requireVersionReason}
            materials={materials}
            recipes={recipes}
            materialCatalogStatus={materialCatalogStatus}
            materialCatalogError={materialCatalogError}
            onRetryMaterialCatalog={onRetryMaterialCatalog}
          />
        ) : null}
      </div>
    </article>
  );
}

function TemplateEditorPanel({
  editor,
  counterpartyName,
  onEditorChange,
  onSafeFieldChange,
  onSave,
  onCancel,
  allowOwnerRoleEdit,
  requireVersionReason,
  materials,
  recipes,
  materialCatalogStatus,
  materialCatalogError,
  onRetryMaterialCatalog,
}: {
  editor: TemplateEditorState | null;
  counterpartyName: string;
  onEditorChange: (editor: TemplateEditorState | null) => void;
  onSafeFieldChange: (key: 'name' | 'ownerRole', value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  allowOwnerRoleEdit: boolean;
  requireVersionReason: boolean;
  materials: readonly RawMaterialCatalogItem[];
  recipes: readonly RecipeCatalogItem[];
  materialCatalogStatus: MaterialRecipeCatalogStatus;
  materialCatalogError: string | null;
  onRetryMaterialCatalog: () => void;
}) {
  if (!editor) {
    return (
      <section className="surface template-editor is-idle">
        <span className="eyebrow">Редактор шаблона</span>
        <h3>Выберите действие</h3>
        <p>Добавьте, отредактируйте или продублируйте шаблон выбранного контрагента.</p>
      </section>
    );
  }

  const invalidPositionIndex = editor.positions.findIndex(
    (position) => intakePositionMissingFields(position).length > 0,
  );
  const unavailableMaterialIndex =
    materialCatalogStatus === 'ready'
      ? editor.positions.findIndex(
          (position) =>
            !isCommercialMaterialSelectionAvailable(position, materials, recipes),
        )
      : -1;
  const requiresReason = requireVersionReason && editor.mode === 'edit';
  const generatedName = templateNameFromPositions(editor.positions);
  const previewName = editor.name.trim() || generatedName || 'Шаблон без названия';
  const saveBlocked =
    editor.positions.length === 0 ||
    editor.positions.length > 100 ||
    invalidPositionIndex >= 0 ||
    materialCatalogStatus !== 'ready' ||
    unavailableMaterialIndex >= 0 ||
    !generatedName ||
    (requiresReason && editor.reason.trim().length === 0);
  const title =
    editor.mode === 'add'
      ? 'Новый шаблон'
      : editor.mode === 'duplicate'
        ? 'Копия шаблона'
        : 'Редактирование шаблона';

  return (
    <section className="surface template-editor" aria-label="Редактор шаблона">
      <div className="template-editor-head">
        <div>
          <span className="eyebrow">{counterpartyName}</span>
          <h3>{title}</h3>
        </div>
        <IxPill>{editor.mode === 'edit' ? 'Версия' : 'Черновик ввода'}</IxPill>
      </div>

      <div className="template-edit-form">
        <label className="template-edit-form-wide">
          <span>Ручное имя</span>
          <input
            maxLength={200}
            value={editor.name}
            onChange={(event) => onSafeFieldChange('name', event.target.value)}
            placeholder={generatedName || 'Соберется из типа пленки, толщины и цвета'}
          />
          <small>
            Можно оставить пустым. В списке будет использоваться системное имя из полей шаблона.
          </small>
        </label>
        <label>
          <span>Владелец</span>
          <select
            value={editor.ownerRole}
            disabled={!allowOwnerRoleEdit}
            onChange={(event) => onSafeFieldChange('ownerRole', event.target.value)}
          >
            <option value="Зав. производства">Зав. производства</option>
          </select>
        </label>
        <div className="template-name-preview">
          <span>Как будет отображаться</span>
          <strong>{previewName}</strong>
          <small>
            Системное имя: {counterpartyName} ·{' '}
            {generatedName || 'производственные параметры не указаны'}
          </small>
        </div>
        <IntakePositionsEditor
          ariaLabel="Позиции шаблона"
          positions={editor.positions}
          onChange={(positions) => onEditorChange({ ...editor, positions })}
          materials={materials}
          recipes={recipes}
          materialCatalogStatus={materialCatalogStatus}
          materialCatalogError={materialCatalogError}
          onRetryMaterialCatalog={onRetryMaterialCatalog}
        />
        {requiresReason && (
          <label>
            <span>Причина новой версии</span>
            <textarea
              aria-required="true"
              required
              value={editor.reason}
              onChange={(event) => onEditorChange({ ...editor, reason: event.target.value })}
            />
          </label>
        )}
      </div>

      <div className="template-editor-actions">
        <button
          className="compact-action-button"
          type="button"
          disabled={saveBlocked}
          onClick={onSave}
          title="Сохранить шаблон"
        >
          <ix-icon name="save-all" size="16" />
          <span>Сохранить</span>
        </button>
        <button className="compact-action-button action-secondary" type="button" onClick={onCancel}>
          <ix-icon name="close" size="16" />
          <span>Отмена</span>
        </button>
        {materialCatalogStatus !== 'ready' ? (
          <span>Дождитесь загрузки каталога сырья и рецептур.</span>
        ) : invalidPositionIndex >= 0 ? (
          <span>
            Проверьте обязательные поля позиции {invalidPositionIndex + 1}:{' '}
            {intakePositionMissingFields(editor.positions[invalidPositionIndex]).join(', ')}.
          </span>
        ) : unavailableMaterialIndex >= 0 ? (
          <span>Повторно выберите сырьё или рецептуру позиции {unavailableMaterialIndex + 1}.</span>
        ) : null}
      </div>
    </section>
  );
}

export function DetailView({
  role,
  object,
  operatorRuntime,
  selectedTemplateId,
  templateCatalog,
  templateVersions,
  onAction,
  pendingActionId,
  onStockMutation,
  onAdjustRawMaterial,
  onReceiveRawMaterial,
  onCreateBigBag,
  onTemplateSelect,
  actionOutcome,
  onClose,
  siblingObjects = [],
  onSelectObject,
  activeSection,
  displayTitle,
  isFinanceRegistryPage = false,
  onFinanceObjectUpdated,
  onCorrectFinancePayment,
  warehouseCoverTasks = [],
  warehouseCoverFreeRolls = [],
  selectedWarehouseObjectId,
  onWarehouseCoverPropose,
  onWarehouseCoverRefresh,
  onWarehouseOneCStockPush,
  warehouseOneCStockPushBusy = false,
  warehouseMaterialRecipeCatalog,
  effectiveCapabilities,
  rawMaterialRefreshGeneration = 0,
  coverageRefreshGeneration = 0,
}: {
  role: Role;
  object: WorkObject | null;
  operatorRuntime?: OperatorRuntimeState;
  bigBagWeightDraft?: BigBagWeightDraft;
  onBigBagWeightDraftChange?: (draft: BigBagWeightDraft) => void;
  selectedTemplateId?: string;
  templateCatalog: CounterpartyOrderTemplate[];
  templateVersions: CounterpartyOrderTemplateVersion[];
  onAction?: (
    actionId: string,
    payload?: {
      operationAmount?: number;
      operationAmountLabel?: string;
    },
  ) => void;
  pendingActionId?: string | null;
  onStockMutation?: (draft: WarehouseStockMutationDraft) => void;
  onAdjustRawMaterial?: (input: WarehouseRawMaterialAdjustmentInput) => Promise<boolean>;
  onReceiveRawMaterial?: (input: WarehouseRawMaterialReceiptInput) => Promise<boolean>;
  onCreateBigBag?: (input: WarehouseBigBagCreateCommand) => Promise<boolean>;
  onTemplateSelect: (objectId: string, templateId: string) => void;
  onOpenShift?: () => void;
  actionOutcome?: OfficeActionOutcome | null;
  onClose?: () => void;
  siblingObjects?: WorkObject[];
  onSelectObject?: (objectId: string) => void;
  activeSection?: string;
  displayTitle?: string;
  isFinanceRegistryPage?: boolean;
  onFinanceObjectUpdated?: (object: WorkObject) => void;
  onCorrectFinancePayment?: (
    target: FinancePaymentCorrectionTarget,
    reason: string,
  ) => Promise<boolean>;
  warehouseCoverTasks?: WarehouseCoverTask[];
  warehouseCoverFreeRolls?: WarehouseCoverFreeRoll[];
  selectedWarehouseObjectId?: string | null;
  onWarehouseCoverPropose?: (
    orderId: string,
    input: { positionId: string; rollIds: string[]; comment?: string },
  ) => Promise<unknown>;
  onWarehouseCoverRefresh?: () => Promise<unknown> | unknown;
  onWarehouseOneCStockPush?: () => void;
  warehouseOneCStockPushBusy?: boolean;
  warehouseMaterialRecipeCatalog?: WarehouseMaterialRecipeCatalog;
  effectiveCapabilities?: readonly string[];
  rawMaterialRefreshGeneration?: string | number;
  coverageRefreshGeneration?: number;
  rawMaterialHeaderAction?: ReactNode;
}) {
  const isRawMaterialSection = activeSection === 'Сырье' || activeSection === 'Сырьё';
  if (role === 'finance' && isRawMaterialSection && isLiveContour('finance')) {
    return (
      <article className="detail-view role-finance raw-material-detail-view">
        <FinanceRawMaterialsSurface />
      </article>
    );
  }

  const isSharedRawMaterialRegister =
    isRawMaterialSection && ['commercial', 'production', 'director'].includes(role);
  if (isSharedRawMaterialRegister) {
    return (
      <article className={`detail-view role-${role} raw-material-detail-view`}>
        {role === 'production' ? <SpoolStockSummary /> : null}
        <SharedBigBagRegister refreshGeneration={rawMaterialRefreshGeneration} />
      </article>
    );
  }

  if (role === 'director' && isWarehouseStockSection(activeSection ?? '')) {
    return (
      <article className="detail-view role-director warehouse-stock-detail-view">
        <WarehouseStockWorkspace showBatchAgeFilters={false} />
      </article>
    );
  }

  if (!object) {
    return <div className="detail-blank-state" role="status" aria-label="Карточка не выбрана" />;
  }

  const isOfficeWorkbench = role !== 'operator' && role !== 'warehouse';
  const isOperatorWorkbench = role === 'operator';
  const isWarehouseWorkbench = role === 'warehouse' && object.workbench?.type === 'warehouse';
  const isWarehouseInventoryObject = role === 'warehouse' && object.rawMaterialStocks !== undefined;
  const isWarehouseStockLanding =
    isWarehouseInventoryObject &&
    Boolean(activeSection) &&
    isWarehouseStockSection(activeSection ?? '');
  const isWarehouseRawMaterialSection = role === 'warehouse' && isRawMaterialSection;
  const isRawMaterialModule =
    (activeSection === 'Сырье' || activeSection === 'Сырьё') &&
    role !== 'operator' &&
    role !== 'warehouse';
  const isWarehouseGenericWorkbench =
    role === 'warehouse' && !isWarehouseWorkbench && !isWarehouseInventoryObject;
  const hasFocusedWorkbench =
    ['commercial', 'production', 'finance', 'operator', 'admin'].includes(role) ||
    isWarehouseWorkbench ||
    isWarehouseInventoryObject ||
    isRawMaterialModule;
  const hasOfficeCommandBar = false;
  const hasOfficeActionStrip = role === 'commercial';
  const showInlineContextPanel = shouldShowInlineContextPanel(role, {
    isFinanceRegistryPage,
  });
  const hiddenValues = detailHiddenValues(role, object);
  const keyFacts = uniqueFacts(object.facts, hiddenValues);
  const sectionHiddenValues = [...hiddenValues, ...keyFacts.map((fact) => fact.value)];
  const visibleSections = object.sections
    .map((section) => ({ ...section, facts: uniqueFacts(section.facts, sectionHiddenValues) }))
    .filter((section) => section.facts.length > 0);
  // Служебный id (cuid живого backend) в плашку не выводим — только человекочитаемые номера.
  const financeReadableId = /^[A-ZА-Я]+[A-ZА-Я0-9]*-/.test(object.id) ? object.id : undefined;
  const detailTitle =
    role === 'finance'
      ? [
          financeReadableId,
          factValue(object, 'Номер'),
          factValue(object, 'Заказчик') ?? factValue(object, 'Контрагент'),
        ]
          .filter(Boolean)
          .join(' · ')
      : (displayTitle ?? object.title);

  if (isRawMaterialModule) {
    return (
      <article
        className={`detail-view role-${role} raw-material-detail-view ${stateClass(object.statusLabel)}`}
      >
        <RawMaterialUsageModule role={role} sourceObject={object} onAction={onAction} />
      </article>
    );
  }

  if (role === 'commercial') {
    return (
      <article
        className={`detail-view role-${role} commercial-detail-view office-workbench ${stateClass(object.statusLabel)}`}
      >
        <CommercialIntakeWorkbench
          object={object}
          factValue={factValue}
          FactList={FactList}
          onAction={onAction}
          selectedTemplateId={selectedTemplateId}
          templateCatalog={templateCatalog}
          templateVersions={templateVersions}
        />
      </article>
    );
  }

  return (
    <article
      className={`detail-view role-${role} ${stateClass(object.statusLabel)} ${isOfficeWorkbench ? 'office-workbench' : ''}`}
    >
      {showInlineContextPanel && (
        <header className="detail-header">
          <div>
            <h2>{detailTitle}</h2>
          </div>
          <div className="detail-header-actions">
            {role !== 'operator' && !isWarehouseStockLanding ? (
              <SeverityPill severity={object.severity} />
            ) : null}
            {onClose && role !== 'finance' && (
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
      )}

      {role === 'production' && (
        <ProductionOrderWorkbench
          object={object}
          factValue={factValue}
          FactList={FactList}
          onAction={onAction}
          siblingObjects={siblingObjects}
          activeSection={activeSection}
        />
      )}
      {role === 'finance' && (
        <FinanceWorkbench
          object={object}
          factValue={factValue}
          FactList={FactList}
          onAction={onAction}
          siblingObjects={siblingObjects}
          onSelectObject={onSelectObject}
          onBackToRegistry={onClose}
          activeSection={activeSection}
          isRegistryPage={isFinanceRegistryPage}
          onFinanceObjectUpdated={onFinanceObjectUpdated}
          onCorrectPayment={onCorrectFinancePayment}
          coverageRefreshGeneration={coverageRefreshGeneration}
        />
      )}
      {hasOfficeActionStrip && role !== 'commercial' && (
        <ActionPanel
          actions={object.actions}
          variant={largeActionVariant(role, object)}
          className="office-action-strip"
          onAction={onAction}
        />
      )}
      {role === 'admin' && object.actions.length > 0 && object.workbench?.type !== 'admin' && (
        <ActionPanel actions={object.actions} variant="default" className="admin-action-strip" />
      )}
      {isWarehouseGenericWorkbench && (
        <section
          className="surface warehouse-generic-workbench"
          aria-label="Рабочая поверхность склада"
        >
          <div className="workbench-visual-row">
            <StepIllustration
              kind="warehouse"
              label={`Склад: ${object.title}`}
              tone={object.severity}
            />
            <div>
              <span className="eyebrow">{object.statusLabel}</span>
              <h3>{object.title}</h3>
            </div>
          </div>
          <FactList facts={keyFacts} />
          {object.materialReceivingGate && (
            <div className="warehouse-material-receiving-gate" aria-label="Приемка сырья">
              <div className="template-header">
                <div>
                  <span className="eyebrow">Приемка сырья</span>
                  <h3 title="Приемка сырья меняет фактический склад.">
                    {object.materialReceivingGate.materialLabel}
                  </h3>
                </div>
                <IxPill>
                  {object.materialReceivingGate.source === 'warehouse_fact'
                    ? 'Факт склада'
                    : 'Проверочный ввод'}
                </IxPill>
              </div>
              <div className="commercial-cover-summary">
                <div>
                  <span>Сырье</span>
                  <strong>{object.materialReceivingGate.materialLabel}</strong>
                </div>
                <div>
                  <span>Принято</span>
                  <strong>
                    {object.materialReceivingGate.acceptedQty} {object.materialReceivingGate.unit}
                  </strong>
                </div>
                <div>
                  <span>Расхождение</span>
                  <strong>
                    {object.materialReceivingGate.discrepancyQty > 0 ? '+' : ''}
                    {object.materialReceivingGate.discrepancyQty}{' '}
                    {object.materialReceivingGate.unit}
                  </strong>
                </div>
                <div>
                  <span>Склад</span>
                  <strong>{object.materialReceivingGate.warehouse}</strong>
                </div>
                <div>
                  <span>Кто принял</span>
                  <strong>{object.materialReceivingGate.acceptedBy}</strong>
                </div>
              </div>
              <FactList facts={object.materialReceivingGate.evidence} />
            </div>
          )}
        </section>
      )}
      {isRawMaterialModule ? (
        <RawMaterialUsageModule role={role} sourceObject={object} onAction={onAction} />
      ) : isWarehouseInventoryObject ? (
        <WarehouseInventoryDashboard
          object={object}
          activeSection={activeSection}
          onAction={onAction}
          onStockMutation={onStockMutation}
          onAdjustRawMaterial={onAdjustRawMaterial}
          onReceiveRawMaterial={onReceiveRawMaterial}
          onCreateBigBag={onCreateBigBag}
          coverTasks={warehouseCoverTasks}
          coverFreeRolls={warehouseCoverFreeRolls}
          selectedWarehouseObjectId={selectedWarehouseObjectId}
          onSelectWarehouseObject={onSelectObject}
          onCoverPropose={onWarehouseCoverPropose}
          onCoverRefresh={onWarehouseCoverRefresh}
          coverageRefreshGeneration={coverageRefreshGeneration}
          onOneCStockPush={onWarehouseOneCStockPush}
          oneCStockPushBusy={warehouseOneCStockPushBusy}
          materialRecipeCatalog={warehouseMaterialRecipeCatalog}
          effectiveCapabilities={effectiveCapabilities}
        />
      ) : (
        <Workbench
          object={object}
          onAction={onAction}
          pendingActionId={pendingActionId}
          hideOperatorRollTable={role === 'operator' && activeSection === 'Рулоны и заказы'}
        />
      )}
      <OrderTemplateWorkbench
        role={role}
        object={object}
        selectedTemplateId={selectedTemplateId}
        templates={templateCatalog}
        versions={templateVersions}
        onTemplateSelect={onTemplateSelect}
      />
      {isWarehouseWorkbench ||
      isWarehouseInventoryObject ||
      isRawMaterialModule ? null : isOperatorWorkbench ? null : hasFocusedWorkbench ||
        hasOfficeActionStrip ||
        hasOfficeCommandBar ? null : (
        <div className="detail-action-first-block">
          <ActionFirstSummary role={role} object={object} />
          <ActionPanel
            actions={object.actions}
            variant={largeActionVariant(role, object)}
            onAction={onAction}
          />
        </div>
      )}

      {!hasFocusedWorkbench && (
        <details className="detail-disclosure">
          <summary>
            <span>Подробности</span>
            <small>
              {keyFacts.length +
                visibleSections.reduce((sum, section) => sum + section.facts.length, 0)}
            </small>
          </summary>
          <div className="sections-stack">
            {keyFacts.length > 0 && (
              <section className="surface section-surface">
                <h3>Ключевые поля</h3>
                <FactList facts={keyFacts} />
              </section>
            )}
            {visibleSections.map((section) => (
              <section key={section.id} className="surface section-surface">
                <h3>{section.title}</h3>
                <FactList facts={section.facts} />
              </section>
            ))}
          </div>
        </details>
      )}
      {showInlineContextPanel && !isWarehouseStockLanding && !isWarehouseRawMaterialSection && (
        <InlineContextPanel key={`${role}:${object.id}`} object={object} />
      )}
    </article>
  );
}

function OrderTemplateWorkbench({
  role,
  object,
  selectedTemplateId,
  templates,
  versions,
}: {
  role: Role;
  object: WorkObject;
  selectedTemplateId?: string;
  templates: CounterpartyOrderTemplate[];
  versions: CounterpartyOrderTemplateVersion[];
  onTemplateSelect: (objectId: string, templateId: string) => void;
}) {
  if (role !== 'production') return null;
  const objectLabel = `${object.id} ${object.title}`.toLowerCase();
  const isProductionOrder =
    object.kind === 'productionOrder' &&
    !object.filterTags?.includes('Штрафы') &&
    !objectLabel.includes('pen-') &&
    !object.title.trim().startsWith('Штраф');
  if (!isProductionOrder) return null;

  const counterparty = counterpartyForObject(object);
  if (!counterparty) {
    return (
      <section
        className={`surface template-workbench role-${role} template-check-strip`}
        aria-label="Сверка с шаблоном заказа"
      >
        <div className="template-check-main">
          <div>
            <span className="eyebrow">Сверка с шаблоном клиента</span>
            <h3>Шаблон не проверен</h3>
            <p>В заказе не выбран контрагент. Сначала выберите клиента в заказ-наряде.</p>
          </div>
          <span className="template-check-badge">Нет сверки</span>
        </div>
      </section>
    );
  }

  const counterpartyTemplatesList = sortedTemplates(
    templatesForCounterparty(counterparty.id, templates),
    'recent',
    '',
    versions,
  );
  if (counterpartyTemplatesList.length === 0) return null;

  const resolvedTemplate = resolveOrderTemplateForObject(
    object,
    counterpartyTemplatesList,
    versions,
    selectedTemplateId,
  );
  const selectedTemplate = resolvedTemplate.template;
  if (!selectedTemplate) {
    return (
      <section
        className={`surface template-workbench role-${role} template-check-strip requires-decision`}
        aria-label="Сверка с шаблоном заказа"
      >
        <div className="template-check-main">
          <div>
            <span className="eyebrow">Сверка с шаблоном клиента · {counterparty.legalName}</span>
            <h3>Шаблон не найден</h3>
            <p>
              В заказе нет уверенного совпадения. Проверьте типовой заказ клиента в разделе
              контрагентов.
            </p>
          </div>
          <span className="template-check-badge">Нет сверки</span>
        </div>
      </section>
    );
  }
  const selectedVersion = activeVersionForTemplate(selectedTemplate, versions);
  const selectedDisplay = templateDisplayModel(selectedTemplate, versions, counterparty);
  const diffs = templateDiffsForObject(object, selectedTemplate, role, versions);
  const escalatesToDirector =
    role === 'production' && diffs.some((diff) => diff.severity !== 'info');
  const primaryDiff = diffs[0];
  const statusLabel =
    diffs.length === 0
      ? 'Отличий нет'
      : escalatesToDirector
        ? 'Нужно согласование'
        : formatTemplateDiffCount(diffs.length);
  const statusNote =
    diffs.length === 0
      ? 'Можно работать по этому заказу.'
      : escalatesToDirector
        ? 'До запуска согласуйте изменение.'
        : 'Изменение действует только для текущего заказа.';
  const templateSourceLabel =
    resolvedTemplate.confidence === 'explicit' ? 'выбран вручную' : 'найден по заказу';

  return (
    <section
      className={`surface template-workbench role-${role} template-check-strip ${escalatesToDirector ? 'requires-decision' : ''}`}
      aria-label="Сверка с шаблоном заказа"
    >
      <div className="template-check-main">
        <div>
          <span className="eyebrow">Сверка с шаблоном клиента · {counterparty.legalName}</span>
          <h3>{selectedDisplay.title}</h3>
          <p>
            {selectedDisplay.descriptor || `${selectedVersion?.fields.length ?? 0} параметров`} ·
            шаблон {templateSourceLabel}
          </p>
        </div>
        <span className={`template-check-badge ${escalatesToDirector ? 'is-warning' : 'is-ok'}`}>
          {statusLabel}
        </span>
      </div>

      <div className="template-check-status" aria-label="Итог сверки шаблона">
        <div>
          <span>Итог</span>
          <strong>{statusLabel}</strong>
          <small>{statusNote}</small>
        </div>
        {primaryDiff && (
          <div>
            <span>Что изменилось</span>
            <strong>{primaryDiff.label}</strong>
            <small>
              В шаблоне: {primaryDiff.templateValue}. В заказе: {primaryDiff.currentValue}.
            </small>
          </div>
        )}
      </div>

      {diffs.length > 0 && (
        <details className="template-check-details">
          <summary>{formatTemplateDiffCount(diffs.length)} по шаблону</summary>
          <div className="template-diff-stack">
            {diffs.map((diff) => (
              <article
                key={diff.label}
                className={`template-diff-row severity-${diff.severity}`}
                title={`${diff.label}: ${diff.reason}`}
              >
                <span>{diff.label}</span>
                <div>
                  <small>В шаблоне</small>
                  <strong>{diff.templateValue}</strong>
                </div>
                <div>
                  <small>В заказе</small>
                  <strong>{diff.currentValue}</strong>
                </div>
                <p>
                  <span>Почему важно</span>
                  {diff.reason}
                </p>
              </article>
            ))}
          </div>
          {escalatesToDirector && (
            <IxMessageBar type="warning">
              Изменение влияет на рецептуру или деньги. Согласуйте его перед запуском заказа.
            </IxMessageBar>
          )}
        </details>
      )}
    </section>
  );
}

function formatTemplateDiffCount(count: number) {
  if (count === 1) return '1 отличие';
  if (count > 1 && count < 5) return `${count} отличия`;
  return `${count} отличий`;
}
