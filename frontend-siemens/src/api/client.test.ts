import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiResponseParseError, apiGet, apiPost, apiPut } from './client';
import { clearSession, loadSession, saveSession } from './authStorage';
import { IdempotentOperationGate } from './idempotentOperation';

function stubFetch(status: number, json: unknown) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('client', () => {
  it('releases a stalled request after the deadline and keeps its UUID for a safe retry', async () => {
    const controller = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    vi.stubGlobal('fetch', vi.fn((_path, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    let keyNumber = 0;
    const gate = new IdempotentOperationGate(() => `print-key-${++keyNumber}`);
    const print = gate.start('qr-print', (operationKey) => apiPost('/api/operator/rolls/R-7/qr-print', { operationKey }));
    const rejected = expect(print).rejects.toMatchObject({ name: 'TimeoutError' });
    controller.abort(new DOMException('Время ожидания истекло', 'TimeoutError'));
    await rejected;
    expect(deadline).toHaveBeenCalled();
    await expect(gate.start('qr-print', async (operationKey) => operationKey)).resolves.toBe('print-key-1');
    deadline.mockRestore();
  });
  beforeEach(() => clearSession());
  afterEach(() => vi.unstubAllGlobals());

  it('apiGet возвращает json и шлёт Bearer при наличии сессии', async () => {
    saveSession({
      version: 1,
      token: 't-9',
      role: 'admin',
      serverRole: 'admin',
      userId: 'u',
      displayName: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    const spy = stubFetch(200, { ok: true });
    await expect(apiGet('/api/auth/me')).resolves.toEqual({ ok: true });
    const init = (spy.mock.calls as unknown[][])[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t-9');
  });

  it('без сессии заголовка Authorization нет', async () => {
    const spy = stubFetch(200, {});
    await apiGet('/api/health');
    const init = (spy.mock.calls as unknown[][])[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('forwards an AbortSignal without retaining any extra request state', async () => {
    const spy = stubFetch(200, { ok: true });
    const controller = new AbortController();

    await apiGet('/api/admin/notifications', { signal: controller.signal });

    const init = (spy.mock.calls as unknown[][])[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it('401 чистит сессию и бросает ApiError', async () => {
    saveSession({
      version: 1,
      token: 'dead',
      role: 'admin',
      serverRole: 'admin',
      userId: 'u',
      displayName: null,
      expiresAt: '2030-01-01T00:00:00.000Z',
      passwordChangeRequired: false,
    });
    stubFetch(401, { message: 'Unauthorized' });
    await expect(apiGet('/api/auth/me')).rejects.toMatchObject({ status: 401 });
    expect(loadSession()).toBeNull();
  });

  it.each(['old-session', undefined])('ignores a delayed 401 from %s after a new login', async (oldToken) => {
    const session = {
      version: 1 as const, token: 'new-session', role: 'admin' as const,
      serverRole: 'admin' as const, userId: 'u', displayName: null,
      expiresAt: '2030-01-01T00:00:00.000Z', passwordChangeRequired: false,
    };
    if (oldToken) saveSession({ ...session, token: oldToken });
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', { dispatchEvent });
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const request = apiGet('/api/admin/users');
    saveSession(session);
    respond(new Response('{"message":"Unauthorized"}', { status: 401 }));
    await expect(request).rejects.toMatchObject({ status: 401 });
    expect(loadSession()).toEqual(session);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('apiPost сериализует тело и читает message из ошибки', async () => {
    stubFetch(400, { message: ['login must be a string'] });
    await expect(apiPost('/api/auth/login', { login: 1 })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof ApiError && e.status === 400 && e.message.includes('login must be'),
    );
  });

  it('marks malformed JSON after a successful mutation response as delivery-uncertain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"id":', {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const error = await apiPost('/api/operator/problems', {
      operationKey: '11111111-1111-4111-8111-111111111111',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiResponseParseError);
    expect(error).toMatchObject({ status: 201, deliveryUncertain: true });
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('response');
  });

  it('сохраняет только безопасный machine code из backend JSON error', async () => {
    stubFetch(409, {
      code: 'PALLET_PRINT_DELIVERY_UNKNOWN',
      message: 'Итог требует проверки администратором.',
      printJobId: 'internal-job-1',
      gatewayCommandId: 'internal-command-1',
    });

    const error = await apiPost('/api/warehouse/pallet-lists/list-1/print', {
      requestId: 'request-1',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 409,
      code: 'PALLET_PRINT_DELIVERY_UNKNOWN',
      message: 'Итог требует проверки администратором.',
    });
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('printJobId');
    expect(error).not.toHaveProperty('gatewayCommandId');
    expect(JSON.stringify(error)).not.toContain('internal-job-1');
    expect(JSON.stringify(error)).not.toContain('internal-command-1');
  });

  it('сохраняет terminal PALLET_PRINT_FAILED вместе с реальным HTTP 503', async () => {
    stubFetch(503, {
      code: 'PALLET_PRINT_FAILED',
      message: 'Printer adapter explicitly rejected the job.',
    });

    const error = await apiPost('/api/warehouse/pallet-lists/list-1/print', {
      requestId: 'request-1',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 503,
      code: 'PALLET_PRINT_FAILED',
      message: 'Printer adapter explicitly rejected the job.',
    });
  });

  it('сохраняет только безопасные id уже закрытого палета для восстановления UI', async () => {
    stubFetch(503, {
      code: 'PALLET_PRINT_FAILED',
      message: 'Палет закрыт, принтер недоступен.',
      documentId: 'document-1',
      palletId: 'PAL-A-100-01',
      warehousePalletId: 'warehouse-pallet-1',
      rawPayload: 'must-not-leak',
      gatewayCommandId: 'must-not-leak-either',
    });

    const error = await apiPost('/api/warehouse/intake/task-1/pallets/current/close-and-print', {
      requestId: 'request-1',
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status: 503,
      details: {
        documentId: 'document-1',
        palletId: 'PAL-A-100-01',
        warehousePalletId: 'warehouse-pallet-1',
      },
    });
    expect(JSON.stringify(error)).not.toMatch(/must-not-leak|gatewayCommandId|rawPayload/u);
  });

  it('отбрасывает небезопасный backend code и не удерживает его payload', async () => {
    const responseSecret = 'response-only-secret';
    stubFetch(503, {
      code: `PALLET_PRINT_FAILED\n${responseSecret}`,
      message: 'Печать завершилась ошибкой.',
      rawPayload: responseSecret,
    });

    const error = await apiPost('/api/warehouse/pallet-lists/list-1/print', {}).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toHaveProperty('code', null);
    expect(JSON.stringify(error)).not.toContain(responseSecret);
  });

  it('ApiError never retains the request body or password', async () => {
    const password = 'request-only-password';
    stubFetch(400, { message: 'Bad request' });

    const error = await apiPost('/api/auth/login', { login: 'admin', password }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toHaveProperty('body');
    expect(error).not.toHaveProperty('request');
    expect(JSON.stringify(error)).not.toContain(password);
  });

  it('apiPut sends a JSON replacement payload', async () => {
    const spy = stubFetch(200, { id: 'assignment-1' });

    await apiPut('/api/production/shifts/s1/operators/o1/machine', { postId: 'p1' });

    const init = (spy.mock.calls as unknown[][])[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ postId: 'p1' });
  });
});
