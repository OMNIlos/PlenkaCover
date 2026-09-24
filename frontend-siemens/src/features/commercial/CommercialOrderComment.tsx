import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CommercialOrderCommentCommand } from './api';

const COMMENT_LIMIT = 1000;

export type CommercialOrderCommentProps = {
  comment: string | null;
  version: number;
  editable: boolean;
  onSave: (command: CommercialOrderCommentCommand) => Promise<boolean>;
};

export function CommercialOrderComment({
  comment,
  version,
  editable,
  onSave,
}: CommercialOrderCommentProps) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const editableRef = useRef(editable);
  editableRef.current = editable;

  const openEditor = () => {
    setDraft(comment ?? '');
    setEditVersion(version);
    setEditing(true);
  };

  const closeEditor = () => {
    setEditing(false);
    setEditVersion(null);
  };

  useEffect(() => {
    if (!editable) {
      setEditing(false);
      setEditVersion(null);
    }
  }, [editable]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !editableRef.current ||
      editVersion === null ||
      submitting ||
      draft.length > COMMENT_LIMIT
    ) {
      return;
    }

    setSubmitting(true);
    let saved = false;
    try {
      saved = await onSave({ expectedVersion: editVersion, comment: draft.trim() });
    } catch {
      saved = false;
    } finally {
      setSubmitting(false);
    }
    if (saved) closeEditor();
  };

  return (
    <section className="commercial-order-comment" aria-labelledby="commercial-comment-title">
      <header>
        <h3 id="commercial-comment-title">Комментарий к заявке</h3>
        {editable && !editing && (
          <button type="button" onClick={openEditor}>
            {comment ? 'Изменить комментарий' : 'Добавить комментарий'}
          </button>
        )}
      </header>
      {editing && editable ? (
        <form onSubmit={(event) => void submit(event)}>
          <label>
            <span>Комментарий к заявке</span>
            <textarea
              aria-label="Комментарий к заявке"
              autoFocus
              value={draft}
              disabled={submitting}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <div className="commercial-order-comment-actions">
            <span aria-live="polite">
              {draft.length} / {COMMENT_LIMIT}
            </span>
            <button
              type="button"
              disabled={submitting}
              onClick={closeEditor}
            >
              Отмена
            </button>
            <button type="submit" disabled={submitting || draft.length > COMMENT_LIMIT}>
              {submitting ? 'Сохраняем…' : 'Сохранить'}
            </button>
          </div>
        </form>
      ) : (
        <p className={comment ? undefined : 'muted'}>{comment || 'Комментарий не добавлен.'}</p>
      )}
    </section>
  );
}
