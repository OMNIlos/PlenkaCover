import { useEffect, useState, type ChangeEvent } from 'react';

import {
  adminPalletLabelLayoutApi,
  type AdminPalletLabelLayoutApi,
} from '../../../api/adminPalletLabelLayout';
import { PalletLabelCanvas } from './PalletLabelCanvas';
import { PalletLabelPublicationPanel } from './PalletLabelPublicationPanel';
import {
  PALLET_LABEL_LAYOUT_ELEMENT_IDS,
  PALLET_LABEL_LAYOUT_STORAGE_KEY,
  analyzePalletLabelLayout,
  commitLayoutHistory,
  createBasePalletLabelLayout,
  createLayoutHistory,
  dotsToMillimeters,
  isPalletLabelLayoutPublishable,
  millimetersToDots,
  palletLabelLayoutPreviewKey,
  parsePalletLayoutDraft,
  removeLayoutElement,
  redoLayoutHistory,
  serializePalletLayoutDraft,
  restoreLayoutElement,
  undoLayoutHistory,
  updateLayoutElement,
  type PalletLabelEditorBootstrap,
  type PalletLabelLayout,
  type PalletLabelLayoutElementId,
  type PalletLabelLayoutHistory,
} from './palletLabelLayoutModel';
import { usePalletLabelPreview } from './usePalletLabelPreview';
import { usePalletLabelPublication } from './usePalletLabelPublication';

export { palletLayoutPreviewErrorMessage } from './usePalletLabelPreview';

