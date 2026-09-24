import { useEffect, useMemo, useState } from 'react';
import type { CurrentRollResolution } from '../../domain/types';
import { CommercialCorrectionForm } from '../../components/workbenches/CommercialCorrectionForm';
import type { CommercialProblemCorrectionCommand } from './api';
import type {
  CommercialCurrentRollResolution,
  CommercialProductionProblemContract,
} from './contracts';

export type CommercialCorrectionDraft = {
  reason: string;
  fromRollId: string;
  currentRollResolution: CommercialCurrentRollResolution;
  newParameters: Array<{ label: string; value: string }>;
};

const DECISIONS: CommercialCurrentRollResolution[] = ['stop_and_apply_new', 'finish_old_version'];

export function buildProblemCorrectionCommand(
  problem: CommercialProductionProblemContract,
  draft: CommercialCorrectionDraft,
): CommercialProblemCorrectionCommand {
  const reason = draft.reason.trim();
  if (!reason) throw new Error('Укажите причину изменения.');
  const boundary = problem.candidateRolls.find(
    (roll) => roll.rollCode === draft.fromRollId && roll.eligible,
  );
  if (!boundary) throw new Error('Выберите доступный рулон начала новой версии.');
  if (
    draft.currentRollResolution === 'stop_and_apply_new' &&
    boundary.positionSequence !== problem.currentRollSequence
  ) {
    throw new Error('После остановки новая версия должна начаться с текущего рулона.');
  }
  if (
    draft.currentRollResolution === 'finish_old_version' &&
    boundary.positionSequence <= problem.currentRollSequence
  ) {
    throw new Error('После завершения текущего рулона выберите следующий рулон.');
  }
  const newParameters = draft.newParameters.map((parameter) => ({
    label: parameter.label.trim(),
    value: parameter.value.trim(),
  }));
  if (
    newParameters.length === 0 ||
    newParameters.some((parameter) => !parameter.label || !parameter.value)
  ) {
    throw new Error('Заполните все значения новой рецептуры.');
  }
  return {
    positionId: problem.positionId,
    fromRollId: boundary.rollCode,
    expectedRecipeVersion: problem.currentRecipe.version,
    currentRollResolution: draft.currentRollResolution,
    newParameters,
    reason,
  };
}

