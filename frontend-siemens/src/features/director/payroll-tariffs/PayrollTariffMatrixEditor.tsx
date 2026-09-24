import type {
  ServerPayrollTariffAbcBand,
  ServerPayrollTariffLadderKey,
  ServerPayrollTariffOrderFieldError,
  ServerPayrollTariffUrpBand,
} from '../../../api/payrollTariffOrders';
import {
  addPayrollTariffClosedBand,
  editPayrollTariffBand,
  removePayrollTariffClosedBand,
  setPayrollTariffOrderSpecialRule,
  type PayrollTariffBandField,
  type PayrollTariffOrderEditor,
} from './payrollTariffOrderModel';

type TariffBand = ServerPayrollTariffUrpBand | ServerPayrollTariffAbcBand;

type LadderConfiguration = {
  title: string;
  actionLabel: string;
  columns: readonly [
    { field: PayrollTariffBandField; label: string },
    { field: PayrollTariffBandField; label: string },
  ];
};

const ladderConfigurations: Record<ServerPayrollTariffLadderKey, LadderConfiguration> = {
  urp12h: {
    title: 'УРП / Матиль / Китайка · 12 часов',
    actionLabel: 'УРП 12 часов',
    columns: [
      { field: 'primaryRateKopecksPerKg', label: 'Первичное сырьё' },
      { field: 'secondaryRateKopecksPerKg', label: 'Вторичное сырьё' },
    ],
  },
  urp24h: {
    title: 'УРП / Матиль / Китайка · 24 часа',
    actionLabel: 'УРП 24 часа',
    columns: [
      { field: 'primaryRateKopecksPerKg', label: 'Первичное сырьё' },
      { field: 'secondaryRateKopecksPerKg', label: 'Вторичное сырьё' },
    ],
  },
  abc12h: {
    title: 'АВС · 12 часов',
    actionLabel: 'АВС 12 часов',
    columns: [
      { field: 'standardRateKopecksPerKg', label: 'Стандарт' },
      { field: 'blackWhiteRateKopecksPerKg', label: 'Фальц' },
    ],
  },
  abc24h: {
    title: 'АВС · 24 часа',
    actionLabel: 'АВС 24 часа',
    columns: [
      { field: 'standardRateKopecksPerKg', label: 'Стандарт' },
      { field: 'blackWhiteRateKopecksPerKg', label: 'Фальц' },
    ],
  },
};

const ladderKeys = Object.keys(ladderConfigurations) as ServerPayrollTariffLadderKey[];
const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  minimumFractionDigits: 2,
});

function numericValue(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function kilogramsToGrams(value: string): number {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? Math.max(1, Math.round(parsed * 1_000)) : 1;
}

function fieldValue(band: TariffBand, field: PayrollTariffBandField): number {
  if (field === 'maxInclusiveGrams') return band.maxInclusiveGrams ?? 0;
  if ('primaryRateKopecksPerKg' in band) {
    if (field === 'primaryRateKopecksPerKg') return band.primaryRateKopecksPerKg;
    if (field === 'secondaryRateKopecksPerKg') return band.secondaryRateKopecksPerKg;
  } else {
    if (field === 'standardRateKopecksPerKg') return band.standardRateKopecksPerKg;
    if (field === 'blackWhiteRateKopecksPerKg') return band.blackWhiteRateKopecksPerKg;
  }
  throw new Error('Поле не относится к тарифному диапазону');
}

function fieldMessage(
  fieldErrors: readonly ServerPayrollTariffOrderFieldError[],
  path: string,
): string | null {
  return fieldErrors.find((error) => error.path === path)?.message ?? null;
}

function RateInput({
  label,
  value,
  disabled,
  error,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  error: string | null;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`payroll-tariff-rate-field ${error ? 'has-error' : ''}`.trim()}>
      <span className="payroll-tariff-mobile-label">{label}</span>
      <input
        type="number"
        min="0"
        step="1"
        inputMode="numeric"
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(numericValue(event.currentTarget.value))}
      />
      <small>{rubles.format(value / 100)}/кг</small>
      {error ? <em role="alert">{error}</em> : null}
    </label>
  );
}

