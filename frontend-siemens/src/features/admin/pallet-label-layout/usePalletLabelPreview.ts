import { useCallback, useEffect, useRef, useState } from 'react';

import type { AdminPalletLabelLayoutApi } from '../../../api/adminPalletLabelLayout';
import { ApiError } from '../../../api/client';
import {
  palletLabelLayoutPreviewKey,
  type PalletLabelLayout,
  type PalletLabelLayoutServerDiagnostics,
} from './palletLabelLayoutModel';

const PREVIEW_DEBOUNCE_MS = 400;

type PreviewState =
  | { phase: 'idle' }
  | { phase: 'loading'; key: string }
  | {
      phase: 'ready';
      key: string;
      url: string;
      diagnostics: PalletLabelLayoutServerDiagnostics;
    }
  | { phase: 'error'; key: string; message: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function palletLayoutPreviewErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW':
        return 'Текст не помещается в выбранные блоки. Увеличьте блок или уменьшите шрифт.';
      case 'PALLET_LABEL_LAYOUT_SOURCE_UNAVAILABLE':
        return 'Источник данных временно недоступен. Выберите другой палетный лист или попробуйте позже.';
      case 'PALLET_LABEL_LAYOUT_SOURCE_NOT_FOUND':
        return 'Палетный лист для предпросмотра не найден. Выберите другой источник.';
      case 'PALLET_LABEL_LAYOUT_INVALID':
        return 'Макет содержит недопустимые параметры. Проверьте размеры и положение блоков.';
      default:
        return 'Точный PNG-предпросмотр недоступен. Попробуйте снова.';
    }
  }
  return errorMessage(error, 'Точный PNG-предпросмотр недоступен.');
}

export function usePalletLabelPreview({
  api,
  layout,
  sourceDocumentId,
}: {
  api: AdminPalletLabelLayoutApi;
  layout: PalletLabelLayout | null;
  sourceDocumentId: string;
}) {
  const [state, setState] = useState<PreviewState>({ phase: 'idle' });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const urlRef = useRef<string | null>(null);
  const immediateKeyRef = useRef<string | null>(null);

  const releaseUrl = useCallback(() => {
    if (!urlRef.current) return;
    URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);

  const render = useCallback(
    async (nextLayout: PalletLabelLayout, nextSourceDocumentId: string) => {
      if (!nextSourceDocumentId) return;
      const previewKey = palletLabelLayoutPreviewKey(nextSourceDocumentId, nextLayout);
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      const generation = ++generationRef.current;
      releaseUrl();
      setState({ phase: 'loading', key: previewKey });
      try {
        const result = await api.preview(
          { sourceDocumentId: nextSourceDocumentId, layout: nextLayout },
          { signal: controller.signal },
        );
        if (controller.signal.aborted || generation !== generationRef.current) return;
        const nextUrl = URL.createObjectURL(result.png);
        urlRef.current = nextUrl;
        setState({
          phase: 'ready',
          key: previewKey,
          url: nextUrl,
          diagnostics: result.diagnostics,
        });
      } catch (previewError: unknown) {
        if (!controller.signal.aborted && generation === generationRef.current) {
          setState({
            phase: 'error',
            key: previewKey,
            message: palletLayoutPreviewErrorMessage(previewError),
          });
        }
      } finally {
        if (generation === generationRef.current) {
          requestRef.current = null;
        }
      }
    },
    [api, releaseUrl],
  );

  useEffect(() => {
    if (!layout) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      requestRef.current?.abort();
      requestRef.current = null;
      generationRef.current += 1;
      releaseUrl();
      setState({ phase: 'idle' });
      return undefined;
    }
    const previewKey = palletLabelLayoutPreviewKey(sourceDocumentId, layout);
    if (sourceDocumentId && immediateKeyRef.current === previewKey) {
      immediateKeyRef.current = null;
      return undefined;
    }
    immediateKeyRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    requestRef.current?.abort();
    requestRef.current = null;
    generationRef.current += 1;
    releaseUrl();
    setState(sourceDocumentId ? { phase: 'loading', key: previewKey } : { phase: 'idle' });
    if (!sourceDocumentId) return undefined;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void render(layout, sourceDocumentId);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [layout, releaseUrl, render, sourceDocumentId]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      requestRef.current?.abort();
      generationRef.current += 1;
      releaseUrl();
    },
    [releaseUrl],
  );

  function renderImmediately(nextLayout: PalletLabelLayout, nextSourceDocumentId: string) {
    if (!nextSourceDocumentId) return;
    immediateKeyRef.current = palletLabelLayoutPreviewKey(nextSourceDocumentId, nextLayout);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void render(nextLayout, nextSourceDocumentId);
  }

  const currentKey =
    layout && sourceDocumentId ? palletLabelLayoutPreviewKey(sourceDocumentId, layout) : null;
  const currentState = 'key' in state && state.key === currentKey ? state : null;

  return {
    url: currentState?.phase === 'ready' ? currentState.url : null,
    pending: currentState?.phase === 'loading',
    error: currentState?.phase === 'error' ? currentState.message : null,
    diagnostics: currentState?.phase === 'ready' ? currentState.diagnostics : null,
    successfulKey: currentState?.phase === 'ready' ? currentState.key : null,
    renderImmediately,
  };
}
