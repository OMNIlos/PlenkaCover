import { useEffect, useState } from 'react';

export function CommercialFinanceNotePanel({
  value,
  editable,
  onSave,
}: {
  value?: string | null;
  editable: boolean;
  onSave: (value: string | null) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const normalized = draft.trim();
  const unchanged = normalized === (value?.trim() ?? '');

  useEffect(() => {
    setDraft(value ?? '');
    setFeedback(null);
  }, [value]);

  async function save() {
    setBusy(true);
    setFeedback(null);
    const saved = await onSave(normalized || null);
    setFeedback(saved ? 'Комментарий сохранён.' : 'Комментарий не сохранён.');
    setBusy(false);
  }

  return (
    <section className="commercial-finance-note-panel" aria-label="Комментарий для бухгалтерии">
      <header>
        <span>Бухгалтерия</span>
        <h3>Комментарий / ориентир цены</h3>
      </header>
      <textarea
        value={draft}
        rows={3}
        maxLength={2000}
        disabled={!editable || busy}
        placeholder="Например: 1200 за 20 рулонов"
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setFeedback(null);
        }}
      />
      <div>
        <small>
          {editable
            ? 'Свободный текст, не официальная сумма счёта.'
            : 'Редактирование недоступно.'}
        </small>
        {editable ? (
          <button type="button" disabled={busy || unchanged} onClick={() => void save()}>
            {busy ? 'Сохраняем…' : 'Сохранить комментарий'}
          </button>
        ) : null}
      </div>
      {feedback ? <p role="status">{feedback}</p> : null}
    </section>
  );
}