function LadderEditor({
  ladder,
  editor,
  fieldErrors,
  onChange,
  readOnly: forcedReadOnly,
}: {
  ladder: ServerPayrollTariffLadderKey;
  editor: PayrollTariffOrderEditor;
  fieldErrors: readonly ServerPayrollTariffOrderFieldError[];
  onChange: (editor: PayrollTariffOrderEditor) => void;
  readOnly: boolean;
}) {
  const configuration = ladderConfigurations[ladder];
  const bands = editor.matrix.ladders[ladder];
  const readOnly = forcedReadOnly || editor.status === 'published';

  return (
    <section className="payroll-tariff-ladder" data-payroll-ladder={true}>
      <header>
        <div>
          <span className="eyebrow">Тарифная лестница</span>
          <h4>{configuration.title}</h4>
        </div>
        {!readOnly ? (
          <button
            type="button"
            className="payroll-tariff-add-band"
            data-action="add-band"
            aria-label={`Добавить диапазон ${configuration.actionLabel}`}
            onClick={() => onChange(addPayrollTariffClosedBand(editor, ladder))}
          >
            Добавить диапазон
          </button>
        ) : null}
      </header>

      <div className="payroll-tariff-matrix-table-wrap">
        <table className="payroll-tariff-matrix-table">
          <thead>
            <tr>
              <th>Выработка за смену, кг</th>
              {configuration.columns.map(({ label }) => (
                <th key={label}>{label}, коп./кг</th>
              ))}
              {!readOnly ? <th aria-label="Действия" /> : null}
            </tr>
          </thead>
          <tbody>
            {bands.map((band, index) => {
              const open = index === bands.length - 1;
              const thresholdPath = `matrix.ladders.${ladder}[${index}].maxInclusiveGrams`;
              const thresholdError = fieldMessage(fieldErrors, thresholdPath);
              return (
                <tr key={`${band.maxInclusiveGrams ?? 'open'}-${index}`}>
                  <td data-label="Выработка за смену, кг">
                    <label className={thresholdError ? 'has-error' : undefined}>
                      <span className="payroll-tariff-mobile-label">Порог, кг</span>
                      <input
                        type={open ? 'text' : 'number'}
                        min={open ? undefined : '0.001'}
                        step={open ? undefined : '0.001'}
                        inputMode={open ? undefined : 'decimal'}
                        value={open ? 'Свыше' : (band.maxInclusiveGrams ?? 0) / 1_000}
                        disabled={readOnly || open}
                        aria-label={
                          open
                            ? `${configuration.title}, последний открытый диапазон`
                            : `${configuration.title}, порог диапазона ${index + 1}`
                        }
                        aria-invalid={thresholdError ? true : undefined}
                        onChange={(event) =>
                          onChange(
                            editPayrollTariffBand(
                              editor,
                              ladder,
                              index,
                              'maxInclusiveGrams',
                              kilogramsToGrams(event.currentTarget.value),
                            ),
                          )
                        }
                      />
                      {open ? <small>Открытый последний диапазон</small> : null}
                      {thresholdError ? <em role="alert">{thresholdError}</em> : null}
                    </label>
                  </td>
                  {configuration.columns.map(({ field, label }) => {
                    const path = `matrix.ladders.${ladder}[${index}].${field}`;
                    return (
                      <td key={field} data-label={label}>
                        <RateInput
                          label={`${configuration.title}, ${label}, диапазон ${index + 1}`}
                          value={fieldValue(band, field)}
                          disabled={readOnly}
                          error={fieldMessage(fieldErrors, path)}
                          onChange={(value) =>
                            onChange(editPayrollTariffBand(editor, ladder, index, field, value))
                          }
                        />
                      </td>
                    );
                  })}
                  {!readOnly ? (
                    <td className="payroll-tariff-row-action" data-label="Действия">
                      {!open ? (
                        <button
                          type="button"
                          data-action="remove-band"
                          aria-label={`Удалить диапазон ${index + 1} ${configuration.actionLabel}`}
                          onClick={() =>
                            onChange(removePayrollTariffClosedBand(editor, ladder, index))
                          }
                        >
                          Удалить
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SpecialRulesEditor({
  editor,
  fieldErrors,
  onChange,
  readOnly: forcedReadOnly,
}: {
  editor: PayrollTariffOrderEditor;
  fieldErrors: readonly ServerPayrollTariffOrderFieldError[];
  onChange: (editor: PayrollTariffOrderEditor) => void;
  readOnly: boolean;
}) {
  const readOnly = forcedReadOnly || editor.status === 'published';
  const { thinRoll, alabuga } = editor.matrix.specialRules;
  const thinThresholdError = fieldMessage(
    fieldErrors,
    'matrix.specialRules.thinRoll.maxExclusiveGrams',
  );
  const thinRateError = fieldMessage(
    fieldErrors,
    'matrix.specialRules.thinRoll.rateKopecksPerKg',
  );
  const alabugaNameError = fieldMessage(
    fieldErrors,
    'matrix.specialRules.alabuga.normalizedLegalName',
  );
  const alabugaRateError = fieldMessage(
    fieldErrors,
    'matrix.specialRules.alabuga.rateKopecksPerKg',
  );

  return (
    <section className="payroll-tariff-special-rules" aria-labelledby="payroll-special-rules-title">
      <header>
        <span className="eyebrow">Исключения</span>
        <h4 id="payroll-special-rules-title">Специальные правила</h4>
      </header>
      <div className="payroll-tariff-special-rule-grid">
        <fieldset>
          <legend>Тонкий рулон</legend>
          <label className="payroll-tariff-toggle">
            <input
              name="thin-roll-enabled"
              type="checkbox"
              checked={thinRoll.enabled}
              disabled={readOnly}
              onChange={(event) =>
                onChange(
                  setPayrollTariffOrderSpecialRule(
                    editor,
                    'thinRoll',
                    'enabled',
                    event.currentTarget.checked,
                  ),
                )
              }
            />
            <span>Применять отдельную ставку</span>
          </label>
          <label className={thinThresholdError ? 'has-error' : undefined}>
            <span>Вес менее, кг</span>
            <input
              type="number"
              min="0.001"
              step="0.001"
              inputMode="decimal"
              value={thinRoll.maxExclusiveGrams / 1_000}
              disabled={readOnly}
              onChange={(event) =>
                onChange(
                  setPayrollTariffOrderSpecialRule(
                    editor,
                    'thinRoll',
                    'maxExclusiveGrams',
                    kilogramsToGrams(event.currentTarget.value),
                  ),
                )
              }
            />
            {thinThresholdError ? <em role="alert">{thinThresholdError}</em> : null}
          </label>
          <RateInput
            label="Ставка тонкого рулона"
            value={thinRoll.rateKopecksPerKg}
            disabled={readOnly}
            error={thinRateError}
            onChange={(value) =>
              onChange(
                setPayrollTariffOrderSpecialRule(
                  editor,
                  'thinRoll',
                  'rateKopecksPerKg',
                  value,
                ),
              )
            }
          />
        </fieldset>

        <fieldset>
          <legend>Алабуга</legend>
          <label className="payroll-tariff-toggle">
            <input
              name="alabuga-enabled"
              type="checkbox"
              checked={alabuga.enabled}
              disabled={readOnly}
              onChange={(event) =>
                onChange(
                  setPayrollTariffOrderSpecialRule(
                    editor,
                    'alabuga',
                    'enabled',
                    event.currentTarget.checked,
                  ),
                )
              }
            />
            <span>Применять для АВС новой</span>
          </label>
          <label className={alabugaNameError ? 'has-error' : undefined}>
            <span>Нормализованное юрлицо</span>
            <input
              type="text"
              value={alabuga.normalizedLegalName}
              disabled={readOnly}
              onChange={(event) =>
                onChange(
                  setPayrollTariffOrderSpecialRule(
                    editor,
                    'alabuga',
                    'normalizedLegalName',
                    event.currentTarget.value,
                  ),
                )
              }
            />
            {alabugaNameError ? <em role="alert">{alabugaNameError}</em> : null}
          </label>
          <RateInput
            label="Ставка Алабуги"
            value={alabuga.rateKopecksPerKg}
            disabled={readOnly}
            error={alabugaRateError}
            onChange={(value) =>
              onChange(
                setPayrollTariffOrderSpecialRule(
                  editor,
                  'alabuga',
                  'rateKopecksPerKg',
                  value,
                ),
              )
            }
          />
        </fieldset>
      </div>
    </section>
  );
}

export function PayrollTariffMatrixEditor({
  editor,
  fieldErrors,
  onChange,
  readOnly = false,
}: {
  editor: PayrollTariffOrderEditor;
  fieldErrors: readonly ServerPayrollTariffOrderFieldError[];
  onChange: (editor: PayrollTariffOrderEditor) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="payroll-tariff-matrix-editor">
      {ladderKeys.map((ladder) => (
        <LadderEditor
          key={ladder}
          ladder={ladder}
          editor={editor}
          fieldErrors={fieldErrors}
          onChange={onChange}
          readOnly={readOnly}
        />
      ))}
      <SpecialRulesEditor
        editor={editor}
        fieldErrors={fieldErrors}
        onChange={onChange}
        readOnly={readOnly}
      />
    </div>
  );
}
