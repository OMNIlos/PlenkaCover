import { useEffect, useMemo, useState, type ComponentType } from 'react';

import { getCommercialNextStep, getCommercialOrderStage } from '../../domain/selectors';
import {
  buildCommercialPositionOptionSources,
  normalizeCommercialThickness,
  type CommercialPositionDraft,
  type CommercialPositionOptionField,
  type CommercialPositionOptionSources,
} from '../../domain/commercialPositionEditing';
import { counterpartyTypeLabel } from '../../domain/prototypeRuntime';
import { operatorByIdentity, productionOperators } from '../../domain/operators';
import { sortProductionRolls } from '../../domain/rollWork';
import { hasQualityDefectStatsSignal } from '../../domain/runtime/qualityStats';
import {
  activeVersionForTemplate,
  counterpartyForObject,
  positionTemplateDiffsForPosition,
  templateDisplayModel,
  templatesForCounterparty,
} from '../../domain/templates';
import { orderSurfaceProblem, type OrderSurfaceAction } from '../../domain/orderSurfaceProjection';
import {
  buildWarehouseCoverPlan,
  type WarehouseCoverPlan,
} from '../../domain/warehouseCoverPlanning';
import type {
  ActionDescriptor,
  CommercialOrderPosition,
  CounterpartyOrderTemplate,
  CounterpartyOrderTemplateVersion,
  Fact,
  ProductionRollDispatchItem,
  WorkObject,
} from '../../domain/types';
import { ActionPanel } from '../shell/ActionPanel';
import { actionDisplayLabel, actionIcon, actionVisualLevel } from '../shell/actionPresentation';
import { SiemensIcon } from '../shell/SiemensIcon';
import { CommercialCoverProposalList } from './CommercialCoverProposalList';
import { CommercialProductionProblemPanel } from './CommercialProductionProblemPanel';
import { CommercialSectionHeader } from './CommercialSectionHeader';
import { ProductionDispatchPanel } from './productionDispatchPanel';
import { WarehouseCoverResolutionPanel } from './WarehouseCoverResolutionPanel';
export { FinanceWorkbench } from './FinanceWorkbench';

type FactValueReader = (object: WorkObject, label: string) => string | undefined;
type FactListComponent = ComponentType<{ facts: Fact[] }>;

type OfficeWorkbenchProps = {
  object: WorkObject;
  factValue: FactValueReader;
  FactList: FactListComponent;
  onAction?: (actionId: string) => void;
  selectedTemplateId?: string;
  templateCatalog?: CounterpartyOrderTemplate[];
  templateVersions?: CounterpartyOrderTemplateVersion[];
  siblingObjects?: WorkObject[];
  onSelectObject?: (objectId: string) => void;
  activeSection?: string;
};

function compactActions(actions: ActionDescriptor[], nextAction: ActionDescriptor) {
  const allowed = new Set([
    'commercial-save-draft',
    'commercial-promote-draft',
    'commercial-transfer-selected',
    'commercial-open-payment-shipment',
    'commercial-request-correction',
    'commercial-open-production',
    'commercial-open-production-problem',
    'commercial-cover-confirmed',
  ]);
  const visible = actions.filter((action) => {
    const label = action.label.toLowerCase();
    const disabledText =
      `${action.disabledReason ?? ''} ${action.recoveryAction ?? ''}`.toLowerCase();
    if (
      action.level === 'disabled' &&
      (disabledText.includes('уже') ||
        disabledText.includes('записано') ||
        disabledText.includes('истори'))
    )
      return false;
    if (action.id === 'apply-template-partial' || label.includes('применить шаблон')) return false;
    if (label.includes('сохранить как шаблон')) return false;
    return action.id !== nextAction.id && allowed.has(action.id);
  });

  return visible;
}

