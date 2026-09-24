import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { qrDisplayLabel } from '../../domain/qrDisplay';
import { operatorShiftDefectBags } from '../../domain/defectBagLabels';
import { hasDefectBagDraft, OperatorDefectBagsPanel } from './OperatorDefectBagsPanel';
import { scannerAsciiFromPhysicalKey } from '../../domain/hidScannerKeyboard';
import {
  fetchOperatorScaleReading,
  operatorMachineBreakdownAction,
  type OperatorScaleReading,
} from '../../api/operator';
import { isLiveContour } from '../../api/liveContours';
import type { OperatorMachineChangeView } from '../../api/production';
import { MachineBreakdownForm } from '../../features/operator/MachineBreakdownForm';

import { IxMessageBar } from '@siemens/ix-react';

import type { ActionDescriptor, OperatorWorkbench } from '../../domain/types';
import { actionGroups } from '../../domain/selectors';
import { ActionPanel } from '../shell/ActionPanel';
import { actionDisplayLabel, actionIcon } from '../shell/actionPresentation';
import { StepIllustration } from '../shell/viewPrimitives';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';
import type { IllustrationKind } from '../shell/viewPrimitives';
import type {
  BigBagWeightDraft,
  OperatorBigBagPickerOption,
  OperatorRuntimeState,
} from '../../domain/operatorRuntime';
import {
  operatorRollGroupLabel,
  operatorRollQrWarehouseLabel,
  operatorRollStatusSeverity,
  operatorShiftBlockerText,
  operatorShiftDateTimeLabel,
  operatorShiftRecoveryText,
  operatorShiftSeverity,
  operatorShiftStatusLabel,
  operatorStageCooldownBlocksAction,
  operatorToleranceLabel,
  parseManualKg,
} from '../../domain/operatorRuntime';
import {
  calculateOperatorScaleReading,
  formatOperatorScaleKg,
  OperatorScalePreview,
} from './operatorScalePreview';
import { OperatorActiveBigBagPanel } from './OperatorActiveBigBagPanel';
import { OperatorOrderMassSummary } from '../../features/operator/OperatorOrderMassSummary';

export function operatorQrScanAction(payload: string): string {
  return `operator-verify-qr:${encodeURIComponent(payload.trim())}`;
}

function formatKg(value: number) {
  return formatOperatorScaleKg(value);
}

function canonicalBigBagKg(bag: OperatorBigBagPickerOption): number | null {
  return bag.currentKg ?? bag.warehouseKg;
}

function operatorKgLabel(value: number | undefined) {
  return Number.isFinite(value) && value !== undefined && value > 0
    ? `${formatKg(value)} кг`
    : 'ждет весы';
}

const operatorParameterNumber = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
});

function operatorRollTypeLabel(group: NonNullable<OperatorWorkbench['currentRollGroup']>) {
  const source = group.rollType?.trim() || group.filmType.trim();
  const canonical = ['Полурукав', 'Рукав', 'Полотно', 'Фальц'].find((candidate) =>
    new RegExp(`(?:^|\\s)${candidate}(?:\\s|$)`, 'iu').test(source),
  );
  if (canonical) return canonical;
  return source ? `${source.charAt(0).toUpperCase()}${source.slice(1)}` : 'Не указан';
}

function operatorActualThickness(group: NonNullable<OperatorWorkbench['currentRollGroup']>) {
  return group.actualThickness?.trim() || group.micron.split('(')[0]?.trim() || 'Не указана';
}

function operatorAccountingThickness(group: NonNullable<OperatorWorkbench['currentRollGroup']>) {
  if (group.accountingThickness?.trim()) return group.accountingThickness.trim();
  const legacy = /\(([^)]+?)\s*бух\.\)/iu.exec(group.micron)?.[1]?.trim();
  return legacy ? `${legacy.replace(/\s*мкм$/iu, '').trim()} мкм` : 'Не указана';
}

function operatorRollDimensions(group: NonNullable<OperatorWorkbench['currentRollGroup']>) {
  const widthMm = group.widthMm;
  const plannedLengthM = group.plannedLengthM;
  if (widthMm !== undefined || plannedLengthM !== undefined) {
    return {
      width: widthMm !== undefined ? `${operatorParameterNumber.format(widthMm)} мм` : 'Не указана',
      length:
        plannedLengthM !== undefined
          ? `${operatorParameterNumber.format(plannedLengthM)} м`
          : 'Не указан',
    };
  }

  const metricPair = /^\s*([\d.,]+)\s*м\s*[x×]\s*([\d.,]+)\s*м\s*$/iu.exec(group.sizeMeters);
  if (metricPair) {
    const length = Number(metricPair[1]?.replace(',', '.'));
    const width = Number(metricPair[2]?.replace(',', '.'));
    return {
      width: Number.isFinite(width) ? `${operatorParameterNumber.format(width)} м` : 'Не указана',
      length: Number.isFinite(length) ? `${operatorParameterNumber.format(length)} м` : 'Не указан',
    };
  }

  const millimeterPair = /^\s*([\d.,]+)\s*мм\s*[·x×]\s*([\d.,]+)\s*м\s*$/iu.exec(group.sizeMeters);
  return {
    width: millimeterPair?.[1] ? `${millimeterPair[1]} мм` : 'Не указана',
    length: millimeterPair?.[2] ? `${millimeterPair[2]} м` : 'Не указан',
  };
}

function operatorRecipeDetails(group: NonNullable<OperatorWorkbench['currentRollGroup']>) {
  const name = group.recipeName?.trim() || group.recipe.trim() || 'Не указана';
  const version =
    group.recipeVersionNumber !== undefined
      ? `Версия ${operatorParameterNumber.format(group.recipeVersionNumber)}`
      : group.recipeVersion && group.recipeVersion !== 'Версия не указана'
        ? `Версия ${group.recipeVersion}`
        : null;
  const ingredients = (group.recipeIngredients ?? []).filter(
    (ingredient) =>
      ingredient.name.trim() &&
      Number.isInteger(ingredient.shareBasisPoints) &&
      ingredient.shareBasisPoints > 0,
  );
  const isRedundantBaseMaterial =
    ingredients.length === 1 &&
    ingredients[0]?.shareBasisPoints === 10_000 &&
    ingredients[0]?.name.trim().toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU');
  return {
    name,
    version,
    ingredients: isRedundantBaseMaterial ? [] : ingredients,
  };
}

function operatorIllustrationKind(workbench: OperatorWorkbench): IllustrationKind {
  const text = `${workbench.step} ${workbench.instruction}`.toLowerCase();
  if (text.includes('qr')) return 'qr';
  if (text.includes('склад')) return 'handover';
  if (text.includes('биг-бег') || text.includes('вес') || text.includes('шпул')) return 'scale';
  if (workbench.blockingReason) return 'stop';
  return 'roll';
}

function operatorCompactActionLabel(action: ActionDescriptor) {
  const compactLabels: Record<string, string> = {
    'operator-accept-order': 'Принять',
    'operator-spool-weight': 'Шпуля',
    'operator-roll-weight': 'Вес',
    'operator-reweigh-roll': 'Перевзвесить',
    'operator-step-back-spool-weight': 'Назад к шпуле',
    'operator-step-back-roll-weight': 'Назад к рулону',
    'operator-print-qr': 'Печать QR',
    'operator-verify-qr': 'Скан QR',
    'operator-handover': 'На склад',
    'operator-resume-order': 'Возобновить',
    'operator-defect': 'Взвесить брак',
    'operator-defer-order': 'Отложить',
    'operator-problem': 'Проблема',
    'operator-history': 'История',
    'operator-next-order': 'К следующему',
  };

  return compactLabels[action.id] ?? actionDisplayLabel(action);
}

function operatorPendingActionLabel(action: ActionDescriptor) {
  if (action.id.startsWith('operator-step-back-')) return 'Возвращаем…';
  if (action.id === 'operator-reweigh-roll') return 'Перевзвешиваем…';
  return operatorCompactActionLabel(action);
}

