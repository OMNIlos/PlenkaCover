import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  MACHINE_BREAKDOWN_TYPE_LABELS,
  MACHINE_BREAKDOWN_TYPES,
  isOperatorMachineBreakdownType,
  type OperatorMachineBreakdownRequest,
  type OperatorMachineBreakdownType,
} from '../../api/operator';

export function MachineBreakdownForm({
  onSubmit,
  pending = false,
  error = null,
  successVersion = 0,
}: {
  onSubmit?: (input: OperatorMachineBreakdownRequest) => void;
  pending?: boolean;
  error?: string | null;
  successVersion?: number;
}) {
  const [type, setType] = useState<OperatorMachineBreakdownType | ''>('');
  const [details, setDetails] = useState('');
  const confirmedSuccessVersion = useRef(successVersion);

  useEffect(() => {
    if (confirmedSuccessVersion.current === successVersion) return;
    confirmedSuccessVersion.current = successVersion;
    setType('');
    setDetails('');
  }, [successVersion]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!type || pending) return;

    const trimmedDetails = details.trim();
    onSubmit?.({ type, ...(trimmedDetails ? { details: trimmedDetails } : {}) });
  }

  return (
    <form className="machine-breakdown-form" aria-label="Форма поломки станка" onSubmit={submit}>
      <label className="machine-breakdown-field" htmlFor="operator-breakdown-type">
        <span>Тип поломки</span>
        <select
          id="operator-breakdown-type"
          value={type}
          disabled={pending}
          required
          onChange={(event) => {
            const value = event.target.value;
            setType(isOperatorMachineBreakdownType(value) ? value : '');
          }}
        >
          <option value="">Выберите тип</option>
          {MACHINE_BREAKDOWN_TYPES.map((value) => (
            <option key={value} value={value}>
              {MACHINE_BREAKDOWN_TYPE_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      <label className="machine-breakdown-field" htmlFor="operator-breakdown-details">
        <span>
          Детали <span>необязательно</span>
        </span>
        <textarea
          id="operator-breakdown-details"
          value={details}
          disabled={pending}
          maxLength={500}
          rows={2}
          onChange={(event) => setDetails(event.target.value)}
          placeholder="Уточните, что произошло"
        />
      </label>

      <button
        type="submit"
        className="machine-breakdown-submit action-destructive"
        disabled={!type || pending}
        aria-busy={pending}
      >
        {pending ? 'Отправляем…' : 'Сообщить о поломке'}
      </button>

      <div className="machine-breakdown-feedback" aria-live="polite">
        {error ? (
          <span role="alert">{error}</span>
        ) : pending ? (
          <span>Отправляем заявку…</span>
        ) : null}
      </div>
    </form>
  );
}