function clampRollCount(value: number, min: number, max: number) {
  if (Number.isNaN(value)) return max;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function fallbackAction(object: WorkObject): ActionDescriptor {
  const nextStep = getCommercialNextStep(object);
  return (
    object.actions.find((action) => action.id === nextStep.actionId) ?? {
      id: nextStep.actionId,
      label: nextStep.label,
      level: nextStep.level,
      enabled: !nextStep.disabledReason,
      disabledReason: nextStep.disabledReason,
    }
  );
}

function productionRollQueue(selectedObject: WorkObject): ProductionRollDispatchItem[] {
  return sortProductionRolls(selectedObject.productionRollDispatchItems ?? [], 'manual');
}

function billingSnapshotSourceLabel(source: string | undefined) {
  const normalized = source?.toLowerCase() ?? '';
  if (source === 'manual_order_entry') return 'ручной ввод';
  if (
    source === 'mock_1C_snapshot' ||
    (normalized.includes('mock') && normalized.includes('snapshot'))
  )
    return 'снимок карточки контрагента';
  if (source === 'counterparty_card_snapshot') return 'карточка контрагента';
  if (normalized.includes('1c') || normalized.includes('1с')) return 'снимок карточки контрагента';
  if (normalized.includes('snapshot')) return 'снимок карточки контрагента';
  return source ?? 'нужна сверка';
}

function compactStatusLabel(value: string) {
  return value.trim().replace(/^./, (letter) => letter.toLocaleLowerCase('ru-RU'));
}

function commercialPaymentRouteCopy(
  paymentLabel: string,
  shipmentLabel: string,
  invoiceLabel: string,
) {
  const payment = paymentLabel.toLocaleLowerCase('ru-RU');
  const shipment = shipmentLabel.toLocaleLowerCase('ru-RU');
  const invoice = invoiceLabel.toLocaleLowerCase('ru-RU');
  const paymentDone =
    payment.includes('оплачен') && !payment.includes('не оплачен') && !payment.includes('частично');
  const paymentPartial = payment.includes('частично');
  const shipmentDone =
    shipment.includes('отгружено') &&
    !shipment.includes('не отгружено') &&
    !shipment.includes('частично');
  const shipmentPartial = shipment.includes('частично');

  if (!paymentDone && !paymentPartial) {
    return {
      invoice: invoice.includes('выставлен')
        ? 'счет выставлен'
        : invoice.includes('бухгалтер')
          ? 'в бухгалтерии'
          : 'ждет бухгалтерию',
      current: invoice.includes('выставлен') ? ('payment' as const) : ('invoice' as const),
    };
  }

  if (paymentPartial) {
    return {
      invoice: 'платеж внесен',
      current: 'payment' as const,
    };
  }

  if (!shipmentDone) {
    return {
      invoice: 'оплачено',
      current: 'shipment' as const,
    };
  }

  return {
    invoice: 'закрыто',
    current: 'done' as const,
  };
}

function positionIndexLabel(positionId: string, index: number) {
  const match = positionId.match(/POS-(\d+)$/);
  return match ? `Позиция ${match[1]}` : `Позиция ${index + 1}`;
}

function matchedRollStatus(ownership: string) {
  if (ownership === 'reserved_for_order') return 'под заказ';
  if (ownership === 'free_reserve') return 'свободный резерв';
  if (ownership === 'customer_owned') return 'клиентский';
  if (ownership === 'shipped') return 'отгружен';
  return 'на складе';
}

function materialSummaryForPosition(
  position: NonNullable<WorkObject['commercialOrder']>['positions'][number],
) {
  return position.rawMaterials && position.rawMaterials.length > 0
    ? position.rawMaterials
        .map((material) => `${material.label}: ${material.nominalQty} ${material.unit}`)
        .join('; ')
    : position.rawMaterialLabel;
}

function reserveRollSummary(
  rolls: Array<{ id: string; ownership: string; qty: number }>,
  reserveQty: number,
) {
  const seen = new Set<string>();
  const uniqueRolls = rolls.filter((roll) => {
    if (seen.has(roll.id)) return false;
    seen.add(roll.id);
    return true;
  });
  const visible = uniqueRolls.map(
    (roll) => `${roll.id} · ${matchedRollStatus(roll.ownership)} · ${roll.qty} рул.`,
  );
  const listedQty = uniqueRolls.reduce((sum, roll) => sum + roll.qty, 0);
  if (reserveQty > listedQty) visible.push(`+${reserveQty - listedQty} рул. по резерву позиции`);
  return visible;
}

function CommercialObjectHeader({
  title,
  clientLabel,
  status,
  stageDetail,
  owner,
  severity,
}: {
  title: string;
  clientLabel: string;
  status: string;
  stageDetail?: string;
  owner: string;
  severity: WorkObject['severity'];
}) {
  return (
    <header className="commercial-object-header">
      <div>
        <span className="eyebrow">Выбранная заявка</span>
        <h3>{title}</h3>
        {clientLabel && !title.includes(clientLabel) && <p>{clientLabel}</p>}
      </div>
      <div className="commercial-object-state">
        <span
          className={`commercial-state-badge state-${severity === 'critical' ? 'blocked' : severity === 'warning' ? 'warning' : 'ready'}`}
        >
          {status}
        </span>
        <small>{owner}</small>
      </div>
      <dl className="commercial-stage-strip" aria-label="Этап заявки">
        <div>
          <dt>Этап</dt>
          <dd>{stageDetail ?? status}</dd>
        </div>
      </dl>
    </header>
  );
}

function CommercialPrimaryActionBar({
  action,
  severity,
  onAction,
}: {
  action: OrderSurfaceAction;
  severity: WorkObject['severity'];
  onAction?: (actionId: string) => void;
}) {
  const ownerLabel = action.owner ?? action.recoveryOwner;
  const showOwner = ownerLabel?.trim().toLocaleLowerCase('ru-RU') !== 'коммерция';
  const actionLabel = actionDisplayLabel(action);
  const meta = [
    action.affectedBlock,
    ownerLabel && showOwner ? `Владелец: ${ownerLabel}` : undefined,
    !action.enabled && action.disabledReason ? `Причина: ${action.disabledReason}` : undefined,
  ].filter(Boolean);

  return (
    <section
      className={`commercial-primary-action severity-${severity}`}
      aria-label="Главное действие по заявке"
    >
      <div className="commercial-primary-copy">
        <span className="eyebrow">Сейчас сделать</span>
        <h4>{action.label}</h4>
        {meta.length > 0 && <p>{meta.join(' · ')}</p>}
      </div>
      <button
        className={`compact-action-button action-${actionVisualLevel(action)} commercial-primary-button`}
        type="button"
        disabled={!action.enabled}
        onClick={() => onAction?.(action.id)}
        aria-label={
          action.disabledReason ? `${actionLabel}. ${action.disabledReason}` : actionLabel
        }
        title={action.disabledReason ?? action.confirmation ?? undefined}
      >
        <SiemensIcon name={actionIcon(action)} size="16" />
        <span>{actionLabel}</span>
      </button>
    </section>
  );
}

function CommercialSecondaryActions({
  actions,
  onAction,
}: {
  actions: ActionDescriptor[];
  onAction?: (actionId: string) => void;
}) {
  if (actions.length === 0) return null;

  return (
    <section
      className="commercial-secondary-actions"
      aria-label="Дополнительные действия коммерции"
    >
      <span>Действия</span>
      <div>
        {actions.map((action) => (
          <button
            key={action.id}
            className={`compact-action-button action-${actionVisualLevel(action)}`}
            type="button"
            disabled={!action.enabled}
            onClick={() => onAction?.(action.id)}
            aria-label={
              action.disabledReason
                ? `${actionDisplayLabel(action)}. ${action.disabledReason}`
                : actionDisplayLabel(action)
            }
          >
            <SiemensIcon name={actionIcon(action)} size="16" />
            <span>{actionDisplayLabel(action)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

const COMMERCIAL_POSITION_CUSTOM_OPTIONS_KEY = 'plenki:commercial-position-custom-options';
const COMMERCIAL_POSITION_OPTION_FIELDS = [
  'filmType',
  'actualThickness',
  'accountingThickness',
  'birka',
  'spoolType',
  'rawMaterialLabel',
] as const satisfies readonly CommercialPositionOptionField[];
type CommercialPositionCustomOptions = Partial<Record<CommercialPositionOptionField, string[]>>;
type CommercialPositionCustomOptionStore = Record<string, CommercialPositionCustomOptions>;
type CommercialFieldState = 'directory' | 'manual' | 'warning' | 'invalid';
type CommercialFieldValidation = {
  value: string;
  source: CommercialFieldState;
  label: string;
  message?: string;
};
type CommercialDraftValidation = Record<
  CommercialPositionOptionField | 'rollCount',
  CommercialFieldValidation
>;

function commercialOptionsWithCurrent(options: string[], value: string) {
  const current = value.trim();
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

function commercialOptionsWithSaved(
  options: string[],
  savedOptions: string[] | undefined,
  value: string,
) {
  const merged = [...options, ...(savedOptions ?? [])].filter((option) => option.trim());
  const unique = Array.from(new Set(merged));
  return commercialOptionsWithCurrent(unique, value);
}

function readCommercialPositionCustomOptionStore(): CommercialPositionCustomOptionStore {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(COMMERCIAL_POSITION_CUSTOM_OPTIONS_KEY) ?? '{}',
    ) as CommercialPositionCustomOptionStore | CommercialPositionCustomOptions;
    if (!parsed || typeof parsed !== 'object') return {};
    const legacy = parsed as CommercialPositionCustomOptions;
    if (COMMERCIAL_POSITION_OPTION_FIELDS.some((field) => Array.isArray(legacy[field])))
      return { global: legacy };
    return parsed as CommercialPositionCustomOptionStore;
  } catch {
    return {};
  }
}

function readCommercialPositionCustomOptions(scope: string): CommercialPositionCustomOptions {
  const store = readCommercialPositionCustomOptionStore();
  return store[scope] ?? store.global ?? {};
}

function writeCommercialPositionCustomOptions(
  scope: string,
  options: CommercialPositionCustomOptions,
) {
  if (typeof window === 'undefined') return;
  const store = readCommercialPositionCustomOptionStore();
  window.localStorage.setItem(
    COMMERCIAL_POSITION_CUSTOM_OPTIONS_KEY,
    JSON.stringify({ ...store, [scope]: options }),
  );
}

function normalizeCommercialText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function commercialThicknessNumber(value: string) {
  const normalized = normalizeCommercialThickness(value);
  if (!normalized) return normalizeCommercialText(value).replace(/\s*(?:мкм|мкр)$/i, '');
  return normalized.replace(/\s*мкм$/i, '');
}

function commercialThicknessNumberOptions(
  options: string[],
  savedOptions: string[] | undefined,
  value: string,
) {
  return Array.from(
    new Set(
      commercialOptionsWithSaved(options, savedOptions, value)
        .map(commercialThicknessNumber)
        .filter(Boolean),
    ),
  );
}

function validateDirectoryLikeValue(
  value: string,
  options: string[],
  emptyMessage: string,
  manualLabel = 'ручное',
): CommercialFieldValidation {
  const normalized = normalizeCommercialText(value);
  if (!normalized) return { value: '', source: 'invalid', label: 'ошибка', message: emptyMessage };
  if (options.includes(normalized))
    return { value: normalized, source: 'directory', label: 'справочник' };
  return { value: normalized, source: 'manual', label: manualLabel };
}

function validateThicknessValue(
  value: string,
  options: string[],
  emptyMessage: string,
): CommercialFieldValidation {
  const normalized = normalizeCommercialThickness(value);
  if (!normalizeCommercialText(value))
    return { value: '', source: 'invalid', label: 'ошибка', message: emptyMessage };
  if (!normalized)
    return { value, source: 'invalid', label: 'ошибка', message: 'Формат: 78 или 78 мкм' };
  if (options.includes(normalized))
    return { value: normalized, source: 'directory', label: 'справочник' };
  return { value: normalized, source: 'manual', label: 'ручное' };
}

function validateCommercialPositionDraft(
  draft: CommercialPositionDraft,
  options: CommercialPositionOptionSources,
): CommercialDraftValidation {
  const rollValue = normalizeCommercialText(draft.rollCount);
  const rollNumber = Number(rollValue);
  const birkaValue = commercialBirkaDraftValue(draft);
  return {
    rollCount:
      /^\d+$/.test(rollValue) && rollNumber > 0 && rollNumber <= 999
        ? { value: String(rollNumber), source: 'directory', label: 'число' }
        : {
            value: rollValue,
            source: 'invalid',
            label: 'ошибка',
            message: 'Рулоны: целое число 1-999',
          },
    filmType: validateDirectoryLikeValue(draft.filmType, options.filmType, 'Укажите тип пленки'),
    actualThickness: validateThicknessValue(
      draft.actualThickness,
      options.actualThickness,
      'Укажите фактическую толщину',
    ),
    accountingThickness: validateThicknessValue(
      draft.accountingThickness,
      options.accountingThickness,
      'Укажите бухгалтерскую толщину',
    ),
    birka: validateDirectoryLikeValue(birkaValue, options.birka, 'Укажите бирку', 'ручная'),
    spoolType: validateDirectoryLikeValue(draft.spoolType, options.spoolType, 'Укажите шпулю'),
    rawMaterialLabel: (() => {
      const value = normalizeCommercialText(draft.rawMaterialLabel);
      if (!value)
        return {
          value: '',
          source: 'invalid' as const,
          label: 'ошибка',
          message: 'Укажите сырье',
        };
      if (options.rawMaterialLabel.includes(value))
        return { value, source: 'directory' as const, label: 'склад / заявка' };
      return {
        value,
        source: 'invalid' as const,
        label: 'нет в источнике',
        message: 'Выберите сырье из актуального складского источника',
      };
    })(),
  };
}

function normalizeCommercialPositionDraft(
  draft: CommercialPositionDraft,
  validation: CommercialDraftValidation,
  birkaOptions: string[],
): CommercialPositionDraft {
  const birkaValue = validation.birka.value;
  const isKnownBirka = birkaOptions.includes(birkaValue);
  return {
    rollCount: validation.rollCount.value,
    filmType: validation.filmType.value,
    actualThickness: validation.actualThickness.value,
    accountingThickness: validation.accountingThickness.value,
    birka: isKnownBirka ? birkaValue : '',
    manualBirka: isKnownBirka ? '' : birkaValue,
    spoolType: validation.spoolType.value,
    rawMaterialLabel: validation.rawMaterialLabel.value,
    warehouseCoverStatus: draft.warehouseCoverStatus,
    warehousePartialCoverQty: draft.warehousePartialCoverQty,
  };
}

function commercialDraftHasErrors(validation: CommercialDraftValidation) {
  return Object.values(validation).some((field) => field.source === 'invalid');
}

function commercialBirkaDraftValue(draft: CommercialPositionDraft) {
  return normalizeCommercialText(draft.manualBirka || draft.birka);
}

function commercialBirkaDisplay(draft: CommercialPositionDraft) {
  return (
    [draft.birka, draft.manualBirka].map(normalizeCommercialText).filter(Boolean).join(' / ') || '-'
  );
}

function commercialPositionRouteLabel(status: CommercialOrderPosition['warehouseCoverStatus']) {
  if (status === 'full_proposed' || status === 'full_confirmed') return 'склад закрывает';
  if (status === 'partial_proposed' || status === 'partial_confirmed') return 'часть со склада';
  if (status === 'needs_production') return 'в производство';
  return 'не проверено';
}

function CommercialPositionSelect({
  className,
  value,
  options,
  onChange,
  ariaLabel,
  listId,
  validation,
  allowCustom = true,
}: {
  className: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  ariaLabel: string;
  listId: string;
  validation: CommercialFieldValidation;
  allowCustom?: boolean;
}) {
  const sourceOptions = commercialOptionsWithCurrent(options, value);
  return (
    <span
      className={`commercial-position-field state-${validation.source}`}
      title={validation.message ?? validation.label}
    >
      {allowCustom ? (
        <>
          <input
            className={`commercial-position-input commercial-position-select ${className}`}
            value={value}
            list={listId}
            onChange={(event) => onChange(event.target.value)}
            aria-label={ariaLabel}
          />
          <datalist id={listId}>
            {sourceOptions.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      ) : (
        <select
          className={`commercial-position-input commercial-position-select ${className}`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel}
        >
          {sourceOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
      <span className="commercial-position-source">{validation.label}</span>
    </span>
  );
}

function CommercialPositionUnitInput({
  value,
  options,
  onChange,
  ariaLabel,
  listId,
  validation,
  unit,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  ariaLabel: string;
  listId: string;
  validation: CommercialFieldValidation;
  unit: string;
}) {
  return (
    <span
      className={`commercial-position-field commercial-position-unit-field state-${validation.source}`}
      title={validation.message ?? validation.label}
    >
      <span className="commercial-position-unit-control">
        <input
          className="commercial-position-input commercial-position-select is-thickness"
          value={commercialThicknessNumber(validation.value)}
          list={listId}
          inputMode="numeric"
          onChange={(event) => onChange(event.target.value)}
          aria-label={ariaLabel}
        />
        <datalist id={listId}>
          {commercialOptionsWithCurrent(options, commercialThicknessNumber(validation.value)).map(
            (option) => (
              <option key={option} value={option} />
            ),
          )}
        </datalist>
        <span className="commercial-position-unit" aria-hidden="true">
          {unit}
        </span>
      </span>
      <span className="commercial-position-source">{validation.label}</span>
    </span>
  );
}

function positionFromDraftForCover(
  position: CommercialOrderPosition,
  draft: CommercialPositionDraft,
): CommercialOrderPosition {
  const rollCount = Math.max(1, Math.trunc(Number(draft.rollCount) || position.rollCount));
  return {
    ...position,
    rollCount,
    rawMaterialLabel: normalizeCommercialText(draft.rawMaterialLabel) || position.rawMaterialLabel,
    warehouseCoverStatus: draft.warehouseCoverStatus,
  };
}

function CommercialWarehouseCoverRouteControl({
  plan,
  status,
  partialQty,
  onStatusChange,
  onPartialQtyChange,
}: {
  plan: WarehouseCoverPlan;
  status: CommercialOrderPosition['warehouseCoverStatus'];
  partialQty: string;
  onStatusChange: (
    status: CommercialOrderPosition['warehouseCoverStatus'],
    partialQty: string,
  ) => void;
  onPartialQtyChange: (value: string) => void;
}) {
  const showPartialInput = Boolean(plan.partialInput && status === 'partial_proposed');
  return (
    <div className="commercial-cover-route-control">
      {showPartialInput && plan.partialInput && (
        <label className="commercial-cover-route-partial">
          <input
            className="commercial-position-input is-number"
            type="number"
            min={plan.partialInput.min}
            max={plan.partialInput.max}
            step="1"
            value={partialQty || String(plan.partialInput.defaultValue)}
            aria-label="Сколько рулонов покрыть сырьем со склада"
            onChange={(event) => onPartialQtyChange(event.currentTarget.value)}
          />
          <span>{plan.partialInput.suffix}</span>
        </label>
      )}
      <div className="commercial-cover-route-buttons">
        {plan.actions.map((action) => {
          const selected = status === action.status;
          return (
            <button
              key={action.id}
              className={`commercial-cover-route-button ${selected ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                const nextPartialQty =
                  action.id === 'partial'
                    ? String(plan.partialInput?.defaultValue ?? plan.coverableRollCount)
                    : action.id === 'full'
                      ? String(plan.rollCount)
                      : '0';
                onStatusChange(action.status, nextPartialQty);
              }}
            >
              {action.label}
            </button>
          );
        })}
      </div>
      <small>
        {plan.stock
          ? `${plan.stock.label}: ${plan.coverableRollCount} из ${plan.rollCount} рул.`
          : 'Сырье не найдено в учётных остатках'}
      </small>
    </div>
  );
}

function draftFromPosition(
  position: CommercialOrderPosition,
  coverQty?: number,
): CommercialPositionDraft {
  return {
    rollCount: String(position.rollCount),
    filmType: position.filmType,
    actualThickness: position.actualThickness,
    accountingThickness: position.accountingThickness,
    birka: position.birka,
    manualBirka: position.manualBirka ?? '',
    spoolType: position.spoolType,
    rawMaterialLabel: position.rawMaterialLabel,
    warehouseCoverStatus: position.warehouseCoverStatus,
    warehousePartialCoverQty: coverQty !== undefined ? String(coverQty) : '',
  };
}

function encodedCommercialPositionSavePayload(positionId: string, draft: CommercialPositionDraft) {
  return encodeURIComponent(JSON.stringify({ positionId, draft }));
}
function CommercialProblemBlock({ object }: { object: WorkObject }) {
  const problem = orderSurfaceProblem(object);
  if (!problem) return null;

  return (
    <section
      className={`commercial-problem-block severity-${problem.severity}`}
      aria-label="Проблема выбранной заявки"
    >
      <span className="commercial-problem-mark" aria-hidden="true">
        <SiemensIcon name="warning" size="16" />
      </span>
      <div>
        <span className="eyebrow">Проблема</span>
        <strong>{problem.title}</strong>
        {problem.reason && <p>{problem.reason}</p>}
      </div>
      <div>
        <span>{problem.ownerRole}</span>
        <strong>{problem.recovery}</strong>
        {problem.due && <small>{problem.due}</small>}
      </div>
    </section>
  );
}

export function CommercialIntakeWorkbench({
  object,
  factValue,
  FactList,
  onAction,
  selectedTemplateId,
  templateCatalog = [],
  templateVersions = [],
}: OfficeWorkbenchProps) {
  const positions = object.commercialOrder?.positions ?? [];
  const proposals = object.warehouseCoverProposals ?? [];
  const counterparty = counterpartyForObject(object);
  const customOptionScope = counterparty?.id ?? object.commercialOrder?.counterpartyId ?? 'global';
  const [manualCoverByProposalId, setManualCoverByProposalId] = useState<Record<string, number>>(
    {},
  );
  const [billingOpen, setBillingOpen] = useState(false);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [positionDrafts, setPositionDrafts] = useState<Record<string, CommercialPositionDraft>>({});
  const [customPositionOptions, setCustomPositionOptions] =
    useState<CommercialPositionCustomOptions>(() =>
      readCommercialPositionCustomOptions(customOptionScope),
    );
  useEffect(() => {
    setCustomPositionOptions(readCommercialPositionCustomOptions(customOptionScope));
  }, [customOptionScope]);
  const effectiveProposals = useMemo(
    () =>
      proposals.map((proposal) => {
        if (proposal.confirmedAt) return proposal;
        const requestedQty = proposal.coverQty + proposal.missingQty;
        const manualQty = manualCoverByProposalId[proposal.id];
        const coverQty = clampRollCount(manualQty ?? proposal.coverQty, 0, proposal.coverQty);
        const missingQty = Math.max(0, requestedQty - coverQty);
        return {
          ...proposal,
          coverType: missingQty > 0 ? ('partial' as const) : ('full' as const),
          coverQty,
          reserveQty: coverQty,
          missingQty,
          productionQty: missingQty,
        };
      }),
    [manualCoverByProposalId, proposals],
  );
  const nextStep = getCommercialNextStep(object);
  const nextAction = fallbackAction(object);
  const orderStage = getCommercialOrderStage(object);
  const billingSnapshot = object.commercialOrder?.billingSnapshot;
  const documentTitle = object.title;
  const clientLabel =
    billingSnapshot?.label ?? factValue(object, 'Контрагент') ?? 'Контрагент не выбран';
  const documentMoment =
    object.commercialOrder?.submittedAt ?? object.commercialOrder?.createdAt ?? 'нет даты';
  const documentStage =
    orderStage?.label ??
    (object.commercialOrder?.status === 'draft' ? 'Черновик' : object.statusLabel);
  const canEditParameters = object.actions.some(
    (action) => action.id === 'commercial-edit-params' && action.enabled,
  );
  const paymentLabel =
    object.paymentIndicator?.label ??
    factValue(object, 'Оплата') ??
    object.commercialOrder?.paymentStatus ??
    'нет данных';
  const shipmentLabel =
    factValue(object, 'Отгрузка') ?? object.commercialOrder?.shipmentStatus ?? 'нет данных';
  const invoiceLabel = factValue(object, 'Счет') ?? 'Не передано';
  const paymentRoute = commercialPaymentRouteCopy(paymentLabel, shipmentLabel, invoiceLabel);
  const totalRequestedQty = positions.reduce((sum, position) => sum + position.rollCount, 0);
  const totalReserveQty = effectiveProposals.reduce(
    (sum, proposal) => sum + (proposal.reserveQty ?? proposal.coverQty),
    0,
  );
  const totalMissingQty = effectiveProposals.reduce(
    (sum, proposal) => sum + (proposal.productionQty ?? proposal.missingQty),
    0,
  );
  const commercialFulfillmentRows = positions.map((position, index) => {
    const proposal = effectiveProposals.find((item) => item.positionId === position.id);
    const shortage = object.materialShortageBlockers?.find(
      (blocker) => blocker.positionId === position.id && blocker.shortageQty > 0,
    );
    const reserveQty = proposal ? (proposal.reserveQty ?? proposal.coverQty) : 0;
    const productionQty = proposal
      ? (proposal.productionQty ?? proposal.missingQty)
      : position.rollCount;
    const rollLabels = proposal ? reserveRollSummary(proposal.matchedRolls, reserveQty) : [];
    return {
      id: position.id,
      line: positionIndexLabel(position.id, index),
      position,
      proposal,
      reserveQty,
      productionQty,
      shortage,
      rollLabels,
      status: shortage
        ? 'сырье проверить'
        : proposal?.confirmedAt
          ? 'резерв принят'
          : reserveQty > 0
            ? 'резерв найден'
            : 'в производство',
      severity: shortage ? 'critical' : productionQty > 0 ? 'warning' : 'info',
    };
  });
  const reserveOrderGroups = effectiveProposals
    .filter((proposal) => (proposal.reserveQty ?? proposal.coverQty) > 0)
    .map((proposal) => ({
      id: proposal.id,
      order: object.id,
      positionId: proposal.positionId,
      reserveQty: proposal.reserveQty ?? proposal.coverQty,
      productionQty: proposal.productionQty ?? proposal.missingQty,
      confirmed: Boolean(proposal.confirmedAt),
      rolls: proposal.matchedRolls,
    }));
  const fulfillmentPositionSummary =
    positions.length > 1
      ? `${positions.length} поз. · ${positions.map((position, index) => positionIndexLabel(position.id, index)).join(', ')}`
      : positions[0]
        ? `${positionIndexLabel(positions[0].id, 0)} · ${positions[0].filmType}, ${positions[0].actualThickness}`
        : 'позиций нет';
  const fulfillmentReserveSummary =
    reserveOrderGroups.length > 0
      ? reserveOrderGroups
          .map((group) => reserveRollSummary(group.rolls, group.reserveQty).join(', '))
          .filter(Boolean)
          .join('; ')
      : 'резерв не найден';
  const fulfillmentProductionSummary =
    totalMissingQty > 0
      ? commercialFulfillmentRows
          .filter((row) => row.productionQty > 0)
          .map((row) => `${row.line}: ${row.productionQty} рул.`)
          .join(', ')
      : 'производство не требуется';
  const fulfillmentMaterialSummary = commercialFulfillmentRows.some((row) => row.shortage)
    ? commercialFulfillmentRows
        .filter((row) => row.shortage)
        .map((row) => `${row.line}: не хватает ${row.shortage?.shortageQty} ${row.shortage?.unit}`)
        .join(', ')
    : commercialFulfillmentRows
        .map(
          (row) =>
            `${row.line}: ${row.position.rawMaterialLabel} · ${materialSummaryForPosition(row.position)}`,
        )
        .join('; ');
  const fulfillmentStatusLabel = commercialFulfillmentRows.some((row) => row.shortage)
    ? 'есть нехватка сырья'
    : totalMissingQty > 0
      ? 'часть в выпуск'
      : totalReserveQty > 0
        ? 'резерв закрывает'
        : 'ждет решения';
  const hasConfirmedCover = effectiveProposals.some((proposal) => proposal.confirmedAt);
  const hasPendingCover = effectiveProposals.some((proposal) => !proposal.confirmedAt);
  const warehouseResolutionCase = object.orderResolutionCases?.find(
    (item) =>
      (item.type === 'warehouse_cover_resolution' || item.type === 'warehouse_cover_dispute') &&
      !['cancelled', 'resolved'].includes(item.status),
  );
  const warehouseResolutionOutcome =
    warehouseResolutionCase?.warehouseCoverResolution?.outcome ?? warehouseResolutionCase?.outcome;
  const coverClosed = proposals.length > 0 && !hasPendingCover;
  const coverReadOnly = true;
  const canEditCoverPosition =
    warehouseResolutionOutcome === 'edited_position' &&
    warehouseResolutionCase?.status === 'awaiting_commercial';
  const coverConfirmedBy = proposals.find((proposal) => proposal.confirmedBy)?.confirmedBy;
  const coverOwnerLabel = coverClosed
    ? 'Действие закрыто'
    : warehouseResolutionOutcome === 'warehouse_recheck_requested'
      ? 'Ждет склад'
      : canEditCoverPosition
        ? 'Нужна правка позиции'
        : 'Нужно решение';
  const coverExternalOwnerLabel =
    warehouseResolutionOutcome === 'warehouse_recheck_requested' ? 'Склад' : undefined;
  const coverStatusLabel = coverClosed
    ? 'Покрытие закрыто'
    : warehouseResolutionOutcome === 'warehouse_recheck_requested'
      ? 'Перепроверка склада'
      : canEditCoverPosition
        ? 'Нужна правка позиции'
        : warehouseResolutionOutcome
          ? 'Решение записано'
          : 'Нужно решение';
  const coverStatusState =
    coverClosed ||
    warehouseResolutionOutcome === 'accepted_with_missing_to_production' ||
    warehouseResolutionOutcome === 'rejected_send_all_to_production'
      ? 'done'
      : 'warning';
  const hasWarehouseFit = totalReserveQty > 0;
  const productionFirstLabel =
    totalMissingQty > 0 ? `${totalMissingQty} рул. к выпуску` : 'Производство не требуется';
  const warehouseFitLabel = hasWarehouseFit
    ? `${totalReserveQty} из ${totalRequestedQty} рул. со склада`
    : 'Подходящих рулонов нет';
  const warehouseGateSummary = coverReadOnly
    ? 'Итог решения сохранен в истории заказа.'
    : hasWarehouseFit
      ? 'Ручная проверка резерва доступна при необходимости.'
      : 'Если склад позже найдет подходящие рулоны, gate можно открыть вручную.';
  const coverExplanation = coverClosed
    ? `Склад зарезервировал ${totalReserveQty} из ${totalRequestedQty} рул.; ${coverConfirmedBy ?? 'коммерция'} приняла покрытие. ${totalMissingQty > 0 ? `${totalMissingQty} рул. уйдет в производство.` : 'Производство не требуется.'}`
    : warehouseResolutionOutcome === 'warehouse_recheck_requested'
      ? 'Коммерция запросила перепроверку; склад владеет следующим шагом, производство не получает сырой отказ.'
      : canEditCoverPosition
        ? 'Коммерция выбрала правку позиции; повторное решение по резерву закрыто до изменения параметров.'
        : warehouseResolutionOutcome
          ? 'Исход разборки уже записан в историю; доступна только проверка статуса и audit.'
          : totalMissingQty > 0
            ? 'Основной маршрут — передать недостающий объем в производство; складской gate остается ручной проверкой резерва.'
            : 'Коммерция должна принять резерв склада, изменить количество или запросить перепроверку.';
  const productionStarted =
    object.commercialOrder?.productionStatus === 'in_production' ||
    object.commercialOrder?.productionStatus === 'ready' ||
    Boolean(object.commercialProductionProgress) ||
    Boolean(object.productionProblems?.some((problem) => problem.status !== 'resolved'));
  const baseDomainActions = compactActions(object.actions, nextAction).filter((action) => {
    if (!coverClosed) return true;
    return !['commercial-confirm-warehouse-cover', 'commercial-open-warehouse-resolution'].includes(
      action.id,
    );
  });
  const domainActions = baseDomainActions.filter((action) => {
    if (action.id === 'commercial-open-warehouse-resolution') return false;
    if (action.id === 'commercial-confirm-warehouse-cover') return false;
    return true;
  });
  const firstPosition = positions[0];
  const positionTemplates = counterparty
    ? templatesForCounterparty(counterparty.id, templateCatalog)
    : [];
  const activePositionTemplateVersions = positionTemplates
    .map((template) => activeVersionForTemplate(template, templateVersions))
    .filter((version): version is CounterpartyOrderTemplateVersion => Boolean(version));
  const positionOptionSources = buildCommercialPositionOptionSources({
    positions,
    templateVersions: activePositionTemplateVersions,
    rawMaterialStocks: object.rawMaterialStocks ?? [],
  });
  const selectedPositionTemplate =
    positionTemplates.find((template) => template.id === selectedTemplateId) ??
    positionTemplates[0];
  const selectedPositionVersion = selectedPositionTemplate
    ? activeVersionForTemplate(selectedPositionTemplate, templateVersions)
    : null;
  const selectedPositionDisplay = selectedPositionTemplate
    ? templateDisplayModel(selectedPositionTemplate, templateVersions, counterparty)
    : null;
  const positionDiffs =
    firstPosition && selectedPositionTemplate
      ? positionTemplateDiffsForPosition(firstPosition, selectedPositionTemplate, templateVersions)
      : [];
  const selectedPositionApplication =
    firstPosition && selectedPositionTemplate
      ? object.positionTemplateApplications?.find(
          (application) =>
            application.positionId === firstPosition.id &&
            application.templateId === selectedPositionTemplate.id &&
            application.appliedAt,
        )
      : undefined;
  const canApplyPositionTemplate = Boolean(
    firstPosition &&
    selectedPositionTemplate &&
    positionDiffs.length > 0 &&
    !productionStarted &&
    !selectedPositionApplication,
  );
  const positionDiffSummary = selectedPositionApplication
    ? `${positionDiffs.length} отлич. приняты`
    : positionDiffs.length > 0
      ? `${positionDiffs.length} отлич. перед применением`
      : 'Отличий нет';
  const templateStatusState = selectedPositionApplication
    ? 'done'
    : productionStarted || positionDiffs.length > 0
      ? 'warning'
      : selectedPositionTemplate
        ? 'ready'
        : 'neutral';
  const templateStatusLabel = selectedPositionApplication
    ? 'Сверено'
    : productionStarted
      ? 'Через запрос'
      : selectedPositionTemplate
        ? positionDiffs.length > 0
          ? 'Сверить'
          : 'Совпадает'
        : 'Не сохранен';
  const positionNumber = firstPosition?.id.match(/POS-(\d+)$/)?.[1];
  const templateLineLabel = firstPosition
    ? `${positionNumber ? `Позиция ${positionNumber}` : firstPosition.id} · ${firstPosition.rollCount} рул.`
    : (factValue(object, 'Позиции') ?? 'нет данных');
  const templateCurrentParams = firstPosition
    ? [
        `${firstPosition.filmType} ${firstPosition.actualThickness}`,
        firstPosition.rawMaterialLabel,
        firstPosition.spoolType,
        [firstPosition.birka, firstPosition.manualBirka].filter(Boolean).join(' / '),
      ]
        .filter(Boolean)
        .join(' · ')
    : 'позиция не заполнена';
  const primaryAction: OrderSurfaceAction = {
    ...nextAction,
    owner: nextStep.owner,
    affectedBlock: nextStep.affectedBlock,
  };
  const handleCommercialAction = (actionId: string) => {
    if (actionId === 'commercial-open-warehouse-resolution') {
      onAction?.(actionId);
      return;
    }
    onAction?.(actionId);
  };
  const startPositionEdit = (position: CommercialOrderPosition, options?: { force?: boolean }) => {
    if (!canEditParameters && !options?.force) {
      handleCommercialAction('commercial-open-payment-shipment');
      return;
    }
    if (productionStarted && !options?.force) {
      handleCommercialAction('commercial-request-correction');
      return;
    }
    const proposal = proposals.find((item) => item.positionId === position.id);
    setPositionDrafts((current) => ({
      ...current,
      [position.id]: current[position.id] ?? draftFromPosition(position, proposal?.coverQty),
    }));
    setEditingPositionId(position.id);
  };
  const updatePositionDraft = (
    positionId: string,
    field: keyof CommercialPositionDraft,
    value: string,
  ) => {
    setPositionDrafts((current) => ({
      ...current,
      [positionId]: {
        ...(current[positionId] ??
          draftFromPosition(
            positions.find((position) => position.id === positionId) ?? positions[0],
            proposals.find((proposal) => proposal.positionId === positionId)?.coverQty,
          )),
        [field]: value,
      },
    }));
  };
  const updateBirkaDraft = (positionId: string, value: string) => {
    const normalized = normalizeCommercialText(value);
    setPositionDrafts((current) => {
      const draft =
        current[positionId] ??
        draftFromPosition(
          positions.find((position) => position.id === positionId) ?? positions[0],
          proposals.find((proposal) => proposal.positionId === positionId)?.coverQty,
        );
      return {
        ...current,
        [positionId]: {
          ...draft,
          birka: positionOptionSources.birka.includes(normalized) ? normalized : '',
          manualBirka: positionOptionSources.birka.includes(normalized) ? '' : value,
        },
      };
    });
  };
  const savePositionDraft = (positionId: string) => {
    const draft = positionDrafts[positionId];
    if (!draft) return;
    const validation = validateCommercialPositionDraft(draft, positionOptionSources);
    if (commercialDraftHasErrors(validation)) return;

    const normalizedDraft = normalizeCommercialPositionDraft(
      draft,
      validation,
      positionOptionSources.birka,
    );
    let customOptionsChanged = false;
    const nextCustomOptions: CommercialPositionCustomOptions = { ...customPositionOptions };
    COMMERCIAL_POSITION_OPTION_FIELDS.forEach((field) => {
      if (field === 'rawMaterialLabel') return;
      const value =
        field === 'birka'
          ? commercialBirkaDraftValue(normalizedDraft)
          : normalizedDraft[field].trim();
      if (
        !value ||
        positionOptionSources[field].includes(value) ||
        (nextCustomOptions[field] ?? []).includes(value)
      )
        return;
      nextCustomOptions[field] = [...(nextCustomOptions[field] ?? []), value];
      customOptionsChanged = true;
    });
    if (customOptionsChanged) {
      setCustomPositionOptions(nextCustomOptions);
      writeCommercialPositionCustomOptions(customOptionScope, nextCustomOptions);
    }
    setPositionDrafts((current) => ({
      ...current,
      [positionId]: normalizedDraft,
    }));
    setEditingPositionId(null);
    handleCommercialAction(
      `commercial-edit-params:${encodedCommercialPositionSavePayload(positionId, normalizedDraft)}`,
    );
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('.commercial-position-matrix')
        ?.scrollTo({ left: 0, behavior: 'auto' });
    });
  };
  const cancelPositionDraft = (positionId: string) => {
    setEditingPositionId(null);
    setPositionDrafts((current) => {
      const next = { ...current };
      delete next[positionId];
      return next;
    });
  };

  return (
    <section
      className={`surface commercial-workspace severity-${nextStep.severity}`}
      aria-label={`Коммерция: ${documentTitle}`}
    >
      <CommercialObjectHeader
        title={documentTitle}
        clientLabel={clientLabel}
        status={documentStage}
        stageDetail={orderStage?.detail}
        owner={nextStep.owner}
        severity={nextStep.severity}
      />
      <CommercialPrimaryActionBar
        action={primaryAction}
        severity={nextStep.severity}
        onAction={handleCommercialAction}
      />
      <CommercialSecondaryActions actions={domainActions} onAction={handleCommercialAction} />
      <CommercialProblemBlock object={object} />

      {object.materialShortageBlockers && object.materialShortageBlockers.length > 0 && (
        <section className="commercial-panel commercial-material-shortage-panel">
          <CommercialSectionHeader
            tone="warehouse"
            eyebrow="Сырье"
            title="Нехватка сырья"
            owner="Зав. производства + Склад"
            status="Блокирует выпуск"
            statusState="warning"
          />
          <div className="commercial-shortage-grid">
            {object.materialShortageBlockers.map((blocker) => {
              const positionIndex = positions.findIndex(
                (position) => position.id === blocker.positionId,
              );
              const position = positionIndex >= 0 ? positions[positionIndex] : undefined;
              const positionLabel = position
                ? `${positionIndexLabel(position.id, positionIndex)} · ${position.filmType}, ${position.actualThickness}`
                : blocker.positionId;
              return (
                <article key={blocker.id} className="commercial-shortage-card">
                  <div className="commercial-shortage-main">
                    <span>Сырье</span>
                    <strong>{blocker.label}</strong>
                    <small>{positionLabel}</small>
                  </div>
                  <dl className="commercial-shortage-metrics" aria-label="Складской факт по сырью">
                    <div>
                      <dt>Не хватает</dt>
                      <dd>
                        {blocker.shortageQty} {blocker.unit}
                      </dd>
                    </div>
                    <div>
                      <dt>Требуется</dt>
                      <dd>
                        {blocker.requiredQty} {blocker.unit}
                      </dd>
                    </div>
                    <div>
                      <dt>Факт</dt>
                      <dd>
                        {blocker.factQty} {blocker.unit}
                      </dd>
                    </div>
                    <div>
                      <dt>Резерв</dt>
                      <dd>
                        {blocker.usableReserveQty} {blocker.unit}
                      </dd>
                    </div>
                  </dl>
                  <div className="commercial-shortage-owner">
                    <span>Владелец</span>
                    <strong>Зав. производства + Склад</strong>
                    <small>Блокируется до передачи в заказ-наряд</small>
                  </div>
                  <div
                    className="commercial-shortage-actions"
                    aria-label="Действия по нехватке сырья"
                  >
                    <button
                      type="button"
                      className="compact-action-button action-secondary"
                      onClick={() =>
                        handleCommercialAction(`commercial-material-recheck:${blocker.id}`)
                      }
                    >
                      Склад проверить
                    </button>
                    <button
                      type="button"
                      className="compact-action-button action-peer"
                      onClick={() => {
                        if (position) startPositionEdit(position, { force: true });
                        handleCommercialAction(`commercial-material-edit:${blocker.positionId}`);
                      }}
                    >
                      Править позицию
                    </button>
                    <button
                      type="button"
                      className="compact-action-button action-recommended"
                      onClick={() =>
                        handleCommercialAction(`commercial-material-production:${blocker.id}`)
                      }
                    >
                      В производство
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="commercial-main-grid">
        <section className="commercial-panel commercial-positions-panel">
          <CommercialSectionHeader
            tone="positions"
            eyebrow="Позиции заказа"
            title="Позиции и параметры"
            description="Карточка заказа: позиции, рулоны, толщина, бирка, шпуля и сырье."
            status="Можно менять параметры"
            statusState="ready"
          />
          {positions.length > 0 ? (
            <div className="commercial-position-matrix" role="region" aria-label="Позиции заявки">
              <table>
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Рул.</th>
                    <th>Тип</th>
                    <th>Факт</th>
                    <th>Бух.</th>
                    <th>Бирка</th>
                    <th>Шпуля</th>
                    <th>Сырье</th>
                    <th>Статус</th>
                    <th>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((position, index) => {
                    const proposal = proposals.find((item) => item.positionId === position.id);
                    const draft =
                      positionDrafts[position.id] ??
                      draftFromPosition(position, proposal?.coverQty);
                    const isEditing = editingPositionId === position.id;
                    const draftValidation = validateCommercialPositionDraft(
                      draft,
                      positionOptionSources,
                    );
                    const hasDraftErrors = commercialDraftHasErrors(draftValidation);
                    const coverPlan = buildWarehouseCoverPlan(
                      positionFromDraftForCover(position, draft),
                      object.rawMaterialStocks ?? [],
                    );
                    const hasManualDraftValues = Object.values(draftValidation).some(
                      (field) => field.source === 'manual' || field.source === 'warning',
                    );
                    return (
                      <tr key={position.id} className={isEditing ? 'is-editing' : undefined}>
                        <td data-label="№">{index + 1}</td>
                        <td data-label="Рул.">
                          {isEditing ? (
                            <span
                              className={`commercial-position-field state-${draftValidation.rollCount.source}`}
                              title={draftValidation.rollCount.message ?? 'Количество рулонов'}
                            >
                              <input
                                className="commercial-position-input is-number"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={draft.rollCount}
                                onChange={(event) =>
                                  updatePositionDraft(position.id, 'rollCount', event.target.value)
                                }
                                aria-label="Количество рулонов"
                              />
                              <span className="commercial-position-source">
                                {draftValidation.rollCount.label}
                              </span>
                            </span>
                          ) : (
                            draft.rollCount
                          )}
                        </td>
                        <td data-label="Тип">
                          {isEditing ? (
                            <CommercialPositionSelect
                              className="is-film"
                              value={draft.filmType}
                              options={commercialOptionsWithSaved(
                                positionOptionSources.filmType,
                                customPositionOptions.filmType,
                                draft.filmType,
                              )}
                              onChange={(value) =>
                                updatePositionDraft(position.id, 'filmType', value)
                              }
                              ariaLabel="Тип пленки"
                              listId={`commercial-film-options-${index}`}
                              validation={draftValidation.filmType}
                            />
                          ) : (
                            draft.filmType
                          )}
                        </td>
                        <td data-label="Факт">
                          {isEditing ? (
                            <CommercialPositionUnitInput
                              value={draft.actualThickness}
                              options={commercialThicknessNumberOptions(
                                positionOptionSources.actualThickness,
                                customPositionOptions.actualThickness,
                                draft.actualThickness,
                              )}
                              onChange={(value) =>
                                updatePositionDraft(position.id, 'actualThickness', value)
                              }
                              ariaLabel="Фактическая толщина"
                              listId={`commercial-actual-thickness-options-${index}`}
                              validation={draftValidation.actualThickness}
                              unit="мкм"
                            />
                          ) : (
                            draft.actualThickness
                          )}
                        </td>
                        <td data-label="Бух.">
                          {isEditing ? (
                            <CommercialPositionUnitInput
                              value={draft.accountingThickness}
                              options={commercialThicknessNumberOptions(
                                positionOptionSources.accountingThickness,
                                customPositionOptions.accountingThickness,
                                draft.accountingThickness,
                              )}
                              onChange={(value) =>
                                updatePositionDraft(position.id, 'accountingThickness', value)
                              }
                              ariaLabel="Бухгалтерская толщина"
                              listId={`commercial-accounting-thickness-options-${index}`}
                              validation={draftValidation.accountingThickness}
                              unit="мкм"
                            />
                          ) : (
                            draft.accountingThickness
                          )}
                        </td>
                        <td data-label="Бирка">
                          {isEditing ? (
                            <CommercialPositionSelect
                              className="is-birka"
                              value={commercialBirkaDraftValue(draft)}
                              options={commercialOptionsWithSaved(
                                positionOptionSources.birka,
                                customPositionOptions.birka,
                                commercialBirkaDraftValue(draft),
                              )}
                              onChange={(value) => updateBirkaDraft(position.id, value)}
                              ariaLabel="Бирка"
                              listId={`commercial-birka-options-${index}`}
                              validation={draftValidation.birka}
                            />
                          ) : (
                            commercialBirkaDisplay(draft)
                          )}
                        </td>
                        <td data-label="Шпуля">
                          {isEditing ? (
                            <CommercialPositionSelect
                              className="is-spool"
                              value={draft.spoolType}
                              options={commercialOptionsWithSaved(
                                positionOptionSources.spoolType,
                                customPositionOptions.spoolType,
                                draft.spoolType,
                              )}
                              onChange={(value) =>
                                updatePositionDraft(position.id, 'spoolType', value)
                              }
                              ariaLabel="Шпуля"
                              listId={`commercial-spool-options-${index}`}
                              validation={draftValidation.spoolType}
                            />
                          ) : (
                            draft.spoolType
                          )}
                        </td>
                        <td data-label="Сырье">
                          {isEditing ? (
                            <CommercialPositionSelect
                              className="is-material"
                              value={draft.rawMaterialLabel}
                              options={positionOptionSources.rawMaterialLabel}
                              onChange={(value) =>
                                updatePositionDraft(position.id, 'rawMaterialLabel', value)
                              }
                              ariaLabel="Сырье"
                              listId={`commercial-raw-material-options-${index}`}
                              validation={draftValidation.rawMaterialLabel}
                              allowCustom={false}
                            />
                          ) : (
                            draft.rawMaterialLabel
                          )}
                        </td>
                        <td data-label="Статус">
                          {isEditing ? (
                            <CommercialWarehouseCoverRouteControl
                              plan={coverPlan}
                              status={draft.warehouseCoverStatus}
                              partialQty={draft.warehousePartialCoverQty}
                              onStatusChange={(status, partialQty) => {
                                updatePositionDraft(position.id, 'warehouseCoverStatus', status);
                                updatePositionDraft(
                                  position.id,
                                  'warehousePartialCoverQty',
                                  partialQty,
                                );
                              }}
                              onPartialQtyChange={(value) =>
                                updatePositionDraft(position.id, 'warehousePartialCoverQty', value)
                              }
                            />
                          ) : (
                            <span className="commercial-mini-pill severity-warning">
                              {commercialPositionRouteLabel(position.warehouseCoverStatus)}
                            </span>
                          )}
                        </td>
                        <td data-label="Действие">
                          {isEditing ? (
                            <span className="commercial-row-actions">
                              <button
                                className="commercial-table-action is-primary"
                                type="button"
                                disabled={hasDraftErrors}
                                onClick={() => savePositionDraft(position.id)}
                                title={
                                  hasDraftErrors
                                    ? 'Исправьте формат полей перед сохранением'
                                    : 'Сохранить позицию'
                                }
                              >
                                Сохранить
                              </button>
                              <button
                                className="commercial-table-action"
                                type="button"
                                onClick={() => cancelPositionDraft(position.id)}
                              >
                                Отмена
                              </button>
                            </span>
                          ) : (
                            <button
                              className="commercial-table-action"
                              type="button"
                              disabled={!canEditParameters}
                              onClick={() => startPositionEdit(position)}
                              title={
                                canEditParameters
                                  ? 'Изменить позицию'
                                  : 'Параметры закрыты после подтверждения бухгалтерией'
                              }
                            >
                              {canEditParameters
                                ? productionStarted
                                  ? 'Запросить'
                                  : 'Правка'
                                : 'Закрыто'}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <FactList
              facts={[
                { label: 'Контрагент', value: factValue(object, 'Контрагент') ?? 'Не выбран' },
                { label: 'Позиции', value: factValue(object, 'Позиции') ?? 'Не заполнены' },
                {
                  label: 'Характеристики',
                  value: factValue(object, 'Характеристики') ?? 'По позициям',
                },
              ]}
            />
          )}
        </section>

        <aside
          className={`commercial-panel commercial-template-panel template-state-${templateStatusState}`}
        >
          <details className="commercial-template-disclosure">
            <summary className="commercial-template-simple-head">
              <span className="commercial-section-icon" aria-hidden="true">
                <SiemensIcon name="table-tag" size="16" />
              </span>
              <span className="commercial-template-title">
                <span className="eyebrow">Контекст клиента</span>
                <strong>Шаблон позиции</strong>
                <small>
                  {selectedPositionDisplay?.title ?? 'Шаблон не сохранен'} · {positionDiffSummary}
                </small>
              </span>
              <span className={`commercial-state-badge state-${templateStatusState}`}>
                {templateStatusLabel}
              </span>
              <span className="commercial-disclosure-mark" aria-hidden="true">
                <SiemensIcon name="chevron-right-small" size="16" />
              </span>
            </summary>

            <div className="commercial-template-body">
              <dl className="commercial-template-quick-facts" aria-label="Сверка шаблона">
                <div>
                  <dt>Строка</dt>
                  <dd>{templateLineLabel}</dd>
                </div>
                <div>
                  <dt>Параметры</dt>
                  <dd>{templateCurrentParams}</dd>
                </div>
                {selectedPositionVersion && (
                  <div>
                    <dt>Версия</dt>
                    <dd>{selectedPositionVersion.version}</dd>
                  </div>
                )}
              </dl>

              {selectedPositionTemplate && (
                <section className="commercial-template-compare" aria-label="Сверка со строкой">
                  <h5>Сверка</h5>
                  {positionDiffs.length > 0 ? (
                    <div
                      className="commercial-position-template-diff"
                      aria-label="Отличия шаблона от строки"
                    >
                      {positionDiffs.map((diff) => (
                        <article key={diff.label} className={`severity-${diff.severity}`}>
                          <span>{diff.label}</span>
                          <div>
                            <small>Шаблон</small>
                            <strong>{diff.templateValue}</strong>
                          </div>
                          <div>
                            <small>Строка</small>
                            <strong>{diff.currentValue}</strong>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="commercial-template-empty">Отличий нет.</p>
                  )}
                </section>
              )}

              <div className="commercial-template-actions">
                {!selectedPositionTemplate && firstPosition && (
                  <button
                    className="compact-action-button action-secondary"
                    type="button"
                    onClick={() =>
                      onAction?.(`commercial-create-position-template:${firstPosition.id}`)
                    }
                  >
                    <SiemensIcon name="table-tag" size="16" />
                    <span>Сохранить шаблон</span>
                  </button>
                )}
                {firstPosition && selectedPositionTemplate && (
                  <button
                    className={`compact-action-button ${canApplyPositionTemplate ? 'action-recommended' : 'action-disabled'}`}
                    type="button"
                    disabled={!canApplyPositionTemplate}
                    onClick={() =>
                      onAction?.(
                        `commercial-apply-position-template:${firstPosition.id}|${selectedPositionTemplate.id}`,
                      )
                    }
                  >
                    <SiemensIcon name="check" size="16" />
                    <span>{selectedPositionApplication ? 'Сверено' : 'Применить шаблон'}</span>
                  </button>
                )}
                {productionStarted && (
                  <button
                    className="compact-action-button action-peer"
                    type="button"
                    onClick={() => handleCommercialAction('commercial-request-correction')}
                  >
                    <SiemensIcon name="warning" size="16" />
                    <span>Запросить изменение</span>
                  </button>
                )}
              </div>
            </div>
          </details>
        </aside>
      </div>

      <div className="commercial-side-stack">
        {positions.length > 0 && (
          <section className="commercial-panel commercial-fulfillment-panel">
            <CommercialSectionHeader
              tone="warehouse"
              eyebrow="Склад / сырье / выпуск"
              title="Покрытие по заказу"
              description="Позиции, резервные рулоны, недостача в производство и сырье."
              status={
                totalMissingQty > 0 ? `${totalMissingQty} рул. к выпуску` : 'Закрыто резервом'
              }
              statusState={
                commercialFulfillmentRows.some((row) => row.shortage)
                  ? 'blocked'
                  : totalMissingQty > 0
                    ? 'warning'
                    : 'done'
              }
            />

            <dl className="commercial-fulfillment-summary" aria-label="Итог покрытия заказа">
              <div>
                <dt>Заказано</dt>
                <dd>{totalRequestedQty} рул.</dd>
                <small>{fulfillmentPositionSummary}</small>
              </div>
              <div>
                <dt>Резерв</dt>
                <dd>{totalReserveQty} рул.</dd>
                <small>{fulfillmentReserveSummary}</small>
              </div>
              <div>
                <dt>К выпуску</dt>
                <dd>{totalMissingQty} рул.</dd>
                <small>{fulfillmentProductionSummary}</small>
              </div>
              <div>
                <dt>Сырье</dt>
                <dd>
                  {commercialFulfillmentRows.some((row) => row.shortage)
                    ? 'проверить'
                    : 'по рецептуре'}
                </dd>
                <small>{fulfillmentMaterialSummary}</small>
              </div>
              <div className="commercial-fulfillment-summary__status">
                <dt>Статус</dt>
                <dd>{fulfillmentStatusLabel}</dd>
              </div>
            </dl>
          </section>
        )}

        {proposals.length > 0 && (
          <section
            className={`commercial-panel commercial-cover-panel ${!coverReadOnly ? 'is-resolution-open' : ''} ${coverReadOnly ? 'is-readonly' : 'is-pending'}`.trim()}
          >
            <CommercialSectionHeader
              tone="warehouse"
              eyebrow="Резерв склада"
              title={totalMissingQty > 0 ? 'Недостача уходит в производство' : 'Складское покрытие'}
              description={coverExplanation}
              owner={coverExternalOwnerLabel}
              status={coverStatusLabel}
              statusState={coverStatusState}
            >
              {canEditCoverPosition && (
                <button
                  className="compact-action-button action-peer"
                  type="button"
                  onClick={() => handleCommercialAction('commercial-edit-params')}
                >
                  <SiemensIcon name="table-settings" size="16" />
                  <span>Изменить позицию</span>
                </button>
              )}
            </CommercialSectionHeader>
            <div
              className="commercial-cover-production-strip"
              aria-label="Маршрут недостающих рулонов"
            >
              <div className={totalMissingQty > 0 ? 'is-production' : 'is-done'}>
                <span className="commercial-summary-mark">
                  <SiemensIcon name="tasks-open" size="16" />
                </span>
                <span>Производство</span>
                <strong>{productionFirstLabel}</strong>
              </div>
              <div className={hasWarehouseFit ? 'is-reserve' : 'is-empty'}>
                <span className="commercial-summary-mark">
                  <SiemensIcon name="capacity-check" size="16" />
                </span>
                <span>Склад</span>
                <strong>{warehouseFitLabel}</strong>
              </div>
              <div>
                <span className="commercial-summary-mark">
                  <SiemensIcon name="table-settings" size="16" />
                </span>
                <span>Владелец</span>
                <strong>{totalMissingQty > 0 ? 'Зав. производства' : coverOwnerLabel}</strong>
              </div>
            </div>
            <details className="commercial-cover-gate">
              <summary>
                <span>
                  <strong>Решение склада</strong>
                  <small>{warehouseGateSummary}</small>
                </span>
              </summary>
              {!coverReadOnly && (
                <WarehouseCoverResolutionPanel
                  requestedQty={totalRequestedQty}
                  reserveQty={totalReserveQty}
                  missingQty={totalMissingQty}
                  onSubmit={(outcome, resolutionReason) => {
                    const reason = encodeURIComponent(resolutionReason.trim());
                    onAction?.(
                      `commercial-warehouse-resolution:${outcome}${reason ? `:${reason}` : ''}`,
                    );
                  }}
                />
              )}
              <div
                className={`commercial-cover-manual-grid ${coverReadOnly ? 'is-readonly' : ''}`}
                aria-label={
                  coverReadOnly ? 'Итог складского покрытия' : 'Ручной выбор рулонов со склада'
                }
              >
                {proposals.map((proposal, index) => {
                  const position =
                    positions[index] ?? positions.find((item) => item.id === proposal.positionId);
                  const effectiveProposal =
                    effectiveProposals.find((item) => item.id === proposal.id) ?? proposal;
                  const requestedQty = proposal.coverQty + proposal.missingQty;
                  const maxCoverQty = proposal.coverQty;
                  const fieldLabel = position ? `Позиция ${index + 1}` : proposal.positionId;
                  if (coverReadOnly) {
                    return (
                      <div key={proposal.id} className="commercial-cover-manual-field is-readonly">
                        <span>{fieldLabel}</span>
                        <strong>
                          {effectiveProposal.coverQty} из {requestedQty} рул. со склада
                        </strong>
                        <b>{effectiveProposal.coverQty}</b>
                        <small>
                          {effectiveProposal.missingQty > 0
                            ? `${effectiveProposal.missingQty} рул. уйдет в производство`
                            : 'Производство не требуется'}
                        </small>
                      </div>
                    );
                  }
                  return (
                    <label key={proposal.id} className="commercial-cover-manual-field">
                      <span>{fieldLabel}</span>
                      <strong>
                        {effectiveProposal.coverQty} из {requestedQty} рул. со склада
                      </strong>
                      <input
                        type="number"
                        min="0"
                        max={maxCoverQty}
                        step="1"
                        disabled={Boolean(proposal.confirmedAt)}
                        value={effectiveProposal.coverQty}
                        aria-label={`Сколько рулонов списать со склада по позиции ${index + 1}`}
                        onChange={(event) => {
                          const nextQty = clampRollCount(
                            event.currentTarget.valueAsNumber,
                            0,
                            maxCoverQty,
                          );
                          setManualCoverByProposalId((current) => ({
                            ...current,
                            [proposal.id]: nextQty,
                          }));
                        }}
                      />
                      <small>Авто: {maxCoverQty} рул.</small>
                    </label>
                  );
                })}
              </div>
              <CommercialCoverProposalList proposals={effectiveProposals} positions={positions} />
            </details>
          </section>
        )}

        <section className="commercial-payment-shipment-strip">
          <div className="commercial-payment-route-head">
            <h4>Оплата и выдача</h4>
          </div>
          <div className="commercial-payment-route" aria-label="Маршрут оплаты и выдачи">
            <div
              className={`commercial-payment-route-step is-${paymentRoute.current === 'invoice' ? 'current' : 'done'}`}
            >
              <span className="commercial-payment-route-icon">
                <SiemensIcon name="table-settings" size="24" />
              </span>
              <span className="commercial-payment-route-label">Счет</span>
              <strong>{paymentRoute.invoice}</strong>
              <small>Бухгалтерия</small>
            </div>
            <div className="commercial-payment-route-line" aria-hidden="true" />
            <div
              className={`commercial-payment-route-step is-${paymentRoute.current === 'payment' ? 'current' : paymentRoute.current === 'invoice' ? 'waiting' : 'done'}`}
            >
              <span className="commercial-payment-route-icon">
                <SiemensIcon name="tasks-open" size="24" />
              </span>
              <span className="commercial-payment-route-label">Оплата</span>
              <strong>{compactStatusLabel(paymentLabel)}</strong>
              <small>Клиент</small>
            </div>
            <div className="commercial-payment-route-line" aria-hidden="true" />
            <div
              className={`commercial-payment-route-step is-${paymentRoute.current === 'shipment' ? 'current' : paymentRoute.current === 'done' ? 'done' : 'waiting'}`}
            >
              <span className="commercial-payment-route-icon">
                <SiemensIcon name="truck" size="24" />
              </span>
              <span className="commercial-payment-route-label">Выдача</span>
              <strong>{compactStatusLabel(shipmentLabel)}</strong>
              <small>Склад</small>
            </div>
          </div>
        </section>

        <section
          className={`commercial-panel commercial-billing-panel commercial-billing-disclosure ${billingOpen ? 'is-open' : ''}`}
          aria-label="Реквизиты клиента"
        >
          <button
            className="commercial-billing-summary"
            type="button"
            aria-expanded={billingOpen}
            aria-controls={`commercial-billing-values-${object.id}`}
            onClick={() => setBillingOpen((current) => !current)}
          >
            <span className="commercial-section-icon" aria-hidden="true">
              <SiemensIcon name="rules-filled" size="24" />
            </span>
            <span className="commercial-section-copy">
              <span className="eyebrow">Клиент</span>
              <strong>Реквизиты</strong>
              <span className="commercial-section-meta" aria-label="Реквизиты: владелец и статус">
                <span className="commercial-owner-chip">Реквизиты</span>
                <span
                  className={`commercial-state-badge state-${billingSnapshot?.source === 'manual_order_entry' ? 'warning' : 'ready'}`}
                >
                  {billingSnapshot?.source === 'manual_order_entry'
                    ? 'Ручной ввод'
                    : 'Снимок реквизитов'}
                </span>
              </span>
            </span>
            <span className="commercial-disclosure-mark" aria-hidden="true">
              <SiemensIcon name="chevron-right-small" size="16" />
            </span>
          </button>
          {billingOpen && (
            <dl
              id={`commercial-billing-values-${object.id}`}
              className="commercial-key-values commercial-billing-values"
            >
              <div>
                <dt>Тип</dt>
                <dd>
                  {billingSnapshot
                    ? counterpartyTypeLabel(billingSnapshot.type)
                    : (factValue(object, 'Тип контрагента') ?? 'Не указан')}
                </dd>
              </div>
              <div>
                <dt>Название</dt>
                <dd>{clientLabel}</dd>
              </div>
              <div>
                <dt>ИНН / КПП</dt>
                <dd>
                  {billingSnapshot?.inn ?? factValue(object, 'ИНН') ?? '[нужен факт]'} /{' '}
                  {billingSnapshot?.kpp ?? factValue(object, 'КПП') ?? '[нужен факт]'}
                </dd>
              </div>
              <div>
                <dt>Адрес</dt>
                <dd>
                  {billingSnapshot?.legalAddress ??
                    factValue(object, 'Юр. адрес') ??
                    '[нужен факт]'}
                </dd>
              </div>
              <div>
                <dt>Контакт</dt>
                <dd>
                  {billingSnapshot?.contactName ?? factValue(object, 'Контакт') ?? 'Не указан'}
                </dd>
              </div>
              <div>
                <dt>Источник</dt>
                <dd>
                  {billingSnapshotSourceLabel(billingSnapshot?.source) ??
                    factValue(object, 'Источник реквизитов') ??
                    'нужна сверка'}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </div>

      <CommercialProductionProblemPanel object={object} onAction={onAction} />
    </section>
  );
}

export function ProductionOrderWorkbench({
  object,
  factValue,
  FactList,
  onAction,
  siblingObjects,
  activeSection,
}: OfficeWorkbenchProps) {
  const canApprove = object.actions.some(
    (action) => action.label.includes('Согласовать') && action.enabled,
  );
  const counterpartyLabel = factValue(object, 'Контрагент') ?? factValue(object, 'Заказчик');
  const positionsLabel = factValue(object, 'Позиции') ?? factValue(object, 'Пленка');
  const rollLabel = factValue(object, 'Рулоны');
  const operatorLabel = factValue(object, 'Ответственный') ?? '';
  const selectedOperatorId = operatorByIdentity(operatorLabel)?.id ?? '';
  const selectedPriority = factValue(object, 'Приоритет') ?? 'обычный';
  const currentOwner = factValue(object, 'Ответственный') ?? object.nextOwner;
  const productionProblem = orderSurfaceProblem(object);
  const productionPrimaryAction =
    object.actions.find((action) => action.label.includes('Согласовать')) ??
    object.actions.find((action) => action.level === 'recommended') ??
    object.actions[0];
  const productionActionLayer = object.actions.filter(
    (action, index, actions) =>
      action.id === productionPrimaryAction?.id ||
      (action.level !== 'disabled' &&
        actions.findIndex((candidate) => candidate.id === action.id) === index),
  );
  const identitySubtitle = [counterpartyLabel, positionsLabel, rollLabel]
    .filter(Boolean)
    .join(' · ');
  const routeStatus = canApprove ? 'Согласование доступно' : object.statusLabel;
  const qualityStatsSection = object.sections.find((section) =>
    section.id.endsWith('quality-defect-stats'),
  );
  const hasQualityStatsSignal = hasQualityDefectStatsSignal(qualityStatsSection?.facts);
  const productionStatusSeverity = object.severity === 'critical' ? 'critical' : 'info';
  const rollQueue = productionRollQueue(object);

  return (
    <section
      className="surface production-workbench production-command-surface severity-info"
      data-object-severity={object.severity}
      aria-label={`Зав. производства: ${object.title}`}
    >
      <header className="production-workbench-header">
        <div>
          <span className="eyebrow">Заказ-наряд</span>
          <h3>{object.title}</h3>
          {identitySubtitle && <p>{identitySubtitle}</p>}
        </div>
        <span className={`production-state-badge severity-${productionStatusSeverity}`}>
          {routeStatus}
        </span>
      </header>

      {productionPrimaryAction && (
        <section
          className="production-decision-strip severity-info"
          data-object-severity={object.severity}
          aria-label="Решение завпроизводства"
        >
          <div className="production-decision-copy">
            <span className="eyebrow">Главное решение сейчас</span>
            <strong>{productionPrimaryAction.label}</strong>
          </div>
          <ActionPanel
            actions={productionActionLayer}
            title=""
            variant="default"
            embedded
            className="production-actions"
            onAction={onAction}
          />
        </section>
      )}

      <ProductionDispatchPanel
        viewMode={activeSection === 'Все рулоны' ? 'rolls' : 'order'}
        selectedOperatorId={selectedOperatorId}
        selectedPriority={selectedPriority}
        rollDispatchItems={rollQueue}
        onAssignOperator={(operatorId) => onAction?.(`production-assign-operator:${operatorId}`)}
        onUpdatePriority={(priority) => onAction?.(`production-set-priority:${priority}`)}
        onUpdateRollOperator={(rollDispatchItemId, operatorId) =>
          onAction?.(`production-set-roll-operator:${rollDispatchItemId}:${operatorId}`)
        }
        onUpdateRollMachine={(rollDispatchItemId, machineId) =>
          onAction?.(`production-set-roll-machine:${rollDispatchItemId}:${machineId}`)
        }
        onUpdateRollPriority={(rollDispatchItemId, priority) =>
          onAction?.(`production-set-roll-priority:${rollDispatchItemId}:${priority}`)
        }
        onBulkAssign={(rollIds, operatorId, priority) =>
          onAction?.(
            `production-bulk-assign:${rollIds.map(encodeURIComponent).join(',')}:${operatorId}:${priority}`,
          )
        }
        onMoveRollQueue={(rollDispatchItemId, direction) =>
          onAction?.(`production-move-roll:${rollDispatchItemId}:${direction}`)
        }
      />

      <div className="production-command-grid" aria-label="Маршрут, блокеры и политика заявки">
        {productionProblem && (
          <section className={`production-command-panel severity-${productionProblem.severity}`}>
            <span className="eyebrow">Блокер</span>
            <div className="production-blocker-copy">
              <strong>{productionProblem.title}</strong>
              {productionProblem.reason && <span>{productionProblem.reason}</span>}
              <small>
                Владелец: {productionProblem.ownerRole}. Действие: {productionProblem.recovery}
              </small>
            </div>
          </section>
        )}

        {qualityStatsSection && hasQualityStatsSignal && (
          <section className="production-command-panel">
            <span className="eyebrow">Статистика брака</span>
            <FactList facts={qualityStatsSection.facts.slice(0, 6)} />
          </section>
        )}
      </div>
    </section>
  );
}