export function CommercialCorrectionPanel({
  problems,
  selectedProblemId,
  status,
  error,
  onSubmit,
  onRetry,
}: {
  problems: CommercialProductionProblemContract[];
  selectedProblemId?: string | null;
  status: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
  onSubmit: (
    problemId: string,
    command: CommercialProblemCorrectionCommand,
  ) => void | Promise<void>;
  onRetry: () => void;
}) {
  const eligibleProblems = problems.filter(
    (item) =>
      item.status === 'open' &&
      item.ownerRole === 'commercial' &&
      item.type !== 'raw_material_shortage',
  );
  const problem = selectedProblemId
    ? eligibleProblems.find((item) => item.id === selectedProblemId)
    : eligibleProblems[0];
  const eligibleRolls = useMemo(
    () => problem?.candidateRolls.filter((roll) => roll.eligible) ?? [],
    [problem],
  );
  const currentEligible = eligibleRolls.find(
    (roll) => roll.positionSequence === problem?.currentRollSequence,
  );
  const nextEligible = eligibleRolls.find(
    (roll) => roll.positionSequence > (problem?.currentRollSequence ?? 0),
  );
  const initialDecision: CommercialCurrentRollResolution = currentEligible
    ? 'stop_and_apply_new'
    : 'finish_old_version';
  const [reason, setReason] = useState('');
  const [fromRollId, setFromRollId] = useState(
    (currentEligible ?? nextEligible ?? eligibleRolls[0])?.rollCode ?? '',
  );
  const [currentRollResolution, setCurrentRollResolution] =
    useState<CommercialCurrentRollResolution>(initialDecision);
  const [newParameters, setNewParameters] = useState(
    problem?.currentRecipe.parameters.map((parameter) => ({ ...parameter })) ?? [],
  );

  useEffect(() => {
    setReason('');
    setFromRollId((currentEligible ?? nextEligible ?? eligibleRolls[0])?.rollCode ?? '');
    setCurrentRollResolution(initialDecision);
    setNewParameters(
      problem?.currentRecipe.parameters.map((parameter) => ({ ...parameter })) ?? [],
    );
  }, [
    currentEligible,
    eligibleRolls,
    initialDecision,
    nextEligible,
    problem?.currentRecipe.parameters,
    problem?.id,
  ]);

  if (!problem) return null;
  const reportedRollCode = problem.candidateRolls.find(
    (roll) => roll.rollId === problem.reportedRollId || roll.rollCode === problem.reportedRollId,
  )?.rollCode;
  const selectedRoll = eligibleRolls.find((roll) => roll.rollCode === fromRollId);
  const disabled =
    status === 'loading' ||
    !reason.trim() ||
    !selectedRoll ||
    newParameters.length === 0 ||
    newParameters.some((parameter) => !parameter.label.trim() || !parameter.value.trim()) ||
    (currentRollResolution === 'stop_and_apply_new' &&
      selectedRoll.positionSequence !== problem.currentRollSequence) ||
    (currentRollResolution === 'finish_old_version' &&
      selectedRoll.positionSequence <= problem.currentRollSequence);

  function changeDecision(value: CurrentRollResolution) {
    if (!DECISIONS.includes(value as CommercialCurrentRollResolution)) return;
    const decision = value as CommercialCurrentRollResolution;
    setCurrentRollResolution(decision);
    if (decision === 'stop_and_apply_new' && currentEligible) {
      setFromRollId(currentEligible.rollCode);
    }
    if (decision === 'finish_old_version' && nextEligible) {
      setFromRollId(nextEligible.rollCode);
    }
  }

  function submit() {
    if (!problem) return;
    const command = buildProblemCorrectionCommand(problem, {
      reason,
      fromRollId,
      currentRollResolution,
      newParameters,
    });
    void onSubmit(problem.id, command);
  }

  return (
    <section className="commercial-correction-panel" aria-label="Корректировка по проблеме">
      <header>
        <span className="eyebrow">Производство → коммерция</span>
        <h3>Разобрать проблему производства</h3>
      </header>

      <section className="commercial-problem-impact" aria-label="Влияние проблемы">
        <span>Влияет на производство этой позиции</span>
        <strong>{problem.reason}</strong>
        <dl>
          <div>
            <dt>Готово</dt>
            <dd>
              {problem.completedRolls} из {problem.totalRolls} рул.
            </dd>
          </div>
          <div>
            <dt>Проблемный рулон</dt>
            <dd>
              {problem.currentRollSequence}
              {reportedRollCode ? ` · ${reportedRollCode}` : ''}
            </dd>
          </div>
          <div>
            <dt>Текущая версия</dt>
            <dd>{problem.currentRecipe.version}</dd>
          </div>
        </dl>
        {problem.recovery && <p>{problem.recovery}</p>}
      </section>

      <h4 className="commercial-correction-decision-title">Решение коммерции</h4>

      <div className="commercial-correction-delta">
        <section>
          <h4>Сейчас</h4>
          {problem.currentRecipe.parameters.map((parameter) => (
            <p key={parameter.label}>
              <span>{parameter.label}</span> <strong>{parameter.value}</strong>
            </p>
          ))}
        </section>
        <section>
          <h4>Новая версия</h4>
          {newParameters.map((parameter, index) => (
            <label key={`${parameter.label}-${index}`}>
              {parameter.label}
              <input
                value={parameter.value}
                disabled={status === 'loading'}
                onChange={(event) =>
                  setNewParameters((current) =>
                    current.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
          ))}
        </section>
      </div>

      <CommercialCorrectionForm
        reason={reason}
        appliesFromRollNumber={selectedRoll?.positionSequence ?? problem.currentRollSequence}
        minAppliesFromRoll={problem.currentRollSequence}
        maxAppliesFromRoll={problem.totalRolls}
        currentRollResolution={currentRollResolution}
        rollOptions={eligibleRolls.map((roll) => ({
          value: roll.positionSequence,
          label: `${roll.positionSequence} · ${roll.rollCode}`,
        }))}
        currentRollResolutionOptions={DECISIONS}
        disabled={status === 'loading'}
        onReasonChange={setReason}
        onAppliesFromRollNumberChange={(sequence) => {
          const roll = eligibleRolls.find((item) => item.positionSequence === sequence);
          setFromRollId(roll?.rollCode ?? '');
        }}
        onCurrentRollResolutionChange={changeDecision}
      />

      {status === 'error' && (
        <div role="alert">
          <strong>Корректировка не применена</strong>
          {error && <p>{error}</p>}
          <button type="button" onClick={onRetry}>
            Обновить данные
          </button>
        </div>
      )}
      {status === 'success' && <p role="status">Новая версия рецептуры применена.</p>}

      <button type="button" disabled={disabled} onClick={submit}>
        {status === 'loading' ? 'Применение…' : 'Применить корректировку'}
      </button>
    </section>
  );
}
