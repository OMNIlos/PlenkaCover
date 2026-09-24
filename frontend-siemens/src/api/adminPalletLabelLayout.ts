import {
  parsePalletLabelEditorBootstrap,
  parsePalletLabelLayoutPublication,
  parsePalletLabelLayoutServerDiagnostics,
  type PalletLabelEditorBootstrap,
  type PalletLabelLayout,
  type PalletLabelLayoutPublication,
  type PalletLabelLayoutServerDiagnostics,
} from '../domain/palletLabelLayoutContract';
import {
  ApiResponseParseError,
  apiGet,
  apiPost,
  apiPostBlobWithHeaders,
  type ApiRequestOptions,
} from './client';

const EDITOR_PATH = '/api/admin/pallet-label-layout-editor';

export type PalletLabelLayoutPreviewInput = {
  sourceDocumentId: string;
  layout: PalletLabelLayout;
};

export type PalletLabelLayoutPreviewResult = {
  png: Blob;
  diagnostics: PalletLabelLayoutServerDiagnostics;
};

export type PublishPalletLabelLayoutInput = {
  operationKey: string;
  expectedActivePublicationId: string | null;
  sourceDocumentId: string;
  reason: string;
  layout: PalletLabelLayout;
};

export type PublishPalletLabelLayoutResult = {
  publication: PalletLabelLayoutPublication & { layout: PalletLabelLayout };
  replayed: boolean;
};

export type AdminPalletLabelLayoutApi = {
  load(options?: ApiRequestOptions): Promise<PalletLabelEditorBootstrap>;
  preview(
    input: PalletLabelLayoutPreviewInput,
    options?: ApiRequestOptions,
  ): Promise<PalletLabelLayoutPreviewResult>;
  publish(input: PublishPalletLabelLayoutInput): Promise<PublishPalletLabelLayoutResult>;
};

const DIAGNOSTICS_HEADER = 'X-Pallet-Layout-Diagnostics';

function decodeBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  return decodeURIComponent(
    Array.from(atob(`${base64}${padding}`), (character) =>
      `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`,
    ).join(''),
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Ответ публикации имеет неверный формат.');
  }
  return value as Record<string, unknown>;
}

export async function fetchAdminPalletLabelLayoutEditor(
  options?: ApiRequestOptions,
): Promise<PalletLabelEditorBootstrap> {
  const response = await apiGet<unknown>(EDITOR_PATH, options);
  return parsePalletLabelEditorBootstrap(response);
}

export async function previewAdminPalletLabelLayout(
  input: PalletLabelLayoutPreviewInput,
  options?: ApiRequestOptions,
): Promise<PalletLabelLayoutPreviewResult> {
  const result = await apiPostBlobWithHeaders(`${EDITOR_PATH}/preview`, input, options);
  if (result.blob.type !== 'image/png') {
    throw new Error('Сервер вернул неверный формат предпросмотра.');
  }
  try {
    const encodedDiagnostics = result.headers.get(DIAGNOSTICS_HEADER);
    if (!encodedDiagnostics) throw new Error('Сервер не подтвердил диагностику макета.');
    return {
      png: result.blob,
      diagnostics: parsePalletLabelLayoutServerDiagnostics(
        JSON.parse(decodeBase64Url(encodedDiagnostics)),
      ),
    };
  } catch (error: unknown) {
    throw new ApiResponseParseError(result.status, error);
  }
}

export async function publishAdminPalletLabelLayout(
  input: PublishPalletLabelLayoutInput,
): Promise<PublishPalletLabelLayoutResult> {
  const value = await apiPost<unknown>(`${EDITOR_PATH}/publish`, input);
  try {
    const result = record(value);
    const keys = Object.keys(result);
    if (
      keys.length !== 2 ||
      !keys.includes('publication') ||
      !keys.includes('replayed') ||
      typeof result.replayed !== 'boolean'
    ) {
      throw new Error('Ответ публикации имеет неверный формат.');
    }
    const publication = parsePalletLabelLayoutPublication(result.publication, {
      widthDots: 800,
      heightDots: 800,
      dotsPerMm: 8,
      safeInsetDots: 20,
      provenCutYDots: 570,
    });
    if (publication.layout.schemaVersion !== 2) {
      throw new Error('Сервер вернул исторический макет в ответе новой публикации.');
    }
    return {
      publication: publication as PalletLabelLayoutPublication & { layout: PalletLabelLayout },
      replayed: result.replayed,
    };
  } catch (error: unknown) {
    throw new ApiResponseParseError(200, error);
  }
}

export const adminPalletLabelLayoutApi: AdminPalletLabelLayoutApi = {
  load: fetchAdminPalletLabelLayoutEditor,
  preview: previewAdminPalletLabelLayout,
  publish: publishAdminPalletLabelLayout,
};
