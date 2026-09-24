import { useState } from 'react';

import type { OperatorShift } from '../../domain/types';

type ShiftBag = NonNullable<OperatorShift['bags']>[number];

type ReleaseDraft = {
  endKg: string;
};

function parseEndKg(value: string): number | null {
  const parsed = Number(value.trim().replace(',', '.'));
  return value.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatKg(value: number): string {
  return `${new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 3,
  }).format(value)} кг`;
}

export function OperatorActiveBigBagPanel({
  bags,
  onRelease,
}: {
  bags: readonly ShiftBag[];
  onRelease?: (bagId: string, input: { endKg: number }) => Promise<void> | void;
}) {
  const [drafts, setDrafts] = useState<Record<string, ReleaseDraft>>({});
  const [busyBagId, setBusyBagId] = useState<string | null>(null);
  const [errorByBag, setErrorByBag] = useState<Record<string, string>>({});
  const activeBags = bags.filter((bag) => bag.active);
  const releasedBags = bags.filter((bag) => !bag.active);

  function updateDraft(bagId: string, update: Partial<ReleaseDraft>) {
    setDrafts((current) => ({
      ...current,
      [bagId]: {
        endKg: current[bagId]?.endKg ?? '',
        ...update,
      },
    }));
    setErrorByBag((current) => {
      if (!(bagId in current)) return current;
      const next = { ...current };
      delete next[bagId];
      return next;
    });
  }

  async function release(bag: ShiftBag) {
    const draft = drafts[bag.bagId] ?? { endKg: '' };
    const endKg = parseEndKg(draft.endKg);
    if (endKg === null || endKg > bag.startKg || !onRelease || busyBagId !== null) {
      return;
    }
    setBusyBagId(bag.bagId);
    try {
      await onRelease(bag.bagId, { endKg });
    } catch (error) {
      setErrorByBag((current) => ({
        ...current,
        [bag.bagId]:
          error instanceof Error ? error.message : 'Big-Bag не сдан. Повторите действие.',
      }));
    } finally {
      setBusyBagId(null);
    }
  }

  return (
    <section className="operator-active-bigbags" aria-label="Big-Bag текущей смены">
      <header>
        <div>
          <h4>Текущие Big-Bag</h4>
          <span>Можно взвесить и сдать отдельный мешок, не останавливая смену.</span>
        </div>
        <strong>{activeBags.length} в работе</strong>
      </header>

      {activeBags.length === 0 ? (
        <div className="operator-active-bigbags-empty" role="status">
          <strong>Нет активного Big-Bag</strong>
          <span>Подключите следующий мешок или сдайте смену.</span>
        </div>
      ) : (
        <div className="operator-active-bigbags-list">
          {activeBags.map((bag) => {
            const draft = drafts[bag.bagId] ?? { endKg: '' };
            const endKg = parseEndKg(draft.endKg);
            const weightTooHigh = endKg !== null && endKg > bag.startKg;
            const ready = endKg !== null && !weightTooHigh && Boolean(onRelease);
            return (
              <article key={bag.bagId}>
                <div className="operator-active-bigbag-title">
                  <span>
                    <strong>{bag.code}</strong>
                    <small>{bag.material}</small>
                  </span>
                  <span>
                    Старт <strong>{formatKg(bag.startKg)}</strong>
                  </span>
                </div>
                <div className="operator-active-bigbag-release">
                  <label>
                    <span>Финальный вес, кг</span>
                    <input
                      aria-label={`Финальный вес ${bag.code}, кг`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max={bag.startKg}
                      step="0.001"
                      value={draft.endKg}
                      disabled={busyBagId !== null}
                      aria-invalid={weightTooHigh || undefined}
                      onChange={(event) =>
                        updateDraft(bag.bagId, {
                          endKg: event.currentTarget.value,
                        })
                      }
                    />
                    {weightTooHigh ? (
                      <small role="alert">Финальный вес не может быть больше стартового</small>
                    ) : null}
                  </label>
                  <button
                    type="button"
                    className="action-recommended"
                    disabled={!ready || busyBagId !== null}
                    aria-busy={busyBagId === bag.bagId}
                    onClick={() => void release(bag)}
                  >
                    {busyBagId === bag.bagId ? 'Сдаём…' : 'Сдать Big-Bag'}
                  </button>
                </div>
                {errorByBag[bag.bagId] ? (
                  <div className="operator-active-bigbag-error" role="alert">
                    {errorByBag[bag.bagId]}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {releasedBags.length > 0 ? (
        <details className="operator-released-bigbags">
          <summary>Уже сданы ({releasedBags.length})</summary>
          <ul>
            {releasedBags.map((bag) => (
              <li key={bag.bagId}>
                <span>
                  <strong>{bag.code}</strong>
                  <small>{bag.material}</small>
                </span>
                <span>
                  {bag.endKg === null ? 'Вес не указан' : formatKg(bag.endKg)}
                  {bag.releasedReason ? ` · ${bag.releasedReason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
