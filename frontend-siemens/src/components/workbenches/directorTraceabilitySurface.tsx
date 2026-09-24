import { type FormEvent, useRef, useState } from 'react';

import {
  fetchDirectorTraceabilityContext,
  fetchDirectorTraceabilitySearch,
  type TraceabilityContext,
  type TraceabilityFact,
  type TraceabilityObjectType,
  type TraceabilitySearchItem,
} from '../../api/director';

type SearchState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type ErrorScope = 'search' | 'context';

export function DirectorQrScanSurface() {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<TraceabilitySearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [context, setContext] = useState<TraceabilityContext | null>(null);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [contextLoading, setContextLoading] = useState(false);
  const [error, setError] = useState<{ message: string; scope: ErrorScope } | null>(null);
  const searchGeneration = useRef(0);
  const contextGeneration = useRef(0);

  async function openContext(item: TraceabilitySearchItem) {
    const generation = ++contextGeneration.current;
    setSelectedKey(traceabilityKey(item));
    setContextLoading(true);
    setError(null);
    try {
      const next = await fetchDirectorTraceabilityContext(item.objectType, item.objectId);
      if (generation === contextGeneration.current) setContext(next);
    } catch (caught) {
      if (generation === contextGeneration.current) {
        setContext(null);
        setError({
          message: traceabilityErrorMessage(caught, 'Не удалось открыть связанный объект.'),
          scope: 'context',
        });
      }
    } finally {
      if (generation === contextGeneration.current) setContextLoading(false);
    }
  }

  async function search(cursor?: string) {
    const normalized = query.trim();
    if (!normalized) {
      setSearchState('error');
      setError({ message: 'Введите QR, номер или название.', scope: 'search' });
      return;
    }
    const generation = ++searchGeneration.current;
    const append = Boolean(cursor);
    setSearchState('loading');
    setError(null);
    if (!append) {
      contextGeneration.current += 1;
      setCandidates([]);
      setSelectedKey(null);
      setContext(null);
      setNextCursor(null);
    }
    try {
      const page = await fetchDirectorTraceabilitySearch({
        q: normalized,
        limit: 12,
        ...(cursor ? { cursor } : {}),
      });
      if (generation !== searchGeneration.current) return;
      const nextCandidates = append
        ? mergeTraceabilityCandidates(candidates, page.items)
        : page.items;
      setCandidates(nextCandidates);
      setNextCursor(page.nextCursor);
      if (nextCandidates.length === 0) {
        setSearchState('empty');
        return;
      }
      setSearchState('ready');
      if (
        !append &&
        page.nextCursor === null &&
        page.items.length === 1 &&
        page.items[0]?.matchKind === 'exact'
      ) {
        setQuery('');
      }
      if (!append) await openContext(nextCandidates[0]);
    } catch (caught) {
      if (generation === searchGeneration.current) {
        setSearchState('error');
        setError({
          message: traceabilityErrorMessage(caught, 'Не удалось выполнить поиск.'),
          scope: 'search',
        });
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void search();
  }

  const selectedCandidate = candidates.find((item) => traceabilityKey(item) === selectedKey);

  return (
    <section className="surface director-qr-surface" aria-label="Аудит QR директора">
      <header className="director-qr-hero">
        <div>
          <span className="eyebrow">Прослеживаемость</span>
          <h2>Аудит объекта</h2>
          <p>Рулон, Big-Bag, палетный лист, заказ или складская операция</p>
        </div>
      </header>

      <form
        className="director-traceability-search"
        aria-label="Поиск прослеживаемости"
        aria-busy={searchState === 'loading'}
        onSubmit={submit}
      >
        <label>
          <span>QR, номер или название</span>
          <input
            aria-label="QR, номер или название"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Например, A-9 или код QR"
            autoComplete="off"
            autoFocus
          />
        </label>
        <button
          type="submit"
          className="management-focus-action director-qr-open-action"
          disabled={searchState === 'loading' || !query.trim()}
        >
          <ix-icon name="search" size="16" />
          <span>{searchState === 'loading' ? 'Ищем…' : 'Найти'}</span>
        </button>
      </form>

      {error ? (
        <div className="director-traceability-message tone-critical" role="alert">
          <span>{error.message}</span>
          <button
            type="button"
            className="compact-action-button"
            data-traceability-retry
            onClick={() => {
              if (error.scope === 'context' && selectedCandidate) {
                void openContext(selectedCandidate);
                return;
              }
              void search();
            }}
          >
            Повторить
          </button>
        </div>
      ) : null}

      {searchState === 'idle' ? (
        <div className="director-traceability-empty">
          <strong>Введите идентификатор</strong>
          <span>Сканер может отправить код клавишей Enter.</span>
        </div>
      ) : null}
      {searchState === 'empty' ? (
        <div className="director-traceability-empty" role="status">
          <strong>Ничего не найдено</strong>
          <span>Проверьте код или выполните новый поиск.</span>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="director-traceability-layout">
          <aside className="director-traceability-candidates" aria-label="Результаты поиска">
            <div className="management-section-header">
              <span className="eyebrow">Найдено</span>
              <strong>{candidates.length}</strong>
            </div>
            <div className="director-traceability-candidate-list">
              {candidates.map((item) => {
                const key = traceabilityKey(item);
                return (
                  <button
                    key={key}
                    type="button"
                    className={selectedKey === key ? 'is-selected' : ''}
                    data-traceability-candidate={key}
                    onClick={() => void openContext(item)}
                  >
                    <span>{traceabilityObjectTypeLabel(item.objectType)}</span>
                    <strong>{item.displayName}</strong>
                    {item.secondaryLabel ? <small>{item.secondaryLabel}</small> : null}
                  </button>
                );
              })}
            </div>
            {nextCursor ? (
              <button
                type="button"
                className="compact-action-button"
                disabled={searchState === 'loading'}
                onClick={() => void search(nextCursor)}
              >
                {searchState === 'loading' ? 'Загружаем…' : 'Показать ещё'}
              </button>
            ) : null}
          </aside>
          <section className="director-traceability-context" aria-live="polite">
            {contextLoading ? (
              <div className="director-traceability-empty" role="status">
                <strong>Загружаем контекст…</strong>
              </div>
            ) : null}
            {!contextLoading && context ? (
              <TraceabilityContextView context={context} onOpen={openContext} />
            ) : null}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function TraceabilityContextView({
  context,
  onOpen,
}: {
  context: TraceabilityContext;
  onOpen: (item: TraceabilitySearchItem) => Promise<void>;
}) {
  const issues = [
    ...context.problems.slice(0, 20).map((problem) => ({
      id: `problem:${problem.id}`,
      title: problem.title,
      status: problem.statusLabel,
      detail: problem.reason ?? 'Причина не указана',
      date: problem.createdAt,
      tone: problem.resolvedAt === null ? 'warning' : 'success',
    })),
    ...context.defects.slice(0, 20).map((defect) => ({
      id: `defect:${defect.id}`,
      title: 'Брак',
      status: defect.statusLabel,
      detail: `${defect.reason}${defect.weightKg === null ? '' : ` · ${defect.weightKg} кг`}`,
      date: defect.recordedAt,
      tone: 'critical',
    })),
  ];

  return (
    <>
      <header className="director-traceability-context-header">
        <span>{traceabilityObjectTypeLabel(context.objectType)}</span>
        <h3>{context.displayName}</h3>
      </header>

      {context.statuses.length > 0 ? (
        <dl className="director-traceability-statuses">
          {context.statuses.slice(0, 12).map((status, index) => (
            <div key={`${status.title}:${index}`}>
              <dt>{status.title}</dt>
              <dd>{status.valueLabel}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {context.links.length > 0 ? (
        <section className="director-traceability-section">
          <h4>Связанные объекты</h4>
          <div className="director-traceability-links">
            {context.links.slice(0, 24).map((link) => (
              <button
                key={`${link.objectType}:${link.objectId}:${link.relationLabel}`}
                type="button"
                onClick={() =>
                  void onOpen({
                    objectType: link.objectType,
                    objectId: link.objectId,
                    displayName: link.displayName,
                    secondaryLabel: link.relationLabel,
                    matchKind: 'exact',
                  })
                }
              >
                <span>{link.relationLabel}</span>
                <strong>{link.displayName}</strong>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {context.productionFacts.length > 0 || context.warehouseFacts.length > 0 ? (
        <section className="director-traceability-section">
          <h4>Факты</h4>
          <div className="director-traceability-fact-groups">
            <TraceabilityFacts title="Производство" facts={context.productionFacts} />
            <TraceabilityFacts title="Склад" facts={context.warehouseFacts} />
          </div>
        </section>
      ) : null}

      {issues.length > 0 ? (
        <section className="director-traceability-section">
          <h4>Проблемы и брак</h4>
          <div className="director-traceability-issues">
            {issues.map((issue) => (
              <article key={issue.id} className={`tone-${issue.tone}`}>
                <div>
                  <strong>{issue.title}</strong>
                  <span>{issue.status}</span>
                </div>
                <p>{issue.detail}</p>
                <time dateTime={issue.date}>{formatTraceabilityDate(issue.date)}</time>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="director-traceability-section">
        <h4>История</h4>
        {context.timeline.length > 0 ? (
          <ol className="director-traceability-timeline">
            {context.timeline.slice(0, 40).map((event) => (
              <li key={event.eventId}>
                <time dateTime={event.occurredAt}>{formatTraceabilityDate(event.occurredAt)}</time>
                <div>
                  <strong>{event.actionLabel}</strong>
                  <span>
                    {event.actor.displayName} · {event.actor.roleLabel}
                    {event.reason ? ` · ${event.reason}` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <div className="director-traceability-empty">
            <span>Событий пока нет.</span>
          </div>
        )}
      </section>
    </>
  );
}

function TraceabilityFacts({ title, facts }: { title: string; facts: TraceabilityFact[] }) {
  if (facts.length === 0) return null;
  return (
    <div>
      <h5>{title}</h5>
      <dl>
        {facts.slice(0, 24).map((fact, index) => (
          <div key={`${fact.title}:${fact.recordedAt}:${index}`}>
            <dt>{fact.title}</dt>
            <dd>
              <strong>{fact.valueLabel}</strong>
              <small>
                {fact.isCurrent === true
                  ? 'Актуальное измерение'
                  : fact.isCurrent === false
                    ? 'История измерений'
                    : 'Зафиксировано'}{' '}
                · {formatTraceabilityDate(fact.recordedAt)}
              </small>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function traceabilityKey(item: Pick<TraceabilitySearchItem, 'objectType' | 'objectId'>) {
  return `${item.objectType}:${item.objectId}`;
}

function mergeTraceabilityCandidates(
  current: TraceabilitySearchItem[],
  incoming: TraceabilitySearchItem[],
) {
  const byKey = new Map(current.map((item) => [traceabilityKey(item), item]));
  for (const item of incoming) byKey.set(traceabilityKey(item), item);
  return Array.from(byKey.values()).slice(0, 60);
}

function traceabilityObjectTypeLabel(objectType: TraceabilityObjectType) {
  const labels: Record<TraceabilityObjectType, string> = {
    order: 'Заказ',
    position: 'Позиция',
    roll: 'Рулон',
    big_bag: 'Big-Bag',
    pallet: 'Палетный лист',
    warehouse_task: 'Задача склада',
    warehouse_operation: 'Операция склада',
  };
  return labels[objectType];
}

function formatTraceabilityDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Moscow',
  }).format(date);
}

function traceabilityErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (
    !message ||
    message.length > 160 ||
    /internal|stack|adapter|prisma|sql|raw payload/iu.test(message)
  ) {
    return fallback;
  }
  return message;
}
