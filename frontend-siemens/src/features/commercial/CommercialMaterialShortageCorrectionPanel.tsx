import { useEffect, useMemo, useState } from 'react';
import type { RawMaterialCatalogItem } from '../../api/materialRecipeCatalog';
import type { CommercialMaterialShortageCorrectionCommand } from './api';
import type { CommercialProductionProblemContract } from './contracts';

function normalizedParameters(
  parameters: readonly { label: string; value: string }[],
): Array<{ label: string; value: string }> {
  return parameters.map((parameter) => ({
    label: parameter.label.trim(),
    value: parameter.value.trim(),
  }));
}

export function CommercialMaterialShortageCorrectionPanel({
  problems,
  selectedProblemId,
  materials,
  status,
  error,
  onSubmit,
  onRetry,
}: {
  problems: CommercialProductionProblemContract[];
  selectedProblemId?: string | null;
  materials: readonly RawMaterialCatalogItem[];
  status: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
  onSubmit: (command: CommercialMaterialShortageCorrectionCommand) => void | Promise<void>;
  onRetry: () => void;
}) {
  const eligibleProblems = problems.filter(
    (item) =>
      item.type === 'raw_material_shortage' &&
      item.status === 'open' &&
      item.ownerRole === 'commercial',
  );
  const problem = selectedProblemId
    ? eligibleProblems.find((item) => item.id === selectedProblemId)
    : eligibleProblems[0];
  const reportedRoll = useMemo(
    () =>
      problem?.candidateRolls.find(
        (roll) =>
          roll.eligible &&
          (roll.rollId === problem.reportedRollId || roll.rollCode === problem.reportedRollId),
      ) ?? null,
    [problem],
  );
  const [reason, setReason] = useState('');
  const [newRawMaterialId, setNewRawMaterialId] = useState(materials[0]?.id ?? '');
  const [newParameters, setNewParameters] = useState<Array<{ label: string; value: string }>>([]);

  useEffect(() => {
    setReason('');
    setNewRawMaterialId(materials[0]?.id ?? '');
    setNewParameters(normalizedParameters(problem?.currentRecipe.parameters ?? []));
  }, [materials, problem?.currentRecipe.parameters, problem?.id]);

  if (!problem) return null;
  const normalizedReason = reason.trim();
  const commandParameters = normalizedParameters(newParameters);
  const disabled =
    status === 'loading' ||
    !reportedRoll ||
    !materials.some((material) => material.id === newRawMaterialId) ||
    !normalizedReason ||
    commandParameters.length === 0 ||
    commandParameters.some((parameter) => !parameter.label || !parameter.value);

  const submit = () => {
    if (disabled || !reportedRoll) return;
    void onSubmit({
      problemId: problem.id,
      fromRollId: reportedRoll.rollCode,
      newRawMaterialId,
      newParameters: commandParameters,
      reason: normalizedReason,
    });
  };

  return (
    <section
      className="commercial-correction-panel commercial-material-shortage-correction-panel"
      aria-label="Корректировка нехватки сырья"
    >
      <header>
        <span className="eyebrow">Производство → коммерция</span>
        <h3>Заменить недоступное сырьё</h3>
      </header>

      <section className="commercial-problem-impact" aria-label="Влияние нехватки сырья">
        <strong>{problem.reason}</strong>
        <dl>
          <div>
            <dt>Проблемный рулон</dt>
            <dd>{reportedRoll?.rollCode ?? 'Недоступен'}</dd>
          </div>
          <div>
            <dt>Текущая версия</dt>
            <dd>{problem.currentRecipe.version}</dd>
          </div>
        </dl>
        {problem.recovery ? <p>{problem.recovery}</p> : null}
      </section>

      <label>
        Новое сырьё
        <select
          value={newRawMaterialId}
          disabled={status === 'loading'}
          onChange={(event) => setNewRawMaterialId(event.target.value)}
        >
          {materials.map((material) => (
            <option key={material.id} value={material.id}>
              {material.name}
            </option>
          ))}
        </select>
      </label>

      <div className="commercial-correction-delta">
        <section>
          <h4>Параметры новой версии</h4>
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

      <label>
        Причина замены
        <textarea
          aria-label="Причина замены сырья"
          value={reason}
          disabled={status === 'loading'}
          onChange={(event) => setReason(event.target.value)}
        />
      </label>

      {status === 'error' ? (
        <div role="alert">
          <strong>Замена сырья не применена</strong>
          {error ? <p>{error}</p> : null}
          <button type="button" onClick={onRetry}>
            Обновить данные
          </button>
        </div>
      ) : null}
      {status === 'success' ? <p role="status">Замена сырья применена.</p> : null}

      <button type="button" disabled={disabled} onClick={submit}>
        {status === 'loading' ? 'Применение…' : 'Применить замену сырья'}
      </button>
    </section>
  );
}
