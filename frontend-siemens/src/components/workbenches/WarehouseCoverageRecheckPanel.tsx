import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import { IdempotentOperationGate } from '../../api/idempotentOperation';
import { warehouseCoverageApi } from '../../api/warehouse';
import {
  coverageReasonLabel,
  type ResolveWarehouseCoverageRecheckDto,
  type WarehouseCoverageCorrectionSpecView,
  type WarehouseCoverageFactCorrectionDto,
  type WarehouseCoverageRecheckItem,
  type WarehouseCoverageRecheckMemberView,
  type WarehouseCoverageView,
} from '../../domain/warehouseCoverage';

export interface WarehouseCoverageRecheckPanelProps {
  item: WarehouseCoverageRecheckItem;
  onResolved(caseId: string, result: WarehouseCoverageView): void;
}

type CorrectionSpecDraft = Omit<
  WarehouseCoverageCorrectionSpecView,
  'recipeVersionNumber' | 'ingredients' | 'widthMm' | 'plannedLengthM'
> & {
  widthMm: string;
  plannedLengthM: string;
  recipeVersionNumber: string;
  ingredientsText: string;
};

type MemberCorrectionDraft = {
  ownerCounterpartyId: string;
  spec: CorrectionSpecDraft;
};

type RecheckFeedback = {
  status: 'idle' | 'submitting' | 'error';
  message: string;
};

const EMPTY_SPEC_DRAFT: CorrectionSpecDraft = {
  filmType: '',
  actualThickness: '',
  accountingThickness: '',
  widthMm: '',
  plannedLengthM: '',
  birka: '',
  spoolType: '',
  actualWeightKg: '',
  plannedWeightKg: '',
  recipeId: null,
  recipeVersion: null,
  recipeDefinitionId: null,
  recipeDefinitionVersionId: null,
  recipeVersionNumber: '',
  ingredientsText: '',
};

export function WarehouseCoverageRecheckPanel({
  item,
  onResolved,
}: WarehouseCoverageRecheckPanelProps): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, MemberCorrectionDraft>>(() =>
    createMemberDrafts(item),
  );
  const [reason, setReason] = useState('');
  const [feedback, setFeedback] = useState<RecheckFeedback>({
    status: 'idle',
    message: '',
  });
  const operationGateRef = useRef(new IdempotentOperationGate());
  const busy = feedback.status === 'submitting';
  const correctionResult = useMemo(
    () => buildCorrections(item.members, drafts),
    [drafts, item.members],
  );
  const validationMessage = !reason.trim()
    ? 'Укажите причину исправления.'
    : correctionResult.error;

  useEffect(() => {
    setDrafts(createMemberDrafts(item));
    setReason('');
    setFeedback({ status: 'idle', message: '' });
  }, [item.caseId, item.caseVersion]);

  function updateDraft(
    membershipId: string,
    update: (current: MemberCorrectionDraft) => MemberCorrectionDraft,
  ) {
    if (busy) return;
    setDrafts((current) => ({
      ...current,
      [membershipId]: update(current[membershipId] ?? createMemberDraft()),
    }));
    setFeedback({ status: 'idle', message: '' });
  }

  async function submit() {
    if (busy || validationMessage) return;
    setFeedback({ status: 'submitting', message: 'Сохраняем перепроверку…' });
    const request = operationGateRef.current.start(
      `warehouse:coverage-recheck:${item.caseId}:${item.caseVersion}`,
      (clientRequestId) =>
        warehouseCoverageApi.resolve(item.caseId, {
          clientRequestId,
          expectedCaseVersion: item.caseVersion,
          expectedGeneration: item.generation,
          expectedStateVersion: item.stateVersion,
          reason: reason.trim(),
          corrections: correctionResult.corrections,
        } satisfies ResolveWarehouseCoverageRecheckDto),
    );
    if (!request) return;
    try {
      const result = await request;
      onResolved(item.caseId, result);
    } catch (error) {
      setFeedback({
        status: 'error',
        message:
          error instanceof Error
            ? error.message
            : 'Не удалось сохранить перепроверку. Обновите очередь и повторите.',
      });
    }
  }

  return (
    <section
      className="warehouse-coverage-recheck"
      aria-label={`Перепроверка покрытия ${item.caseId}`}
      aria-busy={busy}
      data-recheck-case-id={item.caseId}
    >
      <header className="warehouse-coverage-recheck-head">
        <div>
          <span className="eyebrow">Исключение V2</span>
          <h4>Перепроверка покрытия</h4>
        </div>
        <span>{item.members.length} рул.</span>
      </header>

      <div className="warehouse-coverage-recheck-reasons" aria-label="Причины перепроверки">
        {item.reasonCodes.map((code) => (
          <span key={code}>{coverageReasonLabel(code)}</span>
        ))}
      </div>

      <div className="warehouse-coverage-member-list">
        {item.members.map((member) => {
          const draft = drafts[member.membershipId] ?? createMemberDraft(member);
          return (
            <CoverageFactCorrectionRow
              key={member.membershipId}
              member={member}
              draft={draft}
              disabled={busy}
              onChange={(next) => updateDraft(member.membershipId, () => next)}
            />
          );
        })}
      </div>

      <label className="warehouse-coverage-resolution-reason">
        <span>Причина исправления</span>
        <textarea
          aria-label="Причина исправления"
          value={reason}
          maxLength={1000}
          disabled={busy}
          placeholder="Что проверено и на основании каких данных"
          onChange={(event) => {
            setReason(event.currentTarget.value);
            setFeedback({ status: 'idle', message: '' });
          }}
        />
      </label>

      <div className="warehouse-coverage-resolution-actions">
        <button
          type="button"
          className="action-recommended"
          disabled={busy || Boolean(validationMessage)}
          title={validationMessage ?? 'Сохранить исправления и вернуть расчёт в систему'}
          onClick={() => void submit()}
        >
          {busy ? 'Сохраняем перепроверку…' : 'Подтвердить перепроверку'}
        </button>
        {feedback.status === 'error' ? (
          <p className="warehouse-cover-feedback is-error" role="alert">
            {feedback.message}
          </p>
        ) : busy ? (
          <p className="warehouse-cover-feedback" role="status">
            {feedback.message}
          </p>
        ) : (
          <small>
            {validationMessage ??
              (correctionResult.corrections.length > 0
                ? 'Будут отправлены только изменённые факты.'
                : 'Исправлений нет — будет подтверждена физическая проверка.')}
          </small>
        )}
      </div>
    </section>
  );
}

