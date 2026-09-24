import { clearSessionForToken, loadSession } from './authStorage';

export type ApiRequestOptions = {
  signal?: AbortSignal;
};

export type ApiErrorDetails = {
  documentId?: string;
  palletId?: string;
  warehousePalletId?: string;
  fieldErrors?: ReadonlyArray<{
    path: string;
    code: string;
    message: string;
  }>;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly details: Readonly<ApiErrorDetails> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiResponseParseError extends Error {
  readonly deliveryUncertain = true;

  constructor(
    readonly status: number,
    readonly cause: unknown,
  ) {
    super('Результат операции не удалось подтвердить.');
    this.name = 'ApiResponseParseError';
  }
}

const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function safeErrorCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  return SAFE_ERROR_CODE.test(code) ? code : null;
}

function safeResourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/u.test(id)) return undefined;
  return id;
}

function safeErrorText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function safeFieldErrors(value: unknown): ApiErrorDetails['fieldErrors'] {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const fieldErrors = value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    if (Object.keys(source).some((key) => !['path', 'code', 'message'].includes(key))) return null;
    const path = safeErrorText(source.path, 500);
    const code = safeErrorText(source.code, 100);
    const message = safeErrorText(source.message, 500);
    return path && code && message ? { path, code, message } : null;
  });
  return fieldErrors.every((item) => item !== null)
    ? (fieldErrors as NonNullable<ApiErrorDetails['fieldErrors']>)
    : undefined;
}

function errorBodyProjection(value: unknown): {
  code: string | null;
  message: string | null;
  details: ApiErrorDetails;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { code: null, message: null, details: {} };
  }
  const body = value as Record<string, unknown>;
  const message =
    typeof body.message === 'string'
      ? body.message
      : Array.isArray(body.message) && body.message.every((item) => typeof item === 'string')
        ? body.message.join('; ')
        : null;
  const documentId = safeResourceId(body.documentId);
  const palletId = safeResourceId(body.palletId);
  const warehousePalletId = safeResourceId(body.warehousePalletId);
  const fieldErrors = safeFieldErrors(body.fieldErrors);
  return {
    code: safeErrorCode(body.code),
    message,
    details: {
      ...(documentId ? { documentId } : {}),
      ...(palletId ? { palletId } : {}),
      ...(warehousePalletId ? { warehousePalletId } : {}),
      ...(fieldErrors ? { fieldErrors } : {}),
    },
  };
}

async function requestResponse(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  capturedToken?: string,
  { signal }: ApiRequestOptions = {},
): Promise<Response> {
  const token = capturedToken ?? loadSession()?.token;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Allow the gateway's maximum two-minute command window plus result finalization.
    signal: signal ?? AbortSignal.timeout(180_000),
  });

  if (res.status === 401) {
    const sessionCleared = token !== undefined && clearSessionForToken(token);
    if (sessionCleared && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('plenki:auth-expired'));
    }
  }

  if (!res.ok) {
    let message = `Ошибка ${res.status}`;
    let code: string | null = null;
    let details: ApiErrorDetails = {};
    try {
      const projection = errorBodyProjection(await res.json());
      if (projection.message) message = projection.message;
      code = projection.code;
      details = projection.details;
    } catch {
      // тело не json — оставляем статус
    }
    throw new ApiError(res.status, message, code, details);
  }

  return res;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  capturedToken?: string,
  options?: ApiRequestOptions,
): Promise<T> {
  const response = await requestResponse(method, path, body, capturedToken, options);
  try {
    return (await response.json()) as T;
  } catch (error: unknown) {
    throw new ApiResponseParseError(response.status, error);
  }
}

export function apiGet<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, undefined, options);
}

export async function apiGetOptional<T>(
  path: string,
  options?: ApiRequestOptions,
): Promise<T | null> {
  const response = await requestResponse('GET', path, undefined, undefined, options);
  const body = await response.text();
  return body.trim() === '' ? null : (JSON.parse(body) as T);
}

export function apiGetWithBearer<T>(
  path: string,
  capturedToken: string,
  options?: ApiRequestOptions,
): Promise<T> {
  return request<T>('GET', path, undefined, capturedToken, options);
}

export async function apiGetBlob(path: string, options?: ApiRequestOptions): Promise<Blob> {
  const response = await requestResponse('GET', path, undefined, undefined, options);
  return response.blob();
}

export function apiPost<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
  return request<T>('POST', path, body, undefined, options);
}

export async function apiPostBlob(
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<Blob> {
  const response = await requestResponse('POST', path, body, undefined, options);
  return response.blob();
}

export async function apiPostBlobWithHeaders(
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
): Promise<{ blob: Blob; headers: Headers; status: number }> {
  const response = await requestResponse('POST', path, body, undefined, options);
  return { blob: await response.blob(), headers: response.headers, status: response.status };
}

export function apiPatch<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
  return request<T>('PATCH', path, body, undefined, options);
}

export function apiPut<T>(path: string, body?: unknown, options?: ApiRequestOptions): Promise<T> {
  return request<T>('PUT', path, body, undefined, options);
}

export async function apiDelete(path: string, options?: ApiRequestOptions): Promise<void> {
  await requestResponse('DELETE', path, undefined, undefined, options);
}