function operatorQrStateLabel(roll: NonNullable<OperatorWorkbench['rollLines']>[number]) {
  if (roll.labelState === 'verified') return 'QR отсканирован';
  if (roll.labelState === 'submitted') return 'Задание печати отправлено';
  if (roll.labelState === 'printed') return 'Legacy-печать ждет скан';
  if (roll.labelState === 'applied') return 'QR наклеен';
  if (roll.labelState === 'not_printed') return 'QR не напечатан';
  return operatorRollQrWarehouseLabel(roll);
}

function operatorWarehouseStateLabel(roll: NonNullable<OperatorWorkbench['rollLines']>[number]) {
  if (roll.warehouseState === 'sent') return 'Передан';
  if (roll.warehouseState === 'received') return 'Принят складом';
  if (roll.warehouseState === 'delivered') return 'Выдан';
  if (roll.warehouseState === 'ready_for_handover') return 'Готов к передаче';
  return 'Не готов';
}

function operatorRollWeightStatus(
  roll: NonNullable<OperatorWorkbench['rollLines']>[number],
  group: NonNullable<OperatorWorkbench['rollGroups']>[number] | undefined,
  signalValue?: string,
) {
  const factValue = roll.actualNetKg ?? roll.netKg;
  const grossValue =
    roll.grossKg ??
    (factValue && roll.spoolKg ? Number((factValue + roll.spoolKg).toFixed(1)) : undefined);
  const factLabel = factValue ? `${factValue} кг` : 'Факт ждет';
  const spoolLabel = roll.spoolKg ? `шпуля ${roll.spoolKg} кг` : 'шпуля ждет';
  const signalLabel = signalValue?.toLowerCase().includes('стабиль')
    ? 'Стабильный сигнал'
    : (signalValue ?? 'Сигнал по шагу');

  return {
    plan: `${roll.plannedNetKg} кг`,
    fact: factLabel,
    detail: `${spoolLabel} · ±${group?.tolerancePercent ?? 2}%`,
    signal: factValue ? operatorToleranceLabel(roll) : signalLabel,
    facts: [
      { label: 'план', value: operatorKgLabel(roll.plannedNetKg) },
      { label: 'шпуля', value: operatorKgLabel(roll.spoolKg) },
      { label: 'брутто', value: operatorKgLabel(grossValue) },
      { label: 'нетто', value: operatorKgLabel(factValue) },
    ],
  };
}