function CoverageFactCorrectionRow({
  member,
  draft,
  disabled,
  onChange,
}: {
  member: WarehouseCoverageRecheckMemberView;
  draft: MemberCorrectionDraft;
  disabled: boolean;
  onChange: (draft: MemberCorrectionDraft) => void;
}) {
  function updateSpec<Key extends keyof CorrectionSpecDraft>(
    key: Key,
    value: CorrectionSpecDraft[Key],
  ) {
    onChange({ ...draft, spec: { ...draft.spec, [key]: value } });
  }

  return (
    <article className="warehouse-coverage-member" data-membership-id={member.membershipId}>
      <header>
        <span>
          <strong>{member.rollCode}</strong>
          <small>{sourceKindLabel(member.sourceKind)}</small>
        </span>
        <span className={member.ownerVerified ? 'is-verified' : 'is-unverified'}>
          {member.ownerVerified ? 'Владелец проверен' : 'Проверить владельца'}
        </span>
      </header>
      <div className="warehouse-coverage-member-reasons">
        {member.reasonCodes.map((code) => (
          <small key={code}>{coverageReasonLabel(code)}</small>
        ))}
      </div>
      <label className="warehouse-coverage-owner-field">
        <span>ID владельца</span>
        <input
          aria-label={`ID владельца ${member.rollCode}`}
          value={draft.ownerCounterpartyId}
          disabled={disabled}
          placeholder={member.ownerVerified ? 'Не менять' : 'Обязателен при исправлении владельца'}
          onChange={(event) =>
            onChange({ ...draft, ownerCounterpartyId: event.currentTarget.value })
          }
        />
      </label>
      <details className="warehouse-coverage-spec-editor">
        <summary>
          Характеристики рулона
          {member.currentSpec ? ' · менять только при расхождении' : ' · заполнить полностью'}
        </summary>
        <div className="warehouse-coverage-spec-grid">
          <SpecField
            label="Тип плёнки"
            value={draft.spec.filmType}
            disabled={disabled}
            onChange={(value) => updateSpec('filmType', value)}
          />
          <SpecField
            label="Фактическая толщина"
            value={draft.spec.actualThickness}
            disabled={disabled}
            onChange={(value) => updateSpec('actualThickness', value)}
          />
          <SpecField
            label="Учётная толщина"
            value={draft.spec.accountingThickness}
            disabled={disabled}
            onChange={(value) => updateSpec('accountingThickness', value)}
          />
          <SpecField
            label="Ширина, мм"
            value={draft.spec.widthMm}
            disabled={disabled}
            inputMode="decimal"
            onChange={(value) => updateSpec('widthMm', value)}
          />
          <SpecField
            label="Метраж, м"
            value={draft.spec.plannedLengthM}
            disabled={disabled}
            inputMode="decimal"
            onChange={(value) => updateSpec('plannedLengthM', value)}
          />
          <SpecField
            label="Бирка"
            value={draft.spec.birka}
            disabled={disabled}
            onChange={(value) => updateSpec('birka', value)}
          />
          <SpecField
            label="Шпуля"
            value={draft.spec.spoolType}
            disabled={disabled}
            onChange={(value) => updateSpec('spoolType', value)}
          />
          <SpecField
            label="Фактический вес, кг"
            value={draft.spec.actualWeightKg}
            disabled={disabled}
            inputMode="decimal"
            onChange={(value) => updateSpec('actualWeightKg', value)}
          />
          <SpecField
            label="Плановый вес, кг"
            value={draft.spec.plannedWeightKg}
            disabled={disabled}
            inputMode="decimal"
            onChange={(value) => updateSpec('plannedWeightKg', value)}
          />
          <SpecField
            label="ID рецептуры"
            value={draft.spec.recipeId ?? ''}
            disabled={disabled}
            onChange={(value) => updateSpec('recipeId', nullableValue(value))}
          />
          <SpecField
            label="Версия рецептуры"
            value={draft.spec.recipeVersion ?? ''}
            disabled={disabled}
            onChange={(value) => updateSpec('recipeVersion', nullableValue(value))}
          />
          <SpecField
            label="ID определения рецептуры"
            value={draft.spec.recipeDefinitionId ?? ''}
            disabled={disabled}
            onChange={(value) => updateSpec('recipeDefinitionId', nullableValue(value))}
          />
          <SpecField
            label="ID версии определения"
            value={draft.spec.recipeDefinitionVersionId ?? ''}
            disabled={disabled}
            onChange={(value) => updateSpec('recipeDefinitionVersionId', nullableValue(value))}
          />
          <SpecField
            label="Номер версии"
            value={draft.spec.recipeVersionNumber}
            disabled={disabled}
            inputMode="numeric"
            onChange={(value) => updateSpec('recipeVersionNumber', value)}
          />
          <label className="warehouse-coverage-ingredients-field">
            <span>Состав · ID сырья: доля в 1/10000</span>
            <textarea
              value={draft.spec.ingredientsText}
              disabled={disabled}
              placeholder="raw-material-id: 10000"
              onChange={(event) => updateSpec('ingredientsText', event.currentTarget.value)}
            />
          </label>
        </div>
      </details>
    </article>
  );
}