const ELEMENT_LABELS: Record<PalletLabelLayoutElementId, string> = {
  order: 'Заказ',
  customer: 'Заказчик',
  formedAt: 'Сформировано: дата и время',
  rollCount: 'Рулонов на палете',
  qr: 'QR палетного листа',
  storage: 'Хранение',
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function downloadTextFile(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function PalletLabelLayoutSection({
  api = adminPalletLabelLayoutApi,
}: {
  api?: AdminPalletLabelLayoutApi;
}) {
  const [bootstrap, setBootstrap] = useState<PalletLabelEditorBootstrap | null>(null);
  const [history, setHistory] = useState<PalletLabelLayoutHistory | null>(null);
  const [layout, setLayout] = useState<PalletLabelLayout | null>(null);
  const [sourceDocumentId, setSourceDocumentId] = useState('');
  const [selectedId, setSelectedId] = useState<PalletLabelLayoutElementId>('order');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void api
      .load({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.sources.length === 0) {
          setLoadError('Сервер не вернул источник для предпросмотра.');
          return;
        }
        const firstSource = result.sources[0]?.documentId ?? '';
        let initialLayout = result.editorLayout;
        let initialSource = firstSource;
        try {
          const stored = localStorage.getItem(PALLET_LABEL_LAYOUT_STORAGE_KEY);
          if (stored) {
            const draft = parsePalletLayoutDraft(stored, result.canvas);
            initialLayout = draft.layout;
            if (result.sources.some((source) => source.documentId === draft.sourceDocumentId)) {
              initialSource = draft.sourceDocumentId;
            }
          }
        } catch (error: unknown) {
          setDraftError(errorMessage(error, 'Локальный черновик не удалось прочитать.'));
        }
        setBootstrap(result);
        setHistory(createLayoutHistory(initialLayout));
        setLayout(initialLayout);
        setSourceDocumentId(initialSource);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(errorMessage(error, 'Не удалось загрузить редактор.'));
        }
      });
    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (!layout) return;
    try {
      localStorage.setItem(
        PALLET_LABEL_LAYOUT_STORAGE_KEY,
        serializePalletLayoutDraft({ sourceDocumentId, layout }),
      );
    } catch (error: unknown) {
      setDraftError(errorMessage(error, 'Не удалось сохранить локальный черновик.'));
    }
  }, [layout, sourceDocumentId]);

  const preview = usePalletLabelPreview({ api, layout, sourceDocumentId });
  const diagnostics =
    layout && bootstrap ? analyzePalletLabelLayout(layout, bootstrap.canvas) : null;
  const previewIsCurrent = Boolean(
    layout &&
      preview.successfulKey === palletLabelLayoutPreviewKey(sourceDocumentId, layout),
  );
  const publishable = Boolean(
    diagnostics &&
      previewIsCurrent &&
      isPalletLabelLayoutPublishable(diagnostics, preview.diagnostics),
  );
  const publication = usePalletLabelPublication({
    api,
    activePublication: bootstrap?.activePublication ?? null,
    sourceDocumentId,
    layout,
    publishable,
    onPublished: (published) => {
      setBootstrap((current) =>
        current
          ? { ...current, activePublication: published, editorLayout: published.layout }
          : current,
      );
      setHistory(createLayoutHistory(published.layout));
      setLayout(published.layout);
    },
    onMetadataRefreshed: (refreshed) => {
      setBootstrap((current) =>
        current
          ? {
              ...current,
              activePublication: refreshed.activePublication,
              editorLayout: refreshed.editorLayout,
              sources: refreshed.sources,
            }
          : current,
      );
    },
  });

  function commitLayout(nextLayout: PalletLabelLayout, immediatePreview = false) {
    if (!history || publication.pending) return;
    publication.clearFeedback();
    setHistory((current) => (current ? commitLayoutHistory(current, nextLayout) : current));
    setLayout(nextLayout);
    if (immediatePreview && sourceDocumentId) {
      preview.renderImmediately(nextLayout, sourceDocumentId);
    }
  }

  function applyHistory(nextHistory: PalletLabelLayoutHistory) {
    if (publication.pending) return;
    publication.clearFeedback();
    setHistory(nextHistory);
    setLayout(nextHistory.present);
  }

  function updateSelected(patch: Parameters<typeof updateLayoutElement>[2]) {
    if (!layout || !bootstrap) return;
    commitLayout(updateLayoutElement(layout, selectedId, patch, bootstrap.canvas));
  }

  function removeBlock(id: PalletLabelLayoutElementId) {
    if (!layout) return;
    const nextLayout = removeLayoutElement(layout, id);
    if (nextLayout === layout) return;
    if (selectedId === id) setSelectedId(nextLayout.elements[0]?.id ?? 'qr');
    commitLayout(nextLayout, true);
  }

  function restoreBlock(id: PalletLabelLayoutElementId) {
    if (!layout) return;
    const nextLayout = restoreLayoutElement(layout, id);
    if (nextLayout === layout) return;
    setSelectedId(id);
    commitLayout(nextLayout, true);
  }

  async function importDraft(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !bootstrap || publication.pending) return;
    try {
      const draft = parsePalletLayoutDraft(await file.text(), bootstrap.canvas);
      const importedSource = bootstrap.sources.some(
        (source) => source.documentId === draft.sourceDocumentId,
      )
        ? draft.sourceDocumentId
        : (bootstrap.sources[0]?.documentId ?? '');
      setDraftError(null);
      publication.clearFeedback();
      setSourceDocumentId(importedSource);
      setHistory(createLayoutHistory(draft.layout));
      setLayout(draft.layout);
    } catch (error: unknown) {
      setDraftError(errorMessage(error, 'Не удалось импортировать черновик.'));
    }
  }

  if (loadError) {
    return (
      <section className="surface pallet-layout-editor" aria-label="Макет палетного листа">
        <h2>Макет палетного листа</h2>
        <p className="pallet-layout-error" role="alert">
          {loadError}
        </p>
      </section>
    );
  }

  if (!bootstrap || !history || !layout || !diagnostics) {
    return (
      <section className="surface pallet-layout-editor" aria-label="Макет палетного листа">
        <h2>Макет палетного листа</h2>
        <p role="status">Загружаем черновик и источники…</p>
      </section>
    );
  }

  const selected =
    layout.elements.find((element) => element.id === selectedId) ?? layout.elements[0];
  const canvas = bootstrap.canvas;
  const inputDisabled = selected.locked;
  const activePublication = bootstrap.activePublication;

  function geometryInput(label: string, property: 'xDots' | 'yDots' | 'widthDots' | 'heightDots') {
    return (
      <label>
        <span>{label}</span>
        <input
          type="number"
          aria-label={label}
          min={0}
          max={100}
          step={1}
          value={dotsToMillimeters(selected[property], canvas)}
          disabled={inputDisabled || publication.pending}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) {
              updateSelected({ [property]: millimetersToDots(value, canvas) });
            }
          }}
        />
      </label>
    );
  }

  return (
    <section
      className="surface pallet-layout-editor"
      aria-label="Макет палетного листа"
      aria-busy={publication.pending}
    >
      <header className="pallet-layout-editor-head">
        <div>
          <p className="eyebrow">Администратор · макет печати</p>
          <h2>Макет палетного листа</h2>
          <p>Точный серверный PNG подтверждает будущий печатный результат.</p>
        </div>
        <div className="pallet-layout-publication-status" role="status">
          <strong>
            {activePublication
              ? `Активный макет v${activePublication.version}`
              : 'Базовый макет v2'}
          </strong>
          <span>{activePublication ? activePublication.contentHash.slice(0, 8) : 'До публикации'}</span>
        </div>
      </header>

      {activePublication?.layout.schemaVersion === 1 ? (
        <p className="pallet-layout-legacy-notice" role="status">
          Сейчас печатается исторический макет V1. На холсте открыт новый V2-черновик. Новый V2
          начнет применяться только после публикации.
        </p>
      ) : null}

      <div className="pallet-layout-toolbar" aria-label="Действия с черновиком">
        <label className="pallet-layout-source">
          <span>Источник данных</span>
          <select
            aria-label="Источник данных для предпросмотра"
            value={sourceDocumentId}
            disabled={publication.pending}
            onChange={(event) => {
              publication.clearFeedback();
              setSourceDocumentId(event.target.value);
            }}
          >
            {bootstrap.sources.map((source) => (
              <option key={source.documentId} value={source.documentId}>
                {source.label} · {source.rollCount} рул.
              </option>
            ))}
          </select>
        </label>
        <div className="pallet-layout-toolbar-actions">
          <button
            type="button"
            aria-label="Отменить изменение"
            disabled={history.past.length === 0 || publication.pending}
            onClick={() => applyHistory(undoLayoutHistory(history))}
          >
            Назад
          </button>
          <button
            type="button"
            aria-label="Вернуть изменение"
            disabled={history.future.length === 0 || publication.pending}
            onClick={() => applyHistory(redoLayoutHistory(history))}
          >
            Вперед
          </button>
          <button
            type="button"
            disabled={publication.pending}
            onClick={() => {
              setSelectedId('order');
              commitLayout(createBasePalletLabelLayout(), true);
            }}
          >
            Сбросить к исходному
          </button>
          <button
            type="button"
            disabled={publication.pending}
            onClick={() =>
              downloadTextFile(
                `pallet-label-layout-${sourceDocumentId || 'draft'}.json`,
                serializePalletLayoutDraft({ sourceDocumentId, layout }),
              )
            }
          >
            Скачать JSON
          </button>
          <label className="pallet-layout-import-button">
            Загрузить JSON
            <input
              type="file"
              accept="application/json,.json"
              disabled={publication.pending}
              onChange={importDraft}
            />
          </label>
          <button
            type="button"
            className="pallet-layout-publish-button"
            aria-label="Опубликовать и применить"
            disabled={!publication.canStart}
            onClick={publication.openConfirmation}
          >
            {publication.pending ? 'Публикуем…' : 'Опубликовать и применить'}
          </button>
        </div>
      </div>

      <PalletLabelPublicationPanel
        confirmationOpen={publication.confirmationOpen}
        reason={publication.reason}
        trimmedReasonLength={publication.trimmedReason.length}
        pending={publication.pending}
        canConfirm={publication.canConfirm}
        feedback={publication.feedback}
        metadataStale={publication.metadataStale}
        refreshPending={publication.refreshPending}
        onReasonChange={publication.setReason}
        onCancel={publication.closeConfirmation}
        onConfirm={() => void publication.publish()}
        onRefreshMetadata={() => void publication.refreshMetadata()}
      />

      {draftError ? (
        <p className="pallet-layout-error" role="alert">
          {draftError}
        </p>
      ) : null}

      <div
        className={`pallet-layout-diagnostics${
          diagnostics.beyondProvenCut.length > 0 ||
          diagnostics.outsideSafeArea.length > 0 ||
          diagnostics.overlaps.length > 0
            ? ' has-warning'
            : ''
        }`}
        role="status"
        aria-label="Диагностика макета"
      >
        <strong>Диагностика размещения</strong>
        <span>
          {diagnostics.beyondProvenCut.length > 0
            ? `За гарантированной зоной: ${diagnostics.beyondProvenCut
                .map((id) => ELEMENT_LABELS[id])
                .join(', ')}`
            : 'Все блоки в гарантированной зоне'}
        </span>
        {preview.diagnostics?.overlaps.length ? (
          <span>
            Сервер подтвердил пересечение блоков:{' '}
            {preview.diagnostics.overlaps
              .map(({ first, second }) => `${ELEMENT_LABELS[first]} ↔ ${ELEMENT_LABELS[second]}`)
              .join('; ')}
          </span>
        ) : null}
        <span>
          {diagnostics.outsideSafeArea.length > 0
            ? `За безопасной границей: ${diagnostics.outsideSafeArea
                .map((id) => ELEMENT_LABELS[id])
                .join(', ')}`
            : 'Все блоки внутри безопасной границы'}
        </span>
        <span>
          {diagnostics.overlaps.length > 0
            ? `Пересечения: ${diagnostics.overlaps
                .map(([left, right]) => `${ELEMENT_LABELS[left]} ↔ ${ELEMENT_LABELS[right]}`)
                .join('; ')}`
            : 'Пересечений нет'}
        </span>
      </div>

      <div className="pallet-layout-workspace">
        <div className="pallet-layout-design-column">
          <div className="pallet-layout-canvas-head">
            <strong>Размещение · 100×100 мм</strong>
            <span>Сетка 1 мм · клавиши ←↑→↓ · Shift = 5 мм</span>
          </div>
          <PalletLabelCanvas
            layout={layout}
            canvas={bootstrap.canvas}
            selectedId={selectedId}
            disabled={publication.pending}
            onSelect={setSelectedId}
            onTransientLayout={setLayout}
            onCommitLayout={commitLayout}
          />
        </div>

        <aside className="pallet-layout-catalog" aria-label="Каталог системных блоков">
          <header>
            <span>Каталог элементов</span>
            <strong>Только системные блоки</strong>
          </header>
          <ul>
            {PALLET_LABEL_LAYOUT_ELEMENT_IDS.map((id) => {
              const present = layout.elements.some((element) => element.id === id);
              const required = id === 'qr';
              return (
                <li key={id} data-catalog-element={id}>
                  <span>{ELEMENT_LABELS[id]}</span>
                  {required ? (
                    <strong>Обязательный</strong>
                  ) : (
                    <button
                      type="button"
                      aria-label={`${present ? 'Удалить' : 'Вернуть'} блок ${ELEMENT_LABELS[id]}`}
                      disabled={publication.pending}
                      onClick={() => (present ? removeBlock(id) : restoreBlock(id))}
                    >
                      {present ? 'Удалить' : 'Вернуть'}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </aside>

        <aside className="pallet-layout-inspector" aria-label="Параметры блока">
          <header>
            <span>Выбран блок</span>
            <strong>{ELEMENT_LABELS[selected.id]}</strong>
          </header>
          {selected.locked ? (
            <p className="pallet-layout-lock-note" role="status">
              QR зафиксирован: размер и тихая зона не меняются.
            </p>
          ) : null}
          <div className="pallet-layout-inspector-grid">
            {geometryInput('X, мм', 'xDots')}
            {geometryInput('Y, мм', 'yDots')}
            {geometryInput('Ширина, мм', 'widthDots')}
            {geometryInput('Высота, мм', 'heightDots')}
            <label className="pallet-layout-font-input">
              <span>Максимальный размер шрифта</span>
              <input
                type="number"
                aria-label="Максимальный размер шрифта"
                min={selected.minFontSize || 0}
                max={96}
                step={1}
                value={selected.maxFontSize}
                disabled={inputDisabled || publication.pending}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isFinite(value)) updateSelected({ maxFontSize: value });
                }}
              />
            </label>
          </div>
          {!selected.locked ? (
            <small>Минимальный шрифт для автоподбора: {selected.minFontSize} px.</small>
          ) : null}
        </aside>

        <aside className="pallet-layout-preview" aria-label="Точный PNG-предпросмотр">
          <header>
            <strong>Точный PNG с сервера</strong>
            <span>{preview.pending ? 'Обновляем…' : 'Предпросмотр без активации'}</span>
          </header>
          {preview.url ? <img src={preview.url} alt="Точный макет с данными палеты" /> : null}
          {!preview.url && !preview.error ? (
            <div className="pallet-layout-preview-empty" role="status">
              Первый точный кадр появится через 0,4 с.
            </div>
          ) : null}
          {preview.error ? (
            <p className="pallet-layout-error" role="alert">
              {preview.error}
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
