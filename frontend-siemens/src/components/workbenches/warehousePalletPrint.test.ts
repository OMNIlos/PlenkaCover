import { describe, expect, it, vi } from 'vitest';

import { ApiError, ApiResponseParseError } from '../../api/client';
import type { ServerPalletPrintResult, ServerWarehousePrinter } from '../../api/warehouse';
import {
  PalletPrintRequestGate,
  PalletPrintStillQueuedError,
  chooseWarehousePrinterId,
  palletPrintFailurePresentation,
  palletPrintPhaseFromStatus,
  waitForPalletSubmission,
} from './warehousePalletPrint';
import { palletDocumentUsesLiveResources } from './warehousePalletResources';

const readyA: ServerWarehousePrinter = {
  id: 'printer-a',
  code: 'TLP4-A',
  label: 'MERTECH TLP4 A',
  post: { id: 'post-a', code: 'WH-A', name: 'Склад A' },
  status: 'online',
  ready: true,
  unavailableReason: null,
};

const readyB: ServerWarehousePrinter = {
  ...readyA,
  id: 'printer-b',
  code: 'TLP4-B',
  label: 'MERTECH TLP4 B',
  post: { id: 'post-b', code: 'WH-B', name: 'Склад B' },
};

const offlineA: ServerWarehousePrinter = {
  ...readyA,
  status: 'offline',
  ready: false,
  unavailableReason: 'Gateway поста не отвечает',
};

const submittedResult: ServerPalletPrintResult = {
  id: 'job-1',
  requestId: 'id-1',
  printerId: 'printer-a',
  status: 'submitted',
  gatewayCommandId: 'command-1',
  message: 'Задание отправлено',
};

const queuedResult: ServerPalletPrintResult = {
  ...submittedResult,
  status: 'queued',
  gatewayCommandId: null,
  message: 'Задание уже выполняется',
};

describe('chooseWarehousePrinterId', () => {
  it('автоматически выбирает единственный готовый принтер', () => {
    expect(chooseWarehousePrinterId([readyA], null)).toBe('printer-a');
  });

  it('требует явный выбор при двух готовых принтерах', () => {
    expect(chooseWarehousePrinterId([readyA, readyB], null)).toBeNull();
  });

  it('сохраняет выбранный готовый принтер', () => {
    expect(chooseWarehousePrinterId([readyA, readyB], 'printer-b')).toBe('printer-b');
  });

  it('не возвращает сохранённый offline-принтер', () => {
    expect(chooseWarehousePrinterId([offlineA], 'printer-a')).toBeNull();
  });
});

describe('PalletPrintRequestGate', () => {
  it('возвращает один Promise и выполняет один POST при двойном клике', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    let resolve!: (value: ServerPalletPrintResult) => void;
    const execute = vi.fn(
      () =>
        new Promise<ServerPalletPrintResult>((done) => {
          resolve = done;
        }),
    );

    const first = gate.run(execute);
    const second = gate.run(execute);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(execute).toHaveBeenCalledWith('id-1');

    resolve(submittedResult);
    await expect(first).resolves.toEqual(submittedResult);
  });

  it('повторяет uncertain network failure с тем же requestId', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(submittedResult);

    await expect(gate.run(execute)).rejects.toBeInstanceOf(TypeError);
    await expect(gate.run(execute)).resolves.toEqual(submittedResult);

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
  });

  it('повторяет abort с тем же requestId', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
      .mockResolvedValueOnce(submittedResult);

    await expect(gate.run(execute)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(gate.run(execute)).resolves.toEqual(submittedResult);

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
  });

  it('повторяет queued timeout с тем же requestId', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(new PalletPrintStillQueuedError())
      .mockResolvedValueOnce(submittedResult);

    await expect(gate.run(execute)).rejects.toBeInstanceOf(PalletPrintStillQueuedError);
    await expect(gate.run(execute)).resolves.toEqual(submittedResult);

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
  });

  it('повторяет ответ с неоднозначной parse-ошибкой с тем же requestId', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(new ApiResponseParseError(200, new SyntaxError('invalid json')))
      .mockResolvedValueOnce(submittedResult);

    await expect(gate.run(execute)).rejects.toBeInstanceOf(ApiResponseParseError);
    await expect(gate.run(execute)).resolves.toEqual(submittedResult);

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
  });

  it.each([408, 500, 502, 503, 504])(
    'после ambiguous API %i повторяет тот же requestId',
    async (status) => {
      const ids = ['id-1', 'id-2'];
      const gate = new PalletPrintRequestGate(() => ids.shift()!);
      const execute = vi
        .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
        .mockRejectedValueOnce(new ApiError(status, 'Статус доставки не подтвержден'))
        .mockResolvedValueOnce(submittedResult);

      await expect(gate.run(execute)).rejects.toBeInstanceOf(ApiError);
      await expect(gate.run(execute)).resolves.toEqual(submittedResult);

      expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
    },
  );

  it.each([400, 409])('после definitive API %i создаёт новый requestId', async (status) => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(new ApiError(status, 'Запрос отклонен'))
      .mockResolvedValueOnce({ ...submittedResult, requestId: 'id-2' });

    await expect(gate.run(execute)).rejects.toBeInstanceOf(ApiError);
    await expect(gate.run(execute)).resolves.toMatchObject({ requestId: 'id-2' });

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-2']);
  });

  it('сохраняет requestId для PALLET_PRINT_DELIVERY_UNKNOWN несмотря на HTTP 409', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          'Принтер подтвердил задание, но итог требует проверки администратором.',
          'PALLET_PRINT_DELIVERY_UNKNOWN',
        ),
      )
      .mockResolvedValueOnce(submittedResult);

    await expect(gate.run(execute)).rejects.toMatchObject({
      code: 'PALLET_PRINT_DELIVERY_UNKNOWN',
    });
    await expect(gate.run(execute)).resolves.toEqual(submittedResult);

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-1']);
  });

  it('очищает requestId для terminal PALLET_PRINT_FAILED несмотря на HTTP 503', async () => {
    const ids = ['id-1', 'id-2'];
    const gate = new PalletPrintRequestGate(() => ids.shift()!);
    const execute = vi
      .fn<(requestId: string) => Promise<ServerPalletPrintResult>>()
      .mockRejectedValueOnce(
        new ApiError(503, 'Принтер явно отклонил задание.', 'PALLET_PRINT_FAILED'),
      )
      .mockResolvedValueOnce({ ...submittedResult, requestId: 'id-2' });

    await expect(gate.run(execute)).rejects.toMatchObject({ code: 'PALLET_PRINT_FAILED' });
    await expect(gate.run(execute)).resolves.toMatchObject({ requestId: 'id-2' });

    expect(execute.mock.calls.map(([requestId]) => requestId)).toEqual(['id-1', 'id-2']);
  });
});

