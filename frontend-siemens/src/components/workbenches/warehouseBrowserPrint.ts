import { isDeliveryUncertain } from '../../api/idempotentOperation';
import {
  palletListPrintProfile,
  type PalletListPrintProfile,
  type PalletListTemplateVersion,
} from '../../domain/palletListProfiles';

const PRINT_CLEANUP_DELAY_MS = 60_000;

const BIG_BAG_PRINT_PROFILE = {
  widthMm: 58,
  heightMm: 50,
  previewWidthPx: 464,
  previewHeightPx: 400,
} as const;

export type WarehousePalletPrintLayout = {
  pageWidthMm: number;
  pageHeightMm: number;
  imageWidthMm: number;
  imageHeightMm: number;
  imageOffsetLeftMm: number;
  imageOffsetTopMm: number;
  rotationDegrees: 0 | 90;
  layoutMarker: string | null;
};

export function warehousePalletPrintLayout(
  templateVersion: PalletListTemplateVersion,
): WarehousePalletPrintLayout {
  const profile = palletListPrintProfile(templateVersion);
  const imageOffsetMm = profile.imageMarginMm ?? 0;
  return {
    pageWidthMm: profile.widthMm,
    pageHeightMm: profile.heightMm,
    imageWidthMm: profile.imageWidthMm ?? profile.widthMm,
    imageHeightMm: profile.imageHeightMm ?? profile.heightMm,
    imageOffsetLeftMm: imageOffsetMm,
    imageOffsetTopMm: imageOffsetMm,
    rotationDegrees: profile.rotationDegrees,
    layoutMarker: profile.layoutMarker ?? null,
  };
}

export function warehousePalletPageSize(
  templateVersion: PalletListTemplateVersion,
): Pick<PalletListPrintProfile, 'widthMm' | 'heightMm'> {
  const layout = warehousePalletPrintLayout(templateVersion);
  return { widthMm: layout.pageWidthMm, heightMm: layout.pageHeightMm };
}

export function warehousePalletPreviewMatchesProfile(
  templateVersion: PalletListTemplateVersion,
  widthPx: number,
  heightPx: number,
) {
  const profile = palletListPrintProfile(templateVersion);
  return widthPx === profile.previewWidthPx && heightPx === profile.previewHeightPx;
}

export function warehousePalletPageSizeLabel(templateVersion: PalletListTemplateVersion) {
  const { widthMm, heightMm } = warehousePalletPageSize(templateVersion);
  return `${widthMm} × ${heightMm} мм`;
}

export function createWarehouseSystemPrintRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    bytes.forEach((_, index) => {
      bytes[index] = Math.floor(Math.random() * 256);
    });
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

export class WarehouseSystemPrintContinuationError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Не удалось открыть системную печать.', {
      cause,
    });
    this.name = 'WarehouseSystemPrintContinuationError';
  }
}

export class WarehouseSystemPrintIntentGate {
  private retry: { intentKey: string; requestId: string } | null = null;
  private pending: { intentKey: string; request: Promise<unknown> } | null = null;
  private generation = 0;

  hasPendingRetry(): boolean {
    return this.retry !== null;
  }

  run<T>(submit: (requestId: string) => Promise<T>, intentKey = 'default'): Promise<T> {
    if (this.pending) {
      if (this.pending.intentKey === intentKey) return this.pending.request as Promise<T>;
      return Promise.reject(
        new Error('Незавершённую системную печать нельзя изменить. Сначала повторите её.'),
      );
    }
    if (this.retry && this.retry.intentKey !== intentKey) {
      return Promise.reject(
        new Error('Незавершённую системную печать нельзя изменить. Сначала повторите её.'),
      );
    }

    const generation = this.generation;
    let requestId: string;
    try {
      requestId = this.retry?.requestId ?? createWarehouseSystemPrintRequestId();
    } catch (error) {
      return Promise.reject(error);
    }
    this.retry = { intentKey, requestId };

    let submission: Promise<T>;
    try {
      submission = submit(requestId);
    } catch (error) {
      submission = Promise.reject(error);
    }
    const request = submission
      .then((result) => {
        if (this.generation === generation && this.retry?.requestId === requestId) {
          this.retry = null;
        }
        return result;
      })
      .catch((error: unknown) => {
        if (
          this.generation === generation &&
          this.retry?.requestId === requestId &&
          !isDeliveryUncertain(error) &&
          !(error instanceof WarehouseSystemPrintContinuationError)
        ) {
          this.retry = null;
        }
        throw error;
      })
      .finally(() => {
        if (this.generation === generation && this.pending?.request === request) {
          this.pending = null;
        }
      });
    this.pending = { intentKey, request };
    return request;
  }

  reset() {
    this.generation += 1;
    this.retry = null;
    this.pending = null;
  }
}

function escapeHtmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function warehouseBigBagPreviewMatchesProfile(widthPx: number, heightPx: number) {
  return (
    widthPx === BIG_BAG_PRINT_PROFILE.previewWidthPx &&
    heightPx === BIG_BAG_PRINT_PROFILE.previewHeightPx
  );
}

