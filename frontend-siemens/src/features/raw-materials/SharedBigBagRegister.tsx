import { useEffect, useRef, useState } from 'react';
import {
  fetchBigBagRegisterPage,
  type BigBagRegisterLocation,
  type BigBagRegisterPage,
  type BigBagRegisterQuery,
  type BigBagRegisterRow,
} from '../../api/bigBagRegister';
import type { ApiRequestOptions } from '../../api/client';
import { LiveRefreshController } from '../../api/liveRefresh';

type BigBagRegisterFetcher = (
  query: BigBagRegisterQuery,
  options?: ApiRequestOptions,
) => Promise<BigBagRegisterPage>;

const STATUS_LABELS: Record<BigBagRegisterRow['status'], string> = {
  available: 'Доступен',
  in_use: 'Используется',
  consumed: 'Израсходован',
};

type BigBagBusinessStatus = {
  tone: 'warehouse' | 'free' | 'busy' | 'consumed' | 'unknown';
  primary: string;
  secondary: string | null;
};

function initialSearch(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('bigBagQuery')?.trim() ?? '';
}

function persistSearch(query: string) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (query) params.set('bigBagQuery', query);
  else params.delete('bigBagQuery');
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`,
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Moscow',
  }).format(new Date(value));
}

function formatWeight(value: number | null): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value)} кг`;
}