function SpecField({
  label,
  value,
  disabled,
  inputMode,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  inputMode?: 'decimal' | 'numeric';
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        inputMode={inputMode}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function createMemberDrafts(
  item: WarehouseCoverageRecheckItem,
): Record<string, MemberCorrectionDraft> {
  return Object.fromEntries(
    item.members.map((member) => [member.membershipId, createMemberDraft(member)]),
  );
}

function createMemberDraft(member?: WarehouseCoverageRecheckMemberView): MemberCorrectionDraft {
  return {
    ownerCounterpartyId: '',
    spec: member?.currentSpec ? specToDraft(member.currentSpec) : { ...EMPTY_SPEC_DRAFT },
  };
}

function specToDraft(spec: WarehouseCoverageCorrectionSpecView): CorrectionSpecDraft {
  return {
    ...spec,
    widthMm: String(spec.widthMm),
    plannedLengthM: String(spec.plannedLengthM),
    recipeVersionNumber: spec.recipeVersionNumber === null ? '' : String(spec.recipeVersionNumber),
    ingredientsText: spec.ingredients
      .map((ingredient) => `${ingredient.rawMaterialDefinitionId}: ${ingredient.shareBasisPoints}`)
      .join('\n'),
  };
}

function buildCorrections(
  members: WarehouseCoverageRecheckMemberView[],
  drafts: Record<string, MemberCorrectionDraft>,
): { corrections: WarehouseCoverageFactCorrectionDto[]; error: string | null } {
  const corrections: WarehouseCoverageFactCorrectionDto[] = [];
  for (const member of members) {
    const draft = drafts[member.membershipId] ?? createMemberDraft(member);
    const ownerCounterpartyId = draft.ownerCounterpartyId.trim();
    const initialSpecDraft = member.currentSpec
      ? specToDraft(member.currentSpec)
      : EMPTY_SPEC_DRAFT;
    const specChanged = JSON.stringify(draft.spec) !== JSON.stringify(initialSpecDraft);
    if (!ownerCounterpartyId && !specChanged) continue;
    if (ownerCounterpartyId && !member.currentSpec && !specChanged) {
      return {
        corrections: [],
        error: `${member.rollCode}: заполните характеристики для нового факта`,
      };
    }

    const base = {
      membershipId: member.membershipId,
      expectedFactVersion: member.currentFactVersion,
    };
    if (specChanged) {
      const parsed = parseSpec(draft.spec);
      if ('error' in parsed) {
        return {
          corrections: [],
          error: `${member.rollCode}: ${parsed.error}`,
        };
      }
      corrections.push({
        ...base,
        ...(ownerCounterpartyId ? { ownerCounterpartyId } : {}),
        spec: parsed.spec,
      });
    } else if (ownerCounterpartyId) {
      corrections.push({ ...base, ownerCounterpartyId });
    }
  }
  return { corrections, error: null };
}

function parseSpec(
  draft: CorrectionSpecDraft,
): { spec: WarehouseCoverageCorrectionSpecView } | { error: string } {
  const required = [
    ['тип плёнки', draft.filmType],
    ['фактическую толщину', draft.actualThickness],
    ['учётную толщину', draft.accountingThickness],
    ['бирку', draft.birka],
    ['шпулю', draft.spoolType],
    ['фактический вес', draft.actualWeightKg],
    ['плановый вес', draft.plannedWeightKg],
  ] as const;
  const missing = required.find(([, value]) => !value.trim());
  if (missing) return { error: `укажите ${missing[0]}` };
  if (!isDecimalKg(draft.actualWeightKg) || !isDecimalKg(draft.plannedWeightKg)) {
    return { error: 'вес должен быть положительным числом' };
  }
  const widthMm = Number(draft.widthMm.trim().replace(',', '.'));
  const plannedLengthM = Number(draft.plannedLengthM.trim().replace(',', '.'));
  if (
    !isDecimalKg(draft.widthMm) ||
    widthMm > 100_000 ||
    !isDecimalKg(draft.plannedLengthM) ||
    plannedLengthM > 10_000_000
  ) {
    return {
      error:
        'укажите положительные ширину и метраж в допустимых пределах, до трёх знаков после запятой',
    };
  }
  const ingredients = parseIngredients(draft.ingredientsText);
  if ('error' in ingredients) return ingredients;
  const versionNumberText = draft.recipeVersionNumber.trim();
  const recipeVersionNumber = versionNumberText ? Number(versionNumberText) : null;
  if (
    recipeVersionNumber !== null &&
    (!Number.isSafeInteger(recipeVersionNumber) || recipeVersionNumber < 1)
  ) {
    return { error: 'номер версии рецептуры должен быть целым положительным числом' };
  }
  return {
    spec: {
      filmType: draft.filmType.trim(),
      actualThickness: draft.actualThickness.trim(),
      accountingThickness: draft.accountingThickness.trim(),
      widthMm,
      plannedLengthM,
      birka: draft.birka.trim(),
      spoolType: draft.spoolType.trim(),
      actualWeightKg: normalizeDecimal(draft.actualWeightKg),
      plannedWeightKg: normalizeDecimal(draft.plannedWeightKg),
      recipeId: nullableValue(draft.recipeId ?? ''),
      recipeVersion: nullableValue(draft.recipeVersion ?? ''),
      recipeDefinitionId: nullableValue(draft.recipeDefinitionId ?? ''),
      recipeDefinitionVersionId: nullableValue(draft.recipeDefinitionVersionId ?? ''),
      recipeVersionNumber,
      ingredients: ingredients.ingredients,
    },
  };
}

function parseIngredients(
  value: string,
): { ingredients: WarehouseCoverageCorrectionSpecView['ingredients'] } | { error: string } {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: 'укажите состав рецептуры' };
  const ingredients: WarehouseCoverageCorrectionSpecView['ingredients'] = [];
  for (const line of lines) {
    const separator = line.lastIndexOf(':');
    const rawMaterialDefinitionId = line.slice(0, separator).trim();
    const shareBasisPoints = Number(line.slice(separator + 1).trim());
    if (
      separator < 1 ||
      !rawMaterialDefinitionId ||
      !Number.isSafeInteger(shareBasisPoints) ||
      shareBasisPoints < 1 ||
      shareBasisPoints > 10_000
    ) {
      return { error: 'состав должен быть в формате «ID сырья: доля»' };
    }
    ingredients.push({ rawMaterialDefinitionId, shareBasisPoints });
  }
  if (ingredients.reduce((sum, ingredient) => sum + ingredient.shareBasisPoints, 0) !== 10_000) {
    return { error: 'сумма долей состава должна быть 10000' };
  }
  return { ingredients };
}

function nullableValue(value: string): string | null {
  return value.trim() || null;
}

function isDecimalKg(value: string): boolean {
  return (
    /^(?:0|[1-9]\d*)(?:[.,]\d{1,3})?$/u.test(value.trim()) && Number(value.replace(',', '.')) > 0
  );
}

function normalizeDecimal(value: string): string {
  return value
    .trim()
    .replace(',', '.')
    .replace(/(?:\.0+|(\.\d*?[1-9])0+)$/u, '$1');
}

function sourceKindLabel(sourceKind: WarehouseCoverageRecheckMemberView['sourceKind']): string {
  if (sourceKind === 'decision_match') return 'Рулон из решения';
  if (sourceKind === 'verified_candidate') return 'Проверенный кандидат';
  return 'Требует проверки';
}