describe('pallet print failure presentation', () => {
  it('показывает delivery_unknown как uncertain с обязательной admin review', () => {
    const error = new ApiError(
      409,
      'Принтер подтвердил задание, но итог требует проверки администратором.',
      'PALLET_PRINT_DELIVERY_UNKNOWN',
    );

    expect(palletPrintFailurePresentation(error)).toEqual({
      phase: 'uncertain',
      message:
        'Итог печати не подтвержден. Не отправляйте новое задание: требуется проверка администратора.',
      refresh: true,
    });
  });

  it('показывает terminal failed как failed и разрешает новый явный запрос', () => {
    const error = new ApiError(503, 'Принтер явно отклонил задание.', 'PALLET_PRINT_FAILED');

    expect(palletPrintFailurePresentation(error)).toEqual({
      phase: 'failed',
      message: 'Печать завершилась ошибкой: Принтер явно отклонил задание.',
      refresh: true,
    });
  });

  it('оставляет неизвестный 503 uncertain по status semantics', () => {
    expect(palletPrintFailurePresentation(new ApiError(503, 'Прокси недоступен'))).toEqual({
      phase: 'uncertain',
      message: 'Статус доставки не подтвержден. Повторная проверка использует тот же запрос.',
      refresh: false,
    });
  });

  it('восстанавливает needs_admin server projection как uncertain UI', () => {
    expect(palletPrintPhaseFromStatus('needs_admin')).toBe('uncertain');
  });
});

describe('waitForPalletSubmission', () => {
  it('повторяет queued-запрос с тем же body до submitted', async () => {
    const send = vi
      .fn<() => Promise<ServerPalletPrintResult>>()
      .mockResolvedValueOnce(queuedResult)
      .mockResolvedValueOnce(queuedResult)
      .mockResolvedValueOnce(submittedResult);
    const delay = vi.fn(async () => undefined);

    await expect(waitForPalletSubmission(send, delay)).resolves.toEqual(submittedResult);
    expect(send).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('после 12 queued ответов сохраняет uncertain state для проверки статуса', async () => {
    const send = vi.fn(async () => queuedResult);
    const delay = vi.fn(async () => undefined);

    await expect(waitForPalletSubmission(send, delay)).rejects.toBeInstanceOf(
      PalletPrintStillQueuedError,
    );
    expect(send).toHaveBeenCalledTimes(12);
    expect(delay).toHaveBeenCalledTimes(11);
  });
});

describe('palletDocumentUsesLiveResources', () => {
  const readyDocument = {
    id: 'pallet-list-1',
    palletId: 'PAL-1',
    status: 'ready' as const,
    formatLabel: 'PDF' as const,
    fields: [],
    rollIds: ['ROLL-1'],
    templateVersion: 'pallet-100x150-v1' as const,
    printReady: true,
    fieldSetStatus: 'contract_ready' as const,
    sourceLabel: 'Backend API',
    auditEvent: 'audit:pallet_list_print_requested' as const,
  };

  it('loads live resources for every recognized backend pallet contract', () => {
    expect(palletDocumentUsesLiveResources(readyDocument)).toBe(true);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        templateVersion: 'pallet-100x150-compact-v2',
      }),
    ).toBe(true);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        templateVersion: 'pallet-100x100-square-v4',
      }),
    ).toBe(true);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        templateVersion: 'pallet-100x100-safe-v5',
      }),
    ).toBe(true);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        templateVersion: 'pallet-100x100-extended-v6',
      }),
    ).toBe(true);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        templateVersion: 'pallet-100x100-configurable-v7',
      }),
    ).toBe(true);
  });

  it('does not call live resources for fixture-only pallet documents', () => {
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        status: 'contract_only',
      }),
    ).toBe(false);
    expect(
      palletDocumentUsesLiveResources({
        ...readyDocument,
        fieldSetStatus: 'mock_only',
      }),
    ).toBe(false);
  });
});
