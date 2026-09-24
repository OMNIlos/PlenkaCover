import type { ServerDirectorAccountingProduction } from '../../../api/director';
import { formatNumber, formatTimestamp } from './directorAnalyticsFormatters';

export function DirectorAccountingSource({
  accounting,
}: {
  accounting: ServerDirectorAccountingProduction;
}) {
  const noDocuments = accounting.coverage.documentCount === 0;
  const excludedLines =
    accounting.coverage.excludedOutputLineCount + accounting.coverage.excludedMaterialLineCount;

  return (
    <aside
      className={`director-accounting-source${accounting.source.stale ? ' is-stale' : ''}`}
      aria-label="Учётный источник производственных данных"
    >
      <strong>Учётный источник · Отчёт производства за смену</strong>
      <span>Импорт: {formatTimestamp(accounting.source.latestImportedAt)}</span>
      <span>Последний документ: {formatTimestamp(accounting.source.latestDocumentDate)}</span>
      <span>Учётных документов: {formatNumber(accounting.coverage.documentCount)}</span>
      <span role="status">
        {accounting.source.stale ? 'Свежесть: требуется синхронизация' : 'Свежесть: актуально'}
      </span>
      {excludedLines > 0 ? (
        <p>
          Не включено в килограммы: продукция{' '}
          {formatNumber(accounting.coverage.excludedOutputLineCount)}, материалы{' '}
          {formatNumber(accounting.coverage.excludedMaterialLineCount)}.
        </p>
      ) : null}
      {noDocuments ? (
        <p>
          За период учётных данных нет. Последний документ:{' '}
          {formatTimestamp(accounting.source.latestDocumentDate)}
        </p>
      ) : null}
    </aside>
  );
}