function formatMoney(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function locationLabel(location: BigBagRegisterLocation): string {
  if (location.kind === 'warehouse') return 'Склад';
  if (location.kind === 'production') return 'Производство';
  if (location.kind === 'consumed') return 'Израсходован';
  if (location.kind === 'unknown') return 'Местоположение уточняется';
  return `${location.postName} · ${location.postCode}`;
}

function businessStatus(item: BigBagRegisterRow): BigBagBusinessStatus {
  switch (item.location.kind) {
    case 'warehouse':
      return { tone: 'warehouse', primary: 'На складе', secondary: null };
    case 'production':
      return { tone: 'free', primary: 'Свободен', secondary: 'На производстве' };
    case 'post':
      return {
        tone: 'busy',
        primary: 'Используется',
        secondary: 'На производстве',
      };
    case 'consumed':
      return { tone: 'consumed', primary: 'Израсходован', secondary: null };
    case 'unknown':
      return { tone: 'unknown', primary: 'Статус уточняется', secondary: null };
  }
}

function BigBagBusinessStatusCell({ item }: { item: BigBagRegisterRow }) {
  const presentation = businessStatus(item);
  return (
    <td data-label="Статус">
      <span
        className={`shared-bigbag-status shared-bigbag-status--${presentation.tone}`}
        data-bigbag-status={presentation.tone}
      >
        <strong>{presentation.primary}</strong>
        {presentation.secondary ? <small>{presentation.secondary}</small> : null}
      </span>
    </td>
  );
}

export function SharedBigBagRegister({
  fetchPage = fetchBigBagRegisterPage,
  pageSize = 25,
  refreshGeneration = 0,
  refreshIntervalMs = 5_000,
  variant = 'business',
  view = 'all',
}: {
  fetchPage?: BigBagRegisterFetcher;
  pageSize?: number;
  refreshGeneration?: string | number;
  refreshIntervalMs?: number;
  variant?: 'business' | 'operational';
  view?: 'all' | 'current';
}) {
  const [query, setQuery] = useState(initialSearch);
  const [pageNumber, setPageNumber] = useState(1);
  const [snapshot, setSnapshot] = useState<BigBagRegisterPage | null>(null);
  const snapshotRef = useRef<BigBagRegisterPage | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'stale' | 'error'>('loading');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const liveRefresh = new LiveRefreshController<BigBagRegisterPage>({
      intervalMs: refreshIntervalMs > 0 ? refreshIntervalMs : 5_000,
    });
    setStatus(snapshotRef.current ? 'ready' : 'loading');
    liveRefresh.start({
      automatic: refreshIntervalMs > 0,
      load: (signal) =>
        fetchPage(
          {
            ...(query ? { q: query } : {}),
            ...(view === 'current' ? { view } : {}),
            page: pageNumber,
            pageSize,
          },
          { signal },
        ),
      apply: (next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setStatus('ready');
      },
      onError: () => setStatus(snapshotRef.current ? 'stale' : 'error'),
    });
    return () => {
      liveRefresh.stop();
    };
  }, [fetchPage, pageNumber, pageSize, query, refreshGeneration, refreshIntervalMs, revision, view]);

  const pageCount = snapshot ? Math.max(1, Math.ceil(snapshot.total / snapshot.pageSize)) : 1;
  const operational = variant === 'operational';

  return (
    <section className="shared-bigbag-register" aria-label="Реестр Big-Bag">
      <header>
        <h3>Big-Bag</h3>
        {snapshot ? <span>{snapshot.total} шт.</span> : null}
      </header>
      <div className="safe-inventory-toolbar" aria-label="Фильтр Big-Bag">
        <label className="safe-inventory-search">
          <span>Поиск</span>
          <input
            type="search"
            aria-label="Поиск Big-Bag"
            value={query}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setQuery(next);
              setPageNumber(1);
              persistSearch(next.trim());
            }}
            placeholder="Название, сырьё, статус или оператор"
            autoComplete="off"
          />
        </label>
      </div>

      {/* Only the very first load gets a banner: showing it on every refresh
          replaced the register with a placeholder and read as a blink. */}
      {status === 'loading' && !snapshot ? <p role="status">Загружаем Big-Bag…</p> : null}
      {status === 'error' ? (
        <div role="status" aria-live="polite">
          <span>Не удалось загрузить Big-Bag.</span>
          <button
            type="button"
            aria-label="Повторить загрузку Big-Bag"
            onClick={() => setRevision((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      ) : null}
      {status === 'stale' ? (
        <div role="status" aria-live="polite">
          <span>Не удалось обновить Big-Bag. Показаны последние данные.</span>
          <button
            type="button"
            aria-label="Повторить обновление Big-Bag"
            onClick={() => setRevision((value) => value + 1)}
          >
            Повторить
          </button>
        </div>
      ) : null}
      {status === 'ready' && snapshot?.items.length === 0 ? <p>Big-Bag не найдены.</p> : null}
      {snapshot && snapshot.items.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>{operational ? 'Код' : 'Название Big-Bag'}</th>
              <th>{operational ? 'Содержимое' : 'Сырьё'}</th>
              <th>{operational ? 'Создан' : 'Дата создания'}</th>
              {operational ? <th>Статус</th> : null}
              {operational ? <th>Где находится</th> : null}
              {operational ? null : <th>Статус</th>}
              {operational ? null : <th>Оператор</th>}
              <th>Текущий вес</th>
              {operational ? null : <th>Денежный эквивалент</th>}
            </tr>
          </thead>
          <tbody>
            {snapshot.items.map((item) => (
              <tr key={item.id}>
                <td data-label={operational ? 'Код' : 'Название Big-Bag'}>
                  <strong>{item.code}</strong>
                </td>
                <td data-label={operational ? 'Содержимое' : 'Сырьё'}>
                  <strong>{item.material}</strong>
                  {operational ? <small>Партия {item.batch ?? '—'}</small> : null}
                </td>
                <td data-label={operational ? 'Создан' : 'Дата создания'}>
                  {formatDate(item.createdAt)}
                </td>
                {operational ? <td data-label="Статус">{STATUS_LABELS[item.status]}</td> : null}
                {operational ? (
                  <td data-label="Где находится">{locationLabel(item.location)}</td>
                ) : null}
                {operational ? null : <BigBagBusinessStatusCell item={item} />}
                {operational ? null : (
                  <td data-label="Оператор">{item.operatorName ?? '—'}</td>
                )}
                <td data-label="Текущий вес">{formatWeight(item.currentWeightKg)}</td>
                {operational ? null : (
                  <td data-label="Денежный эквивалент">{formatMoney(item.totalKopecks)}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {snapshot && pageCount > 1 ? (
        <nav aria-label="Страницы Big-Bag">
          <button
            type="button"
            aria-label="Предыдущая страница Big-Bag"
            disabled={snapshot.page <= 1}
            onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
          >
            Назад
          </button>
          <span>
            Страница {snapshot.page} из {pageCount}
          </span>
          <button
            type="button"
            aria-label="Следующая страница Big-Bag"
            disabled={snapshot.page >= pageCount}
            onClick={() => setPageNumber((current) => Math.min(pageCount, current + 1))}
          >
            Далее
          </button>
        </nav>
      ) : null}
    </section>
  );
}
