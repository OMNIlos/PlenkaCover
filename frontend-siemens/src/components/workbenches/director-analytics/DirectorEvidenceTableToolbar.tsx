import { useState } from 'react';

export type DirectorEvidenceFilterField<K extends string> = {
  key: K;
  label: string;
  kind: 'text' | 'number' | 'date' | 'select';
  min?: number;
  step?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
};

export type DirectorEvidenceFilterGroup<K extends string> = {
  id: string;
  label: string;
  fields: ReadonlyArray<DirectorEvidenceFilterField<K>>;
};

export type EvidenceTableControl<TDraft> = {
  open: boolean;
  filters: TDraft;
  errors: Record<string, string>;
  updating: boolean;
  onOpenChange: (open: boolean) => void;
  onFilterChange: (key: keyof TDraft, value: string) => void;
  onResetFilters: () => void;
};

type DirectorEvidenceTableToolbarProps<K extends string> = {
  tableId: string;
  search: string;
  groups: ReadonlyArray<DirectorEvidenceFilterGroup<K>>;
  values: Record<K, string>;
  errors: Partial<Record<K, string>>;
  onSearchChange: (value: string) => void;
  onValueChange: (key: K, value: string) => void;
  onReset: () => void;
};

function displayedValue<K extends string>(
  field: DirectorEvidenceFilterField<K>,
  value: string,
): string {
  if (field.kind !== 'select') return value;
  return field.options?.find((option) => option.value === value)?.label ?? value;
}

export function DirectorEvidenceTableToolbar<K extends string>({
  tableId,
  search,
  groups,
  values,
  errors,
  onSearchChange,
  onValueChange,
  onReset,
}: DirectorEvidenceTableToolbarProps<K>) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const fields = groups.flatMap((group) => group.fields);
  const activeFields = fields.filter((field) => values[field.key].trim().length > 0);
  const panelId = `${tableId}-filter-panel`;

  return (
    <section
      className="director-evidence-toolbar"
      aria-label="Поиск и фильтры таблицы"
    >
      <div className="director-evidence-toolbar__controls">
        <label htmlFor={`${tableId}-search`}>Поиск</label>
        <input
          id={`${tableId}-search`}
          type="search"
          value={search}
          maxLength={100}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
        <button
          type="button"
          aria-controls={panelId}
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          Фильтры · {activeFields.length}
        </button>
        <button type="button" onClick={onReset}>
          Сбросить
        </button>
      </div>

      {activeFields.length > 0 ? (
        <ul className="director-evidence-toolbar__chips" aria-label="Активные фильтры">
          {activeFields.map((field) => {
            const value = values[field.key];
            const label = `${field.label}: ${displayedValue(field, value)}`;
            return (
              <li key={field.key}>
                <span>{label}</span>
                <button
                  type="button"
                  aria-label={`Удалить фильтр ${label}`}
                  onClick={() => onValueChange(field.key, '')}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <div id={panelId} className="director-evidence-toolbar__panel" hidden={!filtersOpen}>
        {groups.map((group) => (
          <fieldset key={group.id}>
            <legend>{group.label}</legend>
            <div>
              {group.fields.map((field) => {
                const inputId = `${tableId}-filter-${field.key}`;
                const error = errors[field.key];
                const errorId = `${inputId}-error`;
                const commonProps = {
                  id: inputId,
                  value: values[field.key],
                  'aria-invalid': Boolean(error),
                  'aria-describedby': error ? errorId : undefined,
                  onChange: (
                    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>,
                  ) => onValueChange(field.key, event.currentTarget.value),
                };

                return (
                  <label key={field.key} htmlFor={inputId}>
                    <span>{field.label}</span>
                    {field.kind === 'select' ? (
                      <select {...commonProps}>
                        {field.options?.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        {...commonProps}
                        type={field.kind}
                        min={field.min}
                        step={field.step}
                        maxLength={field.kind === 'text' ? 100 : undefined}
                      />
                    )}
                    {error ? (
                      <small id={errorId} role="alert">
                        {error}
                      </small>
                    ) : null}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </section>
  );
}
