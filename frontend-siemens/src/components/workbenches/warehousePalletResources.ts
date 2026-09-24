import { useEffect, useState } from 'react';

import { ApiError } from '../../api/client';
import {
  fetchWarehousePalletPreview,
  fetchWarehousePrinters,
  type ServerWarehousePrinter,
} from '../../api/warehouse';
import type { PalletListDocument } from '../../domain/types';
import { isLivePalletListTemplateVersion } from '../../domain/palletListPrint';
import { chooseWarehousePrinterId } from './warehousePalletPrint';

const PRINTER_STORAGE_KEY = 'plenki:warehouse-printer-id:v1';

function readSavedPrinterId(): string | null {
  try {
    return window.localStorage.getItem(PRINTER_STORAGE_KEY);
  } catch {
    return null;
  }
}

function savePrinterId(printerId: string) {
  try {
    window.localStorage.setItem(PRINTER_STORAGE_KEY, printerId);
  } catch {
    // A hardened browser may disable storage; the explicit choice still works for this session.
  }
}

export function warehouseRequestErrorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError) return 'Нет связи с платформой.';
  return error instanceof Error ? error.message : 'Не удалось загрузить палетный лист.';
}

export function palletDocumentUsesLiveResources(document: PalletListDocument) {
  return (
    document.status === 'ready' &&
    isLivePalletListTemplateVersion(document.templateVersion) &&
    document.fieldSetStatus === 'contract_ready'
  );
}

export function warehousePrinterStatusLabel(printer: ServerWarehousePrinter) {
  if (printer.ready) return 'готов';
  return printer.unavailableReason?.trim() || printer.status || 'недоступен';
}

export function useWarehousePrinterResources(
  resourceKey: string,
  enabled = true,
  loadPrinters: () => Promise<ServerWarehousePrinter[]> = fetchWarehousePrinters,
) {
  const [printers, setPrinters] = useState<ServerWarehousePrinter[]>([]);
  const [selectedPrinterId, setSelectedPrinterId] = useState<string | null>(null);
  const [printersPending, setPrintersPending] = useState(true);
  const [printerError, setPrinterError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setPrinters([]);
    setSelectedPrinterId(null);
    setPrinterError(null);
    if (!enabled) {
      setPrintersPending(false);
      return undefined;
    }
    setPrintersPending(true);

    void loadPrinters()
      .then((nextPrinters) => {
        if (cancelled) return;
        setPrinters(nextPrinters);
        setSelectedPrinterId(chooseWarehousePrinterId(nextPrinters, readSavedPrinterId()));
      })
      .catch((error: unknown) => {
        if (!cancelled) setPrinterError(warehouseRequestErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setPrintersPending(false);
      });

    return () => {
      cancelled = true;
    };
  }, [resourceKey, enabled, loadPrinters, reloadKey]);

  function selectPrinter(printerId: string) {
    setSelectedPrinterId(printerId || null);
    if (printerId) savePrinterId(printerId);
  }

  return {
    printers,
    selectedPrinterId,
    selectPrinter,
    printersPending,
    printerError,
    reloadPrinters: () => setReloadKey((key) => key + 1),
  };
}

export function usePalletLabelResources(
  documentId: string,
  enabled = true,
  printersEnabled = enabled,
) {
  const printerResources = useWarehousePrinterResources(documentId, printersEnabled);
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const previewRequestKey = `${documentId}:${enabled ? 'enabled' : 'disabled'}:${previewReloadKey}`;
  const [previewState, setPreviewState] = useState<{
    requestKey: string;
    status: 'disabled' | 'loading' | 'ready' | 'error';
    blob: Blob | null;
    url: string | null;
    error: string | null;
  }>({
    requestKey: '',
    status: 'loading',
    blob: null,
    url: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    let nextPreviewUrl: string | null = null;

    if (!enabled) {
      setPreviewState({
        requestKey: previewRequestKey,
        status: 'disabled',
        blob: null,
        url: null,
        error: null,
      });
      return undefined;
    }
    setPreviewState({
      requestKey: previewRequestKey,
      status: 'loading',
      blob: null,
      url: null,
      error: null,
    });

    void fetchWarehousePalletPreview(documentId)
      .then((preview) => {
        nextPreviewUrl = URL.createObjectURL(preview);
        if (cancelled) {
          URL.revokeObjectURL(nextPreviewUrl);
          nextPreviewUrl = null;
          return;
        }
        setPreviewState({
          requestKey: previewRequestKey,
          status: 'ready',
          blob: preview,
          url: nextPreviewUrl,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreviewState({
          requestKey: previewRequestKey,
          status: 'error',
          blob: null,
          url: null,
          error: warehouseRequestErrorMessage(error),
        });
      });

    return () => {
      cancelled = true;
      if (nextPreviewUrl) URL.revokeObjectURL(nextPreviewUrl);
    };
  }, [documentId, enabled, previewReloadKey, previewRequestKey]);

  const currentPreview = previewState.requestKey === previewRequestKey ? previewState : null;

  return {
    ...printerResources,
    previewBlob: currentPreview?.blob ?? null,
    previewUrl: currentPreview?.url ?? null,
    previewPending: enabled && (!currentPreview || currentPreview.status === 'loading'),
    previewError: currentPreview?.error ?? null,
    reload: () => {
      printerResources.reloadPrinters();
      setPreviewReloadKey((key) => key + 1);
    },
  };
}