export function warehouseBigBagPrintMarkup(previewUrl: string) {
  const { widthMm, heightMm } = BIG_BAG_PRINT_PROFILE;
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <title>QR-этикетка Big-Bag</title>
    <style>
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      html, body { width: ${widthMm}mm; height: ${heightMm}mm; margin: 0; padding: 0; overflow: hidden; }
      body { background: #fff; }
      img { display: block; width: ${widthMm}mm; height: ${heightMm}mm; object-fit: fill; }
    </style>
  </head>
  <body data-print-layout="bigbag-58x50-v1">
    <img id="bigbag-preview" src="${escapeHtmlAttribute(previewUrl)}" alt="">
  </body>
</html>`;
}

export function warehousePalletPrintMarkup(
  previewUrl: string,
  templateVersion: PalletListTemplateVersion,
) {
  const layout = warehousePalletPrintLayout(templateVersion);
  const {
    pageWidthMm: widthMm,
    pageHeightMm: heightMm,
    imageWidthMm,
    imageHeightMm,
    imageOffsetLeftMm,
    imageOffsetTopMm,
    rotationDegrees,
    layoutMarker,
  } = layout;
  const rotationCss =
    rotationDegrees === 90 ? ' transform: rotate(90deg); transform-origin: 50% 50%;' : '';
  const marginCss =
    imageOffsetLeftMm === 0 && imageOffsetTopMm === 0
      ? ''
      : imageOffsetLeftMm === imageOffsetTopMm
        ? ` margin: ${imageOffsetTopMm}mm;`
        : ` margin: ${imageOffsetTopMm}mm 0 0 ${imageOffsetLeftMm}mm;`;
  const bodyLayoutAttribute = layoutMarker ? ` data-print-layout="${layoutMarker}"` : '';
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <title>Палетный лист</title>
    <style>
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      html, body { width: ${widthMm}mm; height: ${heightMm}mm; margin: 0; padding: 0; overflow: hidden; }
      body { background: #fff; }
      img { display: block; width: ${imageWidthMm}mm; height: ${imageHeightMm}mm;${marginCss} object-fit: fill;${rotationCss} }
    </style>
  </head>
  <body${bodyLayoutAttribute}>
    <img id="pallet-preview" src="${escapeHtmlAttribute(previewUrl)}" alt="">
  </body>
</html>`;
}

/** Keeps an immutable backend preview alive through the browser-owned system print dialog. */
type WarehouseImageSystemPrintOptions = {
  frameTitle: string;
  imageId: string;
  markup(previewUrl: string): string;
  previewMatches(widthPx: number, heightPx: number): boolean;
  preparationError: string;
  sizeError: string;
  loadError: string;
};

function openWarehouseImageSystemPrint(
  preview: Blob,
  options: WarehouseImageSystemPrintOptions,
): Promise<void> {
  if (typeof document === 'undefined' || !document.body || typeof URL === 'undefined') {
    return Promise.reject(new Error('Системная печать недоступна в этом браузере.'));
  }

  const previewUrl = URL.createObjectURL(preview);
  const frame = document.createElement('iframe');
  frame.title = options.frameTitle;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.position = 'fixed';
  frame.style.left = '-10000px';
  frame.style.bottom = '0';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.border = '0';
  frame.style.opacity = '0';
  frame.style.pointerEvents = 'none';

  return new Promise<void>((resolve, reject) => {
    let printStarted = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (cleanupTimer) clearTimeout(cleanupTimer);
      cleanupTimer = null;
      URL.revokeObjectURL(previewUrl);
      frame.remove();
    };
    const fail = (message: string, cause?: unknown) => {
      cleanup();
      reject(new Error(message, cause === undefined ? undefined : { cause }));
    };

    frame.onload = () => {
      const printWindow = frame.contentWindow;
      const image = frame.contentDocument?.getElementById(
        options.imageId,
      ) as HTMLImageElement | null;
      if (!printWindow || !image) {
        fail(options.preparationError);
        return;
      }

      const print = () => {
        if (printStarted) return;
        if (!options.previewMatches(image.naturalWidth, image.naturalHeight)) {
          fail(options.sizeError);
          return;
        }
        printStarted = true;
        try {
          printWindow.addEventListener('afterprint', cleanup, { once: true });
          cleanupTimer = setTimeout(cleanup, PRINT_CLEANUP_DELAY_MS);
          printWindow.focus();
          printWindow.print();
          resolve();
        } catch (error) {
          fail('Браузер не открыл системное окно печати.', error);
        }
      };

      if (image.complete) {
        if (image.naturalWidth > 0) print();
        else fail(options.loadError);
        return;
      }
      image.addEventListener('load', print, { once: true });
      image.addEventListener('error', () => fail(options.loadError), {
        once: true,
      });
    };

    frame.srcdoc = options.markup(previewUrl);
    try {
      document.body.appendChild(frame);
    } catch (error) {
      fail('Не удалось открыть системную печать в этом браузере.', error);
    }
  });
}

export function openWarehousePalletSystemPrint(
  preview: Blob,
  templateVersion: PalletListTemplateVersion,
): Promise<void> {
  return openWarehouseImageSystemPrint(preview, {
    frameTitle: 'Системная печать палетного листа',
    imageId: 'pallet-preview',
    markup: (previewUrl) => warehousePalletPrintMarkup(previewUrl, templateVersion),
    previewMatches: (widthPx, heightPx) =>
      warehousePalletPreviewMatchesProfile(templateVersion, widthPx, heightPx),
    preparationError: 'Не удалось подготовить системную печать палетного листа.',
    sizeError: 'Размер предпросмотра не совпадает с форматом палетного листа.',
    loadError: 'Предпросмотр палетного листа не загрузился.',
  });
}

export function openWarehouseBigBagSystemPrint(preview: Blob): Promise<void> {
  return openWarehouseImageSystemPrint(preview, {
    frameTitle: 'Системная печать QR-этикетки Big-Bag',
    imageId: 'bigbag-preview',
    markup: warehouseBigBagPrintMarkup,
    previewMatches: warehouseBigBagPreviewMatchesProfile,
    preparationError: 'Не удалось подготовить системную печать QR-этикетки.',
    sizeError: 'Размер предпросмотра не совпадает с форматом QR-этикетки.',
    loadError: 'Предпросмотр QR-этикетки не загрузился.',
  });
}