function OperatorLiveScaleGauge({ workbench }: { workbench: OperatorWorkbench }) {
  const currentRoll = workbench.currentRoll;
  const isSpoolStep = Boolean(currentRoll?.spoolScaleActivated && !currentRoll.rollScaleActivated);
  const isRollStep = Boolean(currentRoll?.rollScaleActivated);
  const shouldShow =
    workbench.stageSignal?.kind === 'scale' && Boolean(currentRoll) && (isSpoolStep || isRollStep);
  const [tick, setTick] = useState(isSpoolStep ? 12 : 0);
  const isLiveScale = isLiveContour('operator');
  const [liveReading, setLiveReading] = useState<OperatorScaleReading | null>(null);
  const spoolKg = currentRoll?.spoolKg ?? 0;
  const targetNetKg = isSpoolStep ? 0 : (currentRoll?.plannedNetKg ?? 0);
  const targetGrossKg = targetNetKg + spoolKg;
  const reading = useMemo(() => {
    if (isLiveScale) {
      // Live: показания РЕАЛЬНЫХ весов поста через gateway (поллинг ниже).
      if (!liveReading || liveReading.status !== 'ready') {
        return { gross: 0, net: 0, deviation: 0, stable: false, offline: Boolean(liveReading) };
      }
      if (isSpoolStep) {
        return {
          gross: Math.max(0, liveReading.grossKg),
          net: 0,
          deviation: 0,
          stable: liveReading.stable,
          offline: false,
        };
      }
      return calculateOperatorScaleReading({
        grossKg: liveReading.grossKg,
        spoolKg,
        plannedNetKg: targetNetKg,
        stable: liveReading.stable,
      });
    }
    if (isSpoolStep) {
      return { gross: spoolKg, net: 0, deviation: 0, stable: true, offline: false };
    }

    const progress = Math.min(1, tick / 12);
    const ramp = targetGrossKg - 2.4 + 2.4 * progress;
    const jitter = Math.sin(tick * 1.7) * (progress < 1 ? 0.22 : 0.04);
    const gross = Number((ramp + jitter).toFixed(1));
    const net = Number(Math.max(0, gross - spoolKg).toFixed(1));
    const deviation =
      targetNetKg > 0 ? Number((((net - targetNetKg) / targetNetKg) * 100).toFixed(1)) : 0;

    return { gross, net, deviation, stable: tick >= 12, offline: false };
  }, [isLiveScale, liveReading, isSpoolStep, spoolKg, targetGrossKg, targetNetKg, tick]);

  useEffect(() => {
    if (!shouldShow || !isLiveScale) {
      setLiveReading(null);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      fetchOperatorScaleReading(isSpoolStep ? 'spool' : 'roll')
        .then((value) => {
          if (!cancelled) setLiveReading(value);
        })
        .catch(() => {
          if (!cancelled)
            setLiveReading({
              deviceId: '',
              kind: isSpoolStep ? 'spool' : 'roll',
              status: 'offline',
              stable: false,
              grossKg: 0,
              at: '',
            });
        });
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [shouldShow, isLiveScale, isSpoolStep]);

  useEffect(() => {
    if (!shouldShow) {
      setTick(0);
      return undefined;
    }
    if (isSpoolStep) {
      setTick(12);
      return undefined;
    }

    const interval = window.setInterval(() => {
      setTick((value) => (value >= 18 ? 12 : value + 1));
    }, 240);

    return () => window.clearInterval(interval);
  }, [isSpoolStep, shouldShow]);

  if (!shouldShow) return null;

  const waitingLive = isLiveScale && !liveReading;
  return (
    <OperatorScalePreview
      rollCode={currentRoll?.id ?? ''}
      grossKg={reading.gross}
      spoolKg={spoolKg}
      plannedNetKg={targetNetKg}
      stable={reading.stable}
      offline={reading.offline}
      waiting={waitingLive}
      isSpoolStep={isSpoolStep}
      sourceLabel={isLiveScale ? 'весы поста' : undefined}
      showRollCode={false}
    />
  );
}

export function OperatorShiftStrip({
  runtime,
  draft,
  onDraftChange,
  onAction,
  onOpenShift,
}: {
  runtime: OperatorRuntimeState;
  draft?: BigBagWeightDraft;
  onDraftChange?: (draft: BigBagWeightDraft) => void;
  onAction?: (actionId: string) => void;
  onOpenShift?: () => void;
}) {
  const shift = runtime.shift;
  const openOrders = runtime.orders.filter((order) => order.status !== 'warehouse').length;
  const deferredOrders = runtime.orders.filter((order) => order.status === 'deferred').length;
  const isBlocked = shift.status !== 'active';
  const weightDraft = draft ?? { startKg: '', endKg: '' };
  const startDraftKg = parseManualKg(weightDraft.startKg);
  const isStartDraftInvalid = weightDraft.startKg.trim().length > 0 && startDraftKg === null;
  const actionLabel =
    shift.status === 'start_missing'
      ? 'Открыть смену'
      : shift.status === 'close_pending'
        ? 'Сдать смену'
        : shift.status === 'closed'
          ? 'Смена'
          : 'Смена';

  return (
    <section
      className={`operator-shift-strip shift-${shift.status} ${isBlocked ? 'is-blocking' : ''}`}
      aria-label="Статус смены"
    >
      <div className="operator-shift-strip-status">
        <ix-icon name="capacity-check" size="24" />
        <div>
          <strong>{operatorShiftStatusLabel(shift.status)}</strong>
          <span>
            {shift.status === 'active'
              ? `${shift.bigBagId} · старт ${shift.startKg} кг`
              : (operatorShiftBlockerText(shift) ?? shift.bigBagId)}
          </span>
        </div>
      </div>
      <div className="operator-shift-strip-facts" aria-label="Коротко по смене">
        <span>
          <b>{openOrders}</b> активных
        </span>
        <span>
          <b>{deferredOrders}</b> отложен
        </span>
        <span>
          {shift.plannedShortageKg && shift.plannedShortageKg > 0 ? (
            <>
              <b>{shift.plannedShortageKg}</b> кг нужно добавить
            </>
          ) : (
            <>
              <b>{shift.expectedEndKg}</b> кг остаток
            </>
          )}
        </span>
      </div>
      <button type="button" className="operator-shift-strip-button" onClick={onOpenShift}>
        {actionLabel}
      </button>
      <div className="operator-shift-strip-rule" aria-label="Правило ручного ввода Big-bag">
        <span>
          {shift.bigBagQrCode ?? shift.bigBagId}: физически взвесили, вручную ввели, audit
          обязателен.
        </span>
      </div>
      {shift.status === 'start_missing' && (
        <div className={`operator-shift-strip-inline ${isStartDraftInvalid ? 'has-error' : ''}`}>
          <label htmlFor="bigbag-start-weight">
            <span>Стартовый вес Big-bag</span>
            <input
              id="bigbag-start-weight"
              type="number"
              inputMode="decimal"
              min="0.1"
              step="0.1"
              value={weightDraft.startKg}
              onChange={(event) => onDraftChange?.({ ...weightDraft, startKg: event.target.value })}
              placeholder="700"
              aria-invalid={isStartDraftInvalid}
            />
          </label>
          <ActionPanel
            actions={[
              startDraftKg !== null
                ? {
                    id: `operator-start-bigbag:${startDraftKg}`,
                    label: 'Зафиксировать вес',
                    level: 'recommended',
                    enabled: true,
                  }
                : {
                    id: 'operator-start-bigbag-disabled',
                    label: 'Зафиксировать вес',
                    level: 'disabled',
                    enabled: false,
                    disabledReason: isStartDraftInvalid
                      ? 'Введите число больше 0'
                      : 'Введите стартовый вес Big-bag',
                    recoveryOwner: 'Оператор',
                    recoveryAction: 'Взвесить Big-bag физически и ввести значение в кг',
                  },
            ]}
            variant="default"
            embedded
            className="shift-actions"
            onAction={onAction}
          />
        </div>
      )}
    </section>
  );
}

export function OperatorShiftListSummary({ runtime }: { runtime: OperatorRuntimeState }) {
  const shift = runtime.shift;
  return (
    <div className="operator-shift-list-summary" aria-label="Смена оператора">
      <div className={`shift-list-signal severity-${operatorShiftSeverity(shift.status)}`}>
        <ix-icon name="capacity-check" size="24" />
        <div>
          <span>Смена</span>
          <strong>{operatorShiftStatusLabel(shift.status)}</strong>
        </div>
      </div>
      {operatorShiftBlockerText(shift) && (
        <div className="shift-list-blocker">
          <strong>{operatorShiftBlockerText(shift)}</strong>
          <span>{operatorShiftRecoveryText(shift)}</span>
        </div>
      )}
    </div>
  );
}

export function OperatorMachineChangePanel({
  change,
  busy = false,
  onFinalize,
}: {
  change: OperatorMachineChangeView | null;
  busy?: boolean;
  onFinalize?: (bigBagId?: string) => void;
}) {
  if (!change || change.status === 'completed' || change.status === 'cancelled') return null;

  const awaitingWeight =
    change.status === 'awaiting_final_weight' || change.pendingBigBags.length > 0;

  return (
    <section
      className="operator-machine-change-panel severity-warning"
      aria-label="Переход на другой станок"
    >
      <header>
        <div>
          <span className="eyebrow">Особый режим · смена станка</span>
          <h2>
            {change.fromPost.code} → {change.toPost.code}
          </h2>
        </div>
        <strong>{awaitingWeight ? 'Нужен конечный вес' : 'Готово к переходу'}</strong>
      </header>
      <p>Причина: {change.reason}. Производственная очередь сохранена и остаётся доступной ниже.</p>

      {awaitingWeight ? (
        <div className="operator-machine-change-bags">
          <div>
            <strong>Зафиксируйте конечный вес Big-Bag</strong>
            <small>По очереди завершите каждый открытый мешок на текущем посту.</small>
          </div>
          <ul>
            {change.pendingBigBags.map((bag) => (
              <li key={bag.id}>
                <span>
                  <strong>{bag.code}</strong>
                  <small>конечный вес с весов {change.fromPost.code}</small>
                </span>
                <button
                  type="button"
                  className="action-recommended"
                  disabled={busy || !onFinalize}
                  onClick={() => onFinalize?.(bag.id)}
                >
                  Зафиксировать вес
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="operator-machine-change-ready">
          <div>
            <strong>Начните работу на {change.toPost.name}</strong>
            <small>
              После подтверждения назначение и незавершённая очередь перейдут на{' '}
              {change.toPost.code}.
            </small>
          </div>
          <button
            type="button"
            className="action-recommended"
            disabled={busy || !onFinalize}
            onClick={() => onFinalize?.()}
          >
            Продолжить на {change.toPost.code}
          </button>
        </div>
      )}
    </section>
  );
}

export function OperatorShiftSurface({
  runtime,
  draft,
  onDraftChange,
  onAction,
  onBackToOrders,
  bigBags,
  onReleaseBag,
  breakdownPending,
  breakdownError,
  breakdownSuccessVersion,
  pendingActionId,
}: {
  runtime: OperatorRuntimeState;
  draft?: BigBagWeightDraft;
  onDraftChange?: (draft: BigBagWeightDraft) => void;
  onAction?: (actionId: string) => void;
  onBackToOrders?: () => void;
  bigBags?: OperatorBigBagPickerOption[];
  onReleaseBag?: (bagId: string, input: { endKg: number }) => Promise<void> | void;
  breakdownPending?: boolean;
  breakdownError?: string | null;
  breakdownSuccessVersion?: number;
  pendingActionId?: string | null;
}) {
  const shift = runtime.shift;

  return (
    <article className="operator-shift-surface" aria-label="Личный кабинет смены">
      <header className="shift-surface-header">
        <div className="workbench-visual-row">
          <StepIllustration
            kind={shift.status === 'closed' ? 'roll' : 'scale'}
            label={`Смена оператора: ${operatorShiftStatusLabel(shift.status)}`}
            tone={operatorShiftSeverity(shift.status)}
          />
          <div>
            <span className="eyebrow">
              {shift.operatorName} · {shift.workplace}
            </span>
            <h2>{operatorShiftStatusLabel(shift.status)}</h2>
          </div>
        </div>
        {shift.status !== 'start_missing' && (
          <button type="button" className="secondary-button" onClick={onBackToOrders}>
            К заказам
          </button>
        )}
      </header>
      <div className="shift-surface-grid">
        <OperatorShiftPanel
          runtime={runtime}
          draft={draft}
          onDraftChange={onDraftChange}
          onAction={onAction}
          bigBags={bigBags}
          onReleaseBag={onReleaseBag}
          breakdownPending={breakdownPending}
          breakdownError={breakdownError}
          breakdownSuccessVersion={breakdownSuccessVersion}
          pendingActionId={pendingActionId}
        />
      </div>
    </article>
  );
}

function operatorStageSignalIcon(kind: NonNullable<OperatorWorkbench['stageSignal']>['kind']) {
  const icons: Record<NonNullable<OperatorWorkbench['stageSignal']>['kind'], string> = {
    scale: 'capacity-check',
    qr: 'qr-code',
    handover: 'truck',
    shift: 'capacity-check',
    order: 'tasks-open',
  };
  return icons[kind];
}

function OperatorStageSignalView({
  signal,
}: {
  signal: NonNullable<OperatorWorkbench['stageSignal']>;
}) {
  return (
    <div
      className={`operator-stage-signal signal-${signal.kind} severity-${signal.severity}`}
      aria-label={`${signal.title}: ${signal.value}`}
    >
      <div className="stage-signal-main">
        <ix-icon name={operatorStageSignalIcon(signal.kind)} size="32" />
        <div>
          <span>{signal.title}</span>
          <strong>{signal.value}</strong>
        </div>
      </div>
      <div className="stage-signal-facts">
        {signal.facts.map((fact) => (
          <div
            key={`${fact.label}-${fact.value}`}
            className={`severity-${fact.severity ?? 'info'}`}
          >
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperatorShiftPanel({
  runtime,
  draft,
  onDraftChange,
  onAction,
  bigBags,
  onReleaseBag,
  breakdownPending,
  breakdownError,
  breakdownSuccessVersion,
  pendingActionId,
}: {
  runtime: OperatorRuntimeState;
  draft?: BigBagWeightDraft;
  onDraftChange?: (draft: BigBagWeightDraft) => void;
  onAction?: (actionId: string) => void;
  bigBags?: OperatorBigBagPickerOption[];
  onReleaseBag?: (bagId: string, input: { endKg: number }) => Promise<void> | void;
  breakdownPending?: boolean;
  breakdownError?: string | null;
  breakdownSuccessVersion?: number;
  pendingActionId?: string | null;
}) {
  const shift = runtime.shift;
  const weightDraft = draft ?? { startKg: '', endKg: '' };
  const [bagQuery, setBagQuery] = useState('');
  const [addBagQuery, setAddBagQuery] = useState('');
  const liveBags = shift.bags ?? [];
  const activeLiveBags = liveBags.filter((bag) => bag.active);
  const isLivePicker = Boolean(bigBags);
  const selectedBag = bigBags?.find((bag) => bag.id === weightDraft.selectedBagId);
  const selectedBagKg = selectedBag ? canonicalBigBagKg(selectedBag) : null;
  const visibleBags = (bigBags ?? []).filter((bag) => {
    const query = bagQuery.trim().toLowerCase();
    if (!query) return true;
    return bag.code.toLowerCase().includes(query) || bag.material.toLowerCase().includes(query);
  });
  const visibleAddBags = (bigBags ?? []).filter((bag) => {
    if (bag.status !== 'available') return false;
    const query = addBagQuery.trim().toLowerCase();
    if (!query) return true;
    return bag.code.toLowerCase().includes(query) || bag.material.toLowerCase().includes(query);
  });
  // Финальный вес может быть 0 (мешок израсходован полностью) — parseManualKg тут не годится.
  const parseFinalKg = (raw: string): number | null => {
    const value = Number(raw.trim().replace(',', '.'));
    return raw.trim().length > 0 && Number.isFinite(value) && value >= 0 ? value : null;
  };
  const liveCloseEntries = activeLiveBags.map((bag) => ({
    bag,
    value: weightDraft.bagEndKg?.[bag.bagId] ?? '',
    parsed: parseFinalKg(weightDraft.bagEndKg?.[bag.bagId] ?? ''),
  }));
  const liveCloseReady =
    activeLiveBags.length > 0 && liveCloseEntries.every((entry) => entry.parsed !== null);
  const addKgParsed = parseManualKg(weightDraft.addKg ?? '');
  const addReady = Boolean(weightDraft.addBagId) && addKgParsed !== null;
  const startDraftKg = parseManualKg(weightDraft.startKg);
  const endDraftKg = parseManualKg(weightDraft.endKg);
  const isStartDraftInvalid = weightDraft.startKg.trim().length > 0 && startDraftKg === null;
  const isEndDraftInvalid = weightDraft.endKg.trim().length > 0 && endDraftKg === null;
  const defectBags = operatorShiftDefectBags(shift);
  const defectBagReady = defectBags.length > 0 && !hasDefectBagDraft(weightDraft) &&
    defectBags.every((bag) => bag.weightKg === 0 || ['ready_for_warehouse', 'received', 'shipped'].includes(bag.status));
  const bigBagCloseReady = isLivePicker
    ? activeLiveBags.length === 0 || liveCloseReady
    : shift.endKg !== undefined;
  const shiftReadyToClose =
    shift.status === 'close_pending' && defectBagReady && bigBagCloseReady;
  const closeDisabledReason = !bigBagCloseReady
    ? isLivePicker
      ? 'Введите финальный вес каждого использованного мешка'
      : 'Нет финального веса Big-bag'
    : 'Завершите ввод и печать всех мешков брака';
  const closeRecoveryAction = !bigBagCloseReady
    ? isLivePicker
      ? 'Взвесить каждый Big-bag и ввести значения'
      : 'Зафиксировать финальный вес Big-bag'
    : 'Сохраните или уберите черновик, напечатайте все этикетки';
  if (shift.status === 'scheduled') {
    return (
      <section
        className="surface operator-shift-panel shift-scheduled"
        aria-label="Запланированная смена"
      >
        <div className="shift-panel-head">
          <div>
            <span className="eyebrow">Следующая смена</span>
            <h3>Смена запланирована</h3>
          </div>
          <span className="commercial-state-badge state-info">Запланирована</span>
        </div>
        <div className="shift-summary-strip">
          <div>
            <span>Рабочее место</span>
            <strong>{shift.workplace}</strong>
          </div>
          <div>
            <span>Начало</span>
            <strong>{operatorShiftDateTimeLabel(shift.plannedStartAt)}</strong>
          </div>
          <div>
            <span>Окончание</span>
            <strong>{operatorShiftDateTimeLabel(shift.plannedEndAt)}</strong>
          </div>
        </div>
        <div className="shift-scheduled-note" role="status">
          Пост уже назначен. Выбор Big-bag и открытие смены станут доступны с начала планового окна.
        </div>
      </section>
    );
  }
  const statusLabel =
    shift.status === 'active'
      ? 'Смена открыта'
      : shift.status === 'bag_missing'
        ? 'Нужен Big-Bag'
        : shift.status === 'closed'
          ? 'Смена закрыта'
          : shift.status === 'close_pending'
            ? 'Сдача смены'
            : 'Нужен старт';
  const shiftContext =
    shift.status === 'close_pending'
      ? { label: 'Финальный вес', value: shift.endKg ? `${shift.endKg} кг` : 'Не введен' }
      : shift.status === 'start_missing'
        ? { label: 'Стартовый вес', value: shift.startKg ? `${shift.startKg} кг` : 'Не введен' }
        : shift.status === 'bag_missing'
          ? { label: 'Big-Bag', value: 'Не подключён' }
          : shift.status === 'active'
            ? { label: 'Стартовый вес', value: shift.startKg ? `${shift.startKg} кг` : 'Не введен' }
            : { label: 'Отклонение', value: `${shift.deviationPercent ?? 0}%` };
  const shiftActions: ActionDescriptor[] =
    shift.status === 'start_missing'
      ? isLivePicker && !selectedBag
        ? [
            {
              id: 'operator-start-bigbag-disabled',
              label: 'Открыть смену',
              level: 'disabled',
              enabled: false,
              disabledReason: 'Выберите Big-bag из списка склада',
              recoveryOwner: 'Оператор',
              recoveryAction: 'Выбрать мешок, взвесить и ввести стартовый вес',
            },
          ]
        : startDraftKg !== null
          ? [
              {
                id: `operator-start-bigbag:${startDraftKg}`,
                label: isLivePicker ? 'Открыть смену' : 'Зафиксировать вес',
                level: 'recommended',
                enabled: true,
                helpText: 'Ручной ввод разрешен только для Big-bag после физического взвешивания.',
              },
            ]
          : [
              {
                id: 'operator-start-bigbag-disabled',
                label: 'Зафиксировать вес',
                level: 'disabled',
                enabled: false,
                disabledReason: isStartDraftInvalid
                  ? 'Введите число больше 0'
                  : 'Введите стартовый вес Big-bag',
                recoveryOwner: 'Оператор',
                recoveryAction: 'Взвесить Big-bag физически и ввести значение в кг',
              },
            ]
      : shift.status === 'active' || shift.status === 'bag_missing'
        ? [
            {
              id: 'operator-close-shift-request',
              label: 'Сдать смену',
              level: 'recommended',
              enabled: true,
            },
          ]
        : shift.status === 'close_pending'
          ? !isLivePicker && shift.endKg === undefined
            ? [
                endDraftKg !== null
                  ? {
                      id: `operator-end-bigbag:${endDraftKg}`,
                      label: 'Зафиксировать вес',
                      level: 'recommended',
                      enabled: true,
                      helpText: 'Без финального веса смена не закрывается.',
                    }
                  : {
                      id: 'operator-end-bigbag-disabled',
                      label: 'Зафиксировать вес',
                      level: 'disabled',
                      enabled: false,
                      disabledReason: isEndDraftInvalid
                        ? 'Введите число больше 0'
                        : 'Введите финальный вес Big-bag',
                      recoveryOwner: 'Оператор',
                      recoveryAction: 'Взвесить Big-bag физически и ввести значение в кг',
                    },
                {
                  id: 'operator-close-shift-disabled',
                  label: 'Закрыть смену',
                  level: 'disabled',
                  enabled: false,
                  disabledReason: closeDisabledReason,
                  recoveryOwner: 'Оператор',
                  recoveryAction: closeRecoveryAction,
                },
              ]
            : shiftReadyToClose
              ? [
                {
                  id: 'operator-close-shift',
                  label: 'Сдать смену',
                  level: 'recommended',
                  enabled: true,
                  helpText: 'Финальный вес каждого мешка проверяется балансом сырья.',
                },
              ]
              : [
                  {
                    id: 'operator-close-shift-disabled',
                    label: 'Сдать смену',
                    level: 'disabled',
                    enabled: false,
                    disabledReason: closeDisabledReason,
                    recoveryOwner: 'Оператор',
                    recoveryAction: closeRecoveryAction,
                  },
                ]
          : [
                  {
                    id: 'operator-shift-history',
                    label: 'Открыть историю смены',
                    level: 'secondary',
                    enabled: true,
                  },
                ];
  const cancellableShiftActions =
    shift.status === 'close_pending'
      ? [
          ...shiftActions,
          {
            id: 'operator-close-shift-cancel',
            label: 'Отменить сдачу',
            level: 'secondary' as const,
            enabled: true,
          },
        ]
      : shiftActions;
  const shiftCloseSaving = pendingActionId === 'operator-close-shift';
  const shiftCloseUncertain = pendingActionId === 'operator-close-shift-uncertain';
  const displayedShiftActions =
    shiftCloseSaving || shiftCloseUncertain
      ? cancellableShiftActions.map(
          (action): ActionDescriptor =>
            action.id === 'operator-close-shift' || action.id === 'operator-close-shift-disabled'
              ? {
                  ...action,
                  id: shiftCloseUncertain ? 'operator-shift-verifying' : 'operator-shift-saving',
                  label: shiftCloseUncertain ? 'Статус сдачи проверяется' : 'Сохраняем смену…',
                  level: 'disabled',
                  enabled: false,
                  disabledReason: shiftCloseUncertain
                    ? 'Ждём подтверждение статуса'
                    : 'Итог смены сохраняется',
                }
              : action.id === 'operator-close-shift-cancel'
                ? {
                    ...action,
                    level: 'disabled',
                    enabled: false,
                    disabledReason: shiftCloseUncertain
                      ? 'Сначала дождитесь подтверждения статуса сдачи'
                      : 'Итог смены сохраняется',
                  }
                : action,
        )
      : cancellableShiftActions;
  const manualField =
    shift.status === 'start_missing'
      ? {
          id: 'bigbag-start-weight',
          label: 'Стартовый вес Big-bag',
          value: weightDraft.startKg,
          placeholder: '700',
          invalid: isStartDraftInvalid,
          onChange: (value: string) => onDraftChange?.({ ...weightDraft, startKg: value }),
        }
      : shift.status === 'close_pending' &&
          !isLivePicker &&
          shift.endKg === undefined &&
          activeLiveBags.length === 0
        ? {
            id: 'bigbag-end-weight',
            label: 'Финальный вес Big-bag',
            value: weightDraft.endKg,
            placeholder: '450',
            invalid: isEndDraftInvalid,
            onChange: (value: string) => onDraftChange?.({ ...weightDraft, endKg: value }),
          }
        : null;
  const manualFieldAction = manualField ? displayedShiftActions[0] : undefined;

  return (
    <section
      className={`surface operator-shift-panel shift-${shift.status}`}
      aria-label="Смена и Big-bag"
    >
      <div className="shift-panel-head">
        <div>
          <span className="eyebrow">Смена / Big-bag</span>
          <h3>{statusLabel}</h3>
        </div>
        <span
          className={`commercial-state-badge ${shift.status === 'active' || shiftReadyToClose ? 'state-ready' : shift.status === 'closed' ? 'state-done' : 'state-blocked'}`}
        >
          {shift.status === 'active'
            ? 'Открыта'
            : shift.status === 'closed'
              ? 'Закрыта'
              : shiftReadyToClose
                ? 'Готова'
                : 'Блокирует'}
        </span>
      </div>
      <div className="shift-summary-strip">
        <div>
          <span>Рабочее место</span>
          <strong>{shift.workplace}</strong>
        </div>
        <div>
          <span>Big-bag</span>
          <strong>
            {isLivePicker && shift.status === 'start_missing'
              ? (selectedBag?.code ?? 'Не выбран')
              : shift.status === 'bag_missing'
                ? 'Не подключён'
                : shift.bigBagId}
          </strong>
        </div>
        <div>
          <span>{shiftContext.label}</span>
          <strong>{shiftContext.value}</strong>
        </div>
        {isLivePicker && shift.status === 'start_missing' ? (
          <div>
            <span>Текущий вес</span>
            <strong>{selectedBagKg === null ? 'Нет данных' : `${selectedBagKg} кг`}</strong>
          </div>
        ) : (
          <div>
            <span>
              {shift.plannedShortageKg && shift.plannedShortageKg > 0
                ? 'Нужно добавить'
                : 'Ожидаемый остаток'}
            </span>
            <strong>
              {shift.plannedShortageKg && shift.plannedShortageKg > 0
                ? shift.plannedShortageKg
                : shift.expectedEndKg}{' '}
              кг
            </strong>
          </div>
        )}
      </div>
      <div className="manual-bigbag-rule" aria-label="Правило Big-bag">
        <ix-icon name="scale" size="16" />
        <span>
          {shift.status === 'bag_missing'
            ? 'Активный Big-Bag отсутствует: подключите следующий мешок или сдайте смену.'
            : `Big-bag ${shift.bigBagQrCode ?? shift.bigBagId}: ручной ввод после физического взвешивания; последний актор ${shift.lastActorLabel ?? shift.enteredBy ?? 'не указан'}.`}
        </span>
      </div>
      {isLivePicker && (liveBags.length > 0 || shift.status === 'bag_missing') ? (
        <OperatorActiveBigBagPanel bags={liveBags} onRelease={onReleaseBag} />
      ) : null}
      {shift.status === 'start_missing' && isLivePicker && (
        <div className="bigbag-picker" aria-label="Выбор Big-bag со склада">
          <label htmlFor="bigbag-picker-search">
            <span>Поиск по названию или сырью</span>
            <input
              id="bigbag-picker-search"
              type="search"
              value={bagQuery}
              onChange={(event) => setBagQuery(event.target.value)}
              placeholder="BB-15803 или ПВД"
            />
          </label>
          <div className="bigbag-picker-cards" role="listbox" aria-label="Доступные Big-bag">
            {visibleBags.map((bag) => {
              const selected = weightDraft.selectedBagId === bag.id;
              const available = bag.status === 'available';
              const weight = canonicalBigBagKg(bag);
              return (
                <button
                  key={bag.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`bigbag-card ${selected ? 'is-selected' : ''} ${available ? '' : 'is-unavailable'}`}
                  disabled={!available}
                  onClick={() => {
                    onDraftChange?.({
                      ...weightDraft,
                      selectedBagId: bag.id,
                      ...(weight === null ? {} : { startKg: String(weight) }),
                    });
                  }}
                >
                  <strong>{bag.code}</strong>
                  <span>{bag.material}</span>
                  <span>{weight === null ? 'вес не указан' : `${weight} кг`}</span>
                  <em>{available ? 'Доступен' : 'Недоступен'}</em>
                </button>
              );
            })}
            {visibleBags.length === 0 && (
              <span className="bigbag-picker-empty">Мешков не найдено</span>
            )}
          </div>
        </div>
      )}
      {shift.status === 'close_pending' && activeLiveBags.length > 0 && (
        <div className="bigbag-close-list" aria-label="Финальные веса мешков смены">
          {liveCloseEntries.map(({ bag, value, parsed }) => (
            <div
              key={bag.bagId}
              className={`manual-bigbag-row ${value.trim().length > 0 && parsed === null ? 'has-error' : ''}`}
            >
              <label htmlFor={`bigbag-end-${bag.bagId}`}>
                <span>
                  {bag.code} · старт {bag.startKg} кг{bag.addedReason ? ' · добавлен' : ''}
                </span>
                <input
                  id={`bigbag-end-${bag.bagId}`}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.1"
                  value={value}
                  placeholder="450"
                  aria-invalid={value.trim().length > 0 && parsed === null}
                  onChange={(event) =>
                    onDraftChange?.({
                      ...weightDraft,
                      bagEndKg: {
                        ...(weightDraft.bagEndKg ?? {}),
                        [bag.bagId]: event.target.value,
                      },
                    })
                  }
                />
              </label>
            </div>
          ))}
        </div>
      )}
      <OperatorDefectBagsPanel shift={shift} draft={weightDraft} onDraftChange={onDraftChange} onAction={onAction} pendingActionId={pendingActionId} />
      {(shift.status === 'active' || shift.status === 'bag_missing') && isLivePicker && (
        <details className="disclosure-context bigbag-add">
          <summary>Добавить Big-bag</summary>
          <div className="bigbag-add-form">
            <div className="bigbag-add-picker">
              <label htmlFor="bigbag-add-search">
                <span>Big-Bag</span>
                <input
                  id="bigbag-add-search"
                  type="search"
                  value={addBagQuery}
                  onChange={(event) => setAddBagQuery(event.target.value)}
                  placeholder="Найти по коду или сырью"
                />
              </label>
              <div
                className="bigbag-add-options"
                role="listbox"
                aria-label="Доступные Big-Bag для добавления"
              >
                {visibleAddBags.map((bag) => {
                  const selected = weightDraft.addBagId === bag.id;
                  const weight = canonicalBigBagKg(bag);
                  return (
                    <button
                      key={bag.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`bigbag-add-option ${selected ? 'is-selected' : ''}`}
                      onClick={() =>
                        onDraftChange?.({
                          ...weightDraft,
                          addBagId: bag.id,
                          ...(weight === null ? {} : { addKg: String(weight) }),
                        })
                      }
                    >
                      <span>
                        <strong>{bag.code}</strong>
                        <small>{bag.material}</small>
                      </span>
                      <em>{weight != null ? `${weight} кг` : 'Вес не указан'}</em>
                    </button>
                  );
                })}
                {visibleAddBags.length === 0 ? (
                  <span className="bigbag-picker-empty">Доступных Big-Bag не найдено</span>
                ) : null}
              </div>
            </div>
            <div className="bigbag-add-controls">
              <label htmlFor="bigbag-add-weight">
                <span>Стартовый вес, кг</span>
                <input
                  id="bigbag-add-weight"
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  step="0.1"
                  value={weightDraft.addKg ?? ''}
                  onChange={(event) =>
                    onDraftChange?.({ ...weightDraft, addKg: event.target.value })
                  }
                  placeholder="300"
                />
              </label>
              <button
                type="button"
                className="compact-action-button manual-bigbag-action action-recommended"
                disabled={!addReady}
                title={addReady ? undefined : 'Выберите Big-Bag и укажите стартовый вес'}
                onClick={() =>
                  addKgParsed !== null && onAction?.(`operator-add-bigbag:${addKgParsed}`)
                }
              >
                <ix-icon name="add" size="24" />
                <span>Добавить в смену</span>
              </button>
            </div>
          </div>
        </details>
      )}
      {manualField && (
        <div className={`manual-bigbag-row ${manualField.invalid ? 'has-error' : ''}`}>
          <label htmlFor={manualField.id}>
            <span>{manualField.label}</span>
            <input
              id={manualField.id}
              type="number"
              inputMode="decimal"
              min="0.1"
              step="0.1"
              value={manualField.value}
              onChange={(event) => manualField.onChange(event.target.value)}
              placeholder={manualField.placeholder}
              aria-invalid={manualField.invalid}
            />
          </label>
          {manualFieldAction && (
            <button
              type="button"
              className={`compact-action-button manual-bigbag-action action-${manualFieldAction.level}`}
              disabled={!manualFieldAction.enabled}
              onClick={() => onAction?.(manualFieldAction.id)}
              title={
                manualFieldAction.enabled
                  ? undefined
                  : (manualFieldAction.disabledReason ?? manualFieldAction.recoveryAction)
              }
              aria-label={actionDisplayLabel(manualFieldAction)}
            >
              <ix-icon name={actionIcon(manualFieldAction)} size="16" />
              <span>{actionDisplayLabel(manualFieldAction)}</span>
            </button>
          )}
        </div>
      )}
      {shift.status === 'closed' && Math.abs(shift.deviationPercent ?? 0) > 2 && (
        <IxMessageBar type="critical">
          Отклонение расхода Big-bag больше 2%. Создается проблема для зав. производства и
          директора.
        </IxMessageBar>
      )}
      {!manualField && (
        <ActionPanel
          actions={displayedShiftActions}
          variant="large"
          embedded
          className="shift-actions"
          onAction={onAction}
        />
      )}
      {(shift.status === 'active' || shift.status === 'bag_missing') && (
        <details className="disclosure-context operator-machine-breakdown">
          <summary>Станок сломался</summary>
          <MachineBreakdownForm
            onSubmit={(input) => onAction?.(operatorMachineBreakdownAction(input))}
            pending={breakdownPending}
            error={breakdownError}
            successVersion={breakdownSuccessVersion}
          />
        </details>
      )}
    </section>
  );
}

export function OperatorWorkbenchView({
  workbench,
  actions,
  onAction,
  pendingActionId,
  hideRollTable = false,
}: {
  workbench: OperatorWorkbench;
  actions: ActionDescriptor[];
  onAction?: (actionId: string) => void;
  pendingActionId?: string | null;
  hideRollTable?: boolean;
}) {
  const [qrScanPayload, setQrScanPayload] = useState('');
  const [commentOpen, setCommentOpen] = useState(false);
  const qrScanInputRef = useRef<HTMLInputElement>(null);
  const hasBlockingContext = Boolean(workbench.blockingReason || workbench.recovery);
  const illustrationTone = hasBlockingContext ? 'critical' : 'info';
  const groups = actionGroups(actions);
  const currentActions =
    groups.primary.length > 0 || groups.peer.length > 0
      ? [...groups.primary, ...groups.peer]
      : groups.disabled.slice(0, 1);
  const isStageCooldown = pendingActionId === 'operator-stage-cooldown';
  const hasPendingMutation = Boolean(pendingActionId) && !isStageCooldown;
  const gatedCurrentActions = currentActions.map((action) =>
    hasPendingMutation ||
    (isStageCooldown &&
      action.level === 'recommended' &&
      operatorStageCooldownBlocksAction(action.id))
      ? { ...action, enabled: false }
      : action,
  );
  const secondaryActions = [...groups.secondary, ...groups.destructive];
  const qrScanAction = currentActions.find(
    (action) => action.id === 'operator-verify-qr' && action.enabled,
  );

  useEffect(() => {
    if (!qrScanAction || typeof window === 'undefined') return;
    const frame = window.requestAnimationFrame(() => qrScanInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [qrScanAction, workbench.currentRoll?.id]);

  function dispatchAction(actionId: string) {
    if (actionId === 'operator-verify-qr' && qrScanAction) {
      qrScanInputRef.current?.focus();
      return;
    }
    onAction?.(actionId);
  }

  function submitQrScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = qrScanPayload.trim();
    if (!payload) return;
    onAction?.(operatorQrScanAction(payload));
    setQrScanPayload('');
    window.requestAnimationFrame(() => qrScanInputRef.current?.focus());
  }

  function captureQrScannerKey(event: KeyboardEvent<HTMLInputElement>) {
    const character = scannerAsciiFromPhysicalKey(event);
    if (character === null) return;
    event.preventDefault();
    setQrScanPayload((current) => `${current}${character}`);
  }
  const rollLines = workbench.rollLines ?? [];
  const currentRoll = workbench.currentRoll;
  const currentRollGroup = workbench.currentRollGroup;
  const currentNetKg = currentRoll?.actualNetKg ?? currentRoll?.netKg;
  const currentGrossKg =
    currentRoll?.grossKg ??
    (currentNetKg !== undefined && currentRoll?.spoolKg !== undefined
      ? Number((currentNetKg + currentRoll.spoolKg).toFixed(3))
      : undefined);
  const headlineNetKg = currentNetKg ?? currentRoll?.plannedNetKg;
  const hasRollEssentials = Boolean(currentRoll && currentRollGroup);
  const primaryRowAction =
    currentActions.find((action) => action.enabled && action.level === 'recommended') ??
    currentActions.find((action) => action.enabled);
  const disabledRowAction =
    workbench.currentRoll && !primaryRowAction
      ? currentActions.find((action) => !action.enabled)
      : undefined;
  const rowActionLabel = (roll: NonNullable<OperatorWorkbench['rollLines']>[number]) => {
    if (workbench.currentRoll?.id === roll.id)
      return primaryRowAction
        ? operatorCompactActionLabel(primaryRowAction)
        : operatorToleranceLabel(roll);
    if (['sent', 'received', 'delivered'].includes(roll.warehouseState)) return 'Закрыт';
    if (roll.sequenceNumber > (workbench.currentRoll?.sequenceNumber ?? 0))
      return 'Дальше по очереди';
    return operatorToleranceLabel(roll);
  };
  const normalizedInstruction = workbench.instruction.trim().toLowerCase();
  const normalizedStep = workbench.step.trim().toLowerCase();
  const showInstruction =
    normalizedInstruction.length > 0 &&
    normalizedInstruction !== normalizedStep &&
    !normalizedStep.includes(normalizedInstruction);
  const isScaleFloorStep = workbench.stageSignal?.kind === 'scale';
  const commercialComment = workbench.currentRollGroup?.commercialComment?.trim() || null;
  const positionComment = workbench.currentRollGroup?.comment?.trim() || null;
  const hasCommercialComment = Boolean(commercialComment || positionComment);
  const rollDimensions = currentRollGroup
    ? operatorRollDimensions(currentRollGroup)
    : { width: 'Не указана', length: 'Не указан' };
  const recipeDetails = currentRollGroup ? operatorRecipeDetails(currentRollGroup) : null;
  const orderMassRefreshKey = rollLines
    .map((roll) => `${roll.dispatchItemId}:${roll.updatedAt}`)
    .join('|');

  useEffect(() => {
    setCommentOpen(false);
  }, [workbench.currentRollGroup?.id]);

  return (
    <section
      className={`surface operator-terminal operator-table-terminal ${hasBlockingContext ? 'has-blocked-step' : ''}`}
      aria-label="Рабочий экран оператора"
    >
      {hasRollEssentials && currentRollGroup ? (
        <div className="operator-roll-essentials" aria-label="Параметры текущего рулона">
          <div className="operator-roll-product-summary">
            <span>Параметры рулона</span>
            <dl>
              <div data-parameter="roll-type">
                <dt>Тип рулона</dt>
                <dd>{operatorRollTypeLabel(currentRollGroup)}</dd>
              </div>
              <div data-parameter="actual-thickness">
                <dt>Факт. толщина</dt>
                <dd>{operatorActualThickness(currentRollGroup)}</dd>
              </div>
              <div data-parameter="accounting-thickness">
                <dt>Бух. толщина</dt>
                <dd>{operatorAccountingThickness(currentRollGroup)}</dd>
              </div>
              <div data-parameter="width">
                <dt>Ширина</dt>
                <dd>{rollDimensions.width}</dd>
              </div>
              <div data-parameter="length">
                <dt>Метраж</dt>
                <dd>{rollDimensions.length}</dd>
              </div>
              <div data-parameter="weight">
                <dt>Вес</dt>
                <dd>
                  {headlineNetKg !== undefined && headlineNetKg > 0
                    ? `${formatKg(headlineNetKg)} кг`
                    : 'Не указан'}
                </dd>
              </div>
              <div data-parameter="recipe">
                <dt>Рецептура</dt>
                <dd className="operator-roll-recipe-value">
                  <span className="operator-roll-recipe-name">
                    <span>{recipeDetails?.name ?? 'Не указана'}</span>
                    {recipeDetails?.version ? <small>{recipeDetails.version}</small> : null}
                  </span>
                  {recipeDetails?.ingredients.length ? (
                    <span
                      className="operator-roll-recipe-composition"
                      aria-label="Состав рецептуры"
                    >
                      {recipeDetails.ingredients.map((ingredient, index) => (
                        <span key={`${ingredient.name}-${ingredient.shareBasisPoints}-${index}`}>
                          {ingredient.name} ·{' '}
                          {operatorParameterNumber.format(ingredient.shareBasisPoints / 100)}%
                        </span>
                      ))}
                    </span>
                  ) : null}
                </dd>
              </div>
            </dl>
          </div>
          <div className="operator-roll-weight-summary" aria-label="Вес текущего рулона">
            <span>
              <span>Шпуля</span>
              <strong>{operatorKgLabel(currentRoll?.spoolKg)}</strong>
            </span>
            <span>
              <span>Брутто</span>
              <strong>{operatorKgLabel(currentGrossKg)}</strong>
            </span>
            <span>
              <span>Нетто</span>
              <strong>{operatorKgLabel(currentNetKg)}</strong>
            </span>
          </div>
        </div>
      ) : null}
      {workbench.orderCode ? (
        <OperatorOrderMassSummary
          orderNumber={workbench.orderCode}
          refreshKey={orderMassRefreshKey}
        />
      ) : null}
      <div className="operator-focus operator-focus-compact is-priority">
        <div className="terminal-main">
          <div className="workbench-visual-row">
            <StepIllustration
              kind={operatorIllustrationKind(workbench)}
              label={workbench.step}
              tone={illustrationTone}
            />
            <div>
              <span className="eyebrow">Текущий шаг</span>
              <h3>{workbench.step}</h3>
              {showInstruction ? (
                <p className="operator-step-instruction">{workbench.instruction}</p>
              ) : null}
            </div>
          </div>
          {workbench.stageSignal && (
            <div
              className={`operator-stage-signal severity-${workbench.stageSignal.severity}`}
              role="status"
            >
              <div className="stage-signal-main">
                <ix-icon name={operatorStageSignalIcon(workbench.stageSignal.kind)} size="24" />
                <div>
                  <strong>{workbench.stageSignal.value}</strong>
                </div>
              </div>
            </div>
          )}
          <OperatorLiveScaleGauge workbench={workbench} />
          {qrScanAction && (
            <form
              className="operator-qr-scan-form"
              aria-label="Проверка QR рулона"
              onSubmit={submitQrScan}
            >
              <label>
                <span>Сканирование наклеенного QR</span>
                <input
                  ref={qrScanInputRef}
                  value={qrScanPayload}
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  aria-label="Сканирование QR оператора"
                  placeholder="Считайте QR сканером"
                  onChange={(event) => setQrScanPayload(event.target.value)}
                  onKeyDown={captureQrScannerKey}
                />
              </label>
              <button type="submit" disabled={!qrScanPayload.trim()}>
                Проверить QR
              </button>
              <small>Значение берётся только из фактического ввода сканера.</small>
            </form>
          )}
        </div>
        <ActionPanel
          actions={gatedCurrentActions}
          title=""
          variant="large"
          embedded
          className="operator-current-actions"
          onAction={dispatchAction}
        />
        {hasCommercialComment ? (
          <button
            type="button"
            className="compact-action-button action-secondary operator-comment-trigger"
            aria-haspopup="dialog"
            onClick={() => setCommentOpen(true)}
          >
            Комментарий
          </button>
        ) : null}
      </div>
      {hideRollTable && secondaryActions.length > 0 && (
        <div
          className="operator-row-secondary-rail"
          aria-label="Дополнительные действия по текущему рулону"
        >
          {secondaryActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`operator-row-secondary-action action-${action.level}${action.id.startsWith('operator-step-back-') ? ' is-step-back' : ''}`}
              disabled={!action.enabled || hasPendingMutation}
              title={action.confirmation ?? action.helpText ?? action.disabledReason}
              aria-label={`${actionDisplayLabel(action)}${action.confirmation ? `. ${action.confirmation}` : ''}`}
              aria-busy={pendingActionId === action.id || undefined}
              onClick={() => dispatchAction(action.id)}
            >
              <ix-icon name={actionIcon(action)} size="16" />
              <span>
                {pendingActionId === action.id
                  ? operatorPendingActionLabel(action)
                  : operatorCompactActionLabel(action)}
              </span>
            </button>
          ))}
        </div>
      )}
      {!hideRollTable && rollLines.length > 0 && (
        <div
          className="operator-roll-table is-primary"
          role="table"
          aria-label="Рабочая таблица рулонов"
        >
          <div className="operator-panel-title">
            <span>Рулоны в работе</span>
            <small>
              {workbench.rollProgress.completed}/{workbench.rollProgress.total} закрыто · порядок
              зав. производства
            </small>
          </div>
          <div className="operator-roll-row is-head" role="row">
            <span role="columnheader">Рулон</span>
            <span role="columnheader">Параметры</span>
            <span role="columnheader">Вес</span>
            <span role="columnheader">Состояние</span>
            <span role="columnheader">Действие</span>
          </div>
          {rollLines.map((roll) => {
            const group = workbench.rollGroups?.find((item) => item.id === roll.groupId);
            const isCurrent = workbench.currentRoll?.id === roll.id;
            const rowAction = isCurrent ? primaryRowAction : undefined;
            const disabledAction = isCurrent ? disabledRowAction : undefined;
            const weight = operatorRollWeightStatus(
              roll,
              group,
              isCurrent ? workbench.stageSignal?.value : undefined,
            );

            return (
              <div
                key={roll.id}
                className={`operator-roll-row ${isCurrent ? 'is-current' : ''} severity-${operatorRollStatusSeverity(roll)}`}
                role="row"
                title={`${roll.id}: ${roll.status}`}
              >
                <span role="cell" data-label="Рулон" data-col="roll">
                  <strong>#{roll.sequenceNumber}</strong>
                  <small>
                    {roll.id} · {workbench.orderCode ?? 'заказ'}
                  </small>
                </span>
                <span role="cell" data-label="Параметры" data-col="params">
                  <strong>
                    {group?.filmType ?? 'пленка'} · {group?.micron ?? '-'}
                  </strong>
                  <small>
                    {group?.sizeMeters ?? '-'} · {operatorRollGroupLabel(group)} ·{' '}
                    {roll.recipeVersion}
                  </small>
                </span>
                <span
                  role="cell"
                  data-label="Вес"
                  data-col="weight"
                  className="operator-roll-weight-cell"
                >
                  <span className="operator-roll-weight-grid" aria-label="Весовые данные рулона">
                    {isCurrent && isScaleFloorStep && (
                      <span>
                        <small>Клавиатура</small>
                        <strong>Нет</strong>
                      </span>
                    )}
                    {weight.facts.map((fact) => (
                      <span key={fact.label}>
                        <small>{fact.label}</small>
                        <strong>{fact.value}</strong>
                      </span>
                    ))}
                  </span>
                  <em>
                    {weight.signal} · ±{group?.tolerancePercent ?? 2}%
                  </em>
                </span>
                <span
                  role="cell"
                  data-label="Состояние"
                  data-col="state"
                  className="operator-roll-state-cell"
                >
                  <strong>{operatorToleranceLabel(roll)}</strong>
                  <small>
                    <b>QR</b> {operatorQrStateLabel(roll)} ·{' '}
                    {qrDisplayLabel(roll.qrCode) ?? 'после печати'}
                  </small>
                  <em>
                    <b>Склад</b> {operatorWarehouseStateLabel(roll)} ·{' '}
                    {roll.warehouseState === 'ready_for_handover'
                      ? 'ждет передачи'
                      : roll.warehouseState === 'sent'
                        ? 'у склада'
                        : 'после QR'}
                  </em>
                </span>
                <span role="cell" data-label="Действие" data-col="action">
                  {rowAction ? (
                    <div className="operator-row-actions-stack">
                      <button
                        type="button"
                        className={`operator-roll-primary-action action-${rowAction.level}`}
                        aria-label={actionDisplayLabel(rowAction)}
                        disabled={
                          !rowAction.enabled ||
                          hasPendingMutation ||
                          (isStageCooldown && rowAction.level === 'recommended')
                        }
                        onClick={() => dispatchAction(rowAction.id)}
                      >
                        <ix-icon name={actionIcon(rowAction)} size="24" />
                        <span>{operatorCompactActionLabel(rowAction)}</span>
                      </button>
                      {secondaryActions.length > 0 && (
                        <div
                          className="operator-row-secondary-rail is-inline"
                          aria-label="Дополнительные действия по текущему рулону"
                        >
                          {secondaryActions.map((action) => (
                            <button
                              key={action.id}
                              type="button"
                              className={`operator-row-secondary-action action-${action.level}${action.id.startsWith('operator-step-back-') ? ' is-step-back' : ''}`}
                              disabled={!action.enabled || hasPendingMutation}
                              title={
                                action.confirmation ?? action.helpText ?? action.disabledReason
                              }
                              aria-label={`${actionDisplayLabel(action)}${action.confirmation ? `. ${action.confirmation}` : ''}`}
                              aria-busy={pendingActionId === action.id || undefined}
                              onClick={() => dispatchAction(action.id)}
                            >
                              <ix-icon name={actionIcon(action)} size="16" />
                              <span>
                                {pendingActionId === action.id
                                  ? operatorPendingActionLabel(action)
                                  : operatorCompactActionLabel(action)}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : disabledAction ? (
                    <div className="operator-row-actions-stack">
                      <button
                        type="button"
                        className={`operator-roll-primary-action is-disabled action-${disabledAction.level}`}
                        aria-label={actionDisplayLabel(disabledAction)}
                        disabled
                      >
                        <ix-icon name={actionIcon(disabledAction)} size="24" />
                        <span>{operatorCompactActionLabel(disabledAction)}</span>
                      </button>
                      <small className="operator-roll-action-blocker">
                        {disabledAction.disabledReason ?? 'действие недоступно'}
                        {disabledAction.recoveryAction ? ` · ${disabledAction.recoveryAction}` : ''}
                      </small>
                    </div>
                  ) : (
                    <>
                      <strong>{rowActionLabel(roll)}</strong>
                      <small>
                        {isCurrent
                          ? (workbench.recovery ?? 'ждет разрешения')
                          : 'без переключения заказа'}
                      </small>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {commentOpen && hasCommercialComment ? (
        <PlenkiModal
          title="Комментарий коммерции"
          className="operator-comment-modal"
          onClose={() => setCommentOpen(false)}
        >
          <div className="operator-comment-sections">
            {commercialComment ? (
              <section>
                <h4>Комментарий к заявке</h4>
                <p>{commercialComment}</p>
              </section>
            ) : null}
            {positionComment && positionComment !== commercialComment ? (
              <section>
                <h4>Комментарий к позиции</h4>
                <p>{positionComment}</p>
              </section>
            ) : null}
          </div>
        </PlenkiModal>
      ) : null}
    </section>
  );
}
