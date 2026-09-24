import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiResponseParseError } from '../../api/client';
import * as warehouseApi from '../../api/warehouse';
import type { WarehouseActivePallet } from '../../domain/types';
import * as browserPrint from './warehouseBrowserPrint';
import { WarehouseActivePalletPanel } from './WarehouseActivePalletPanel';

const activePallet: WarehouseActivePallet = {
  id: 'pallet-2',
  palletCode: 'PAL-ORD-77-002',
  orderId: 'order-77',
  orderNumber: 'ORD-77',
  sequenceNo: 2,
  status: 'open',
  rollCount: 2,
  openedAt: '2026-07-31T10:00:00.000Z',
  rows: [
    {
      rollCode: 'ROLL-77-03',
      position: 1,
      acceptedAt: '2026-07-31T10:00:00.000Z',
      scannedByName: 'Кладовщик',
    },
    {
      rollCode: 'ROLL-77-04',
      position: 2,
      acceptedAt: '2026-07-31T10:02:00.000Z',
      scannedByName: 'Кладовщик',
    },
  ],
};

const sealedResult: warehouseApi.ServerSealPalletResult = {
  pallet: { ...activePallet, status: 'sealed' },
  document: {
    id: 'document-2',
    palletId: activePallet.palletCode,
    warehousePalletId: activePallet.id,
    origin: 'physical_pallet',
    documentStatus: 'sealed',
    createdAt: '2026-07-31T10:03:00.000Z',
    templateVersion: 'pallet-100x100-extended-v6',
    printReady: true,
    printStatus: 'not_printed',
    rollCount: 2,
    rollCodes: ['ROLL-77-03', 'ROLL-77-04'],
    rollCodesHasMore: false,
    orderId: activePallet.orderId,
  },
};

function findButton(root: ReactTestInstance, ariaLabel: string) {
  return root.find((node) => node.type === 'button' && node.props['aria-label'] === ariaLabel);
}

function renderedText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : renderedText(child)))
    .join('');
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderPanel({
  pallet = activePallet,
  onWarehouseRefresh = vi.fn(),
}: {
  pallet?: WarehouseActivePallet | null;
  onWarehouseRefresh?: () => void;
} = {}): Promise<{
  renderer: ReactTestRenderer;
  onWarehouseRefresh: () => void;
}> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <WarehouseActivePalletPanel
        taskId="task-77"
        pallet={pallet}
        onWarehouseRefresh={onWarehouseRefresh}
      />,
    );
  });
  return { renderer, onWarehouseRefresh };
}

async function openAndConfirm(renderer: ReactTestRenderer) {
  act(() => findButton(renderer.root, 'Распечатать текущий палетный лист').props.onClick());
  await act(async () => {
    findButton(renderer.root, 'Подтвердить закрытие палета').props.onClick();
    await settle();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(warehouseApi, 'recordWarehousePalletSystemPrintIntent').mockImplementation(
    (palletListDocumentId, input) =>
      Promise.resolve({
        eventId: 'intent-event-1',
        requestId: input.requestId,
        palletListDocumentId,
        kind: input.kind,
        status: 'intent_recorded',
        replayed: false,
        requestedAt: '2026-08-09T07:00:00.000Z',
      }),
  );
});

describe('WarehouseActivePalletPanel', () => {
  it('показывает палет и одну доступную кнопку без выбора production-принтера', async () => {
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const { renderer } = await renderPanel();
    const content = renderedText(renderer.root);

    expect(content).toContain('Текущий палет №2');
    expect(content).toContain('ORD-77');
    expect(content).toContain('ROLL-77-03');
    expect(content).toContain('ROLL-77-04');
    expect(findButton(renderer.root, 'Распечатать текущий палетный лист').props.disabled).toBe(
      false,
    );
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Принтер для текущего палета' }),
    ).toHaveLength(0);
    expect(printers).not.toHaveBeenCalled();
  });

  it('запечатывает снимок, загружает реальный browser-profile preview и открывает Windows print', async () => {
    const preview = new Blob(['extended-v6-preview'], { type: 'image/png' });
    const seal = vi
      .spyOn(warehouseApi, 'sealCurrentWarehousePallet')
      .mockResolvedValue(sealedResult);
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(preview);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const refresh = vi.fn();
    const { renderer } = await renderPanel({ onWarehouseRefresh: refresh });

    act(() => findButton(renderer.root, 'Распечатать текущий палетный лист').props.onClick());
    expect(seal).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      'После закрытия добавить рулоны в этот палет будет нельзя.',
    );
    expect(JSON.stringify(renderer.toJSON())).toContain('Системное окно Windows');

    await act(async () => {
      findButton(renderer.root, 'Подтвердить закрытие палета').props.onClick();
      await settle();
    });

    expect(seal).toHaveBeenCalledOnce();
    expect(seal).toHaveBeenCalledWith(
      'task-77',
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    const intent = vi.mocked(warehouseApi.recordWarehousePalletSystemPrintIntent);
    expect(intent).toHaveBeenCalledWith(
      'document-2',
      expect.objectContaining({ requestId: expect.any(String), kind: 'initial' }),
    );
    expect(loadPreview).toHaveBeenCalledWith('document-2');
    expect(systemPrint).toHaveBeenCalledWith(preview, 'pallet-100x100-extended-v6');
    expect(seal.mock.invocationCallOrder[0]).toBeLessThan(intent.mock.invocationCallOrder[0]);
    expect(intent.mock.invocationCallOrder[0]).toBeLessThan(
      loadPreview.mock.invocationCallOrder[0],
    );
    expect(loadPreview.mock.invocationCallOrder[0]).toBeLessThan(
      systemPrint.mock.invocationCallOrder[0],
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer.toJSON())).toContain('Открыта системная печать');
  });

  it('передаёт новый safe-v5 профиль в первичную Windows-печать после seal', async () => {
    const safeV5Result: warehouseApi.ServerSealPalletResult = {
      ...sealedResult,
      document: {
        ...sealedResult.document,
        id: 'document-safe-v5-2',
        templateVersion: 'pallet-100x100-safe-v5',
      },
    };
    const preview = new Blob(['safe-v5-preview'], { type: 'image/png' });
    vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockResolvedValue(safeV5Result);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(preview);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      safeV5Result.document.id,
      expect.objectContaining({ requestId: expect.any(String), kind: 'initial' }),
    );
    expect(systemPrint).toHaveBeenCalledWith(preview, 'pallet-100x100-safe-v5');
  });

  it('открывает initial browser-print для extended-v6 без gateway-принтера', async () => {
    const extendedV6Result: warehouseApi.ServerSealPalletResult = {
      ...sealedResult,
      document: {
        ...sealedResult.document,
        id: 'document-extended-v6-2',
        templateVersion: 'pallet-100x100-extended-v6',
      },
    };
    const preview = new Blob(['extended-v6-preview'], { type: 'image/png' });
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockResolvedValue(extendedV6Result);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(preview);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      extendedV6Result.document.id,
      expect.objectContaining({ requestId: expect.any(String), kind: 'initial' }),
    );
    expect(systemPrint).toHaveBeenCalledWith(preview, 'pallet-100x100-extended-v6');
    expect(printers).not.toHaveBeenCalled();
    expect(gatewayPrint).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain('Открыта системная печать');
  });

  it('для configurable-v7 initial print передаёт точный sealed-document PNG без gateway', async () => {
    const configurableV7Result: warehouseApi.ServerSealPalletResult = {
      ...sealedResult,
      document: {
        ...sealedResult.document,
        id: 'document-configurable-v7-2',
        templateVersion: 'pallet-100x100-configurable-v7',
      },
    };
    const exactPinnedPreview = new Blob(['configurable-v7-pinned-preview'], {
      type: 'image/png',
    });
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockResolvedValue(configurableV7Result);
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(exactPinnedPreview);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      configurableV7Result.document.id,
      expect.objectContaining({ kind: 'initial' }),
    );
    expect(loadPreview).toHaveBeenCalledWith(configurableV7Result.document.id);
    expect(systemPrint).toHaveBeenCalledWith(
      exactPinnedPreview,
      'pallet-100x100-configurable-v7',
    );
    expect(gatewayPrint).not.toHaveBeenCalled();
  });

  it('завершает системную печать после polling refresh, убравшего палет во время preview', async () => {
    vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockResolvedValue({
      ...sealedResult,
      document: {
        ...sealedResult.document,
        templateVersion: 'pallet-100x100-extended-v6',
      },
    });
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['extended-v6-preview'], { type: 'image/png' }),
    );
    let resolvePrint!: () => void;
    const systemPrint = vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrint = resolve;
        }),
    );

    let renderer!: ReactTestRenderer;
    const panel = (pallet: WarehouseActivePallet | null) => (
      <WarehouseActivePalletPanel taskId="task-77" pallet={pallet} onWarehouseRefresh={refresh} />
    );
    const refresh = vi.fn(() => renderer.update(panel(null)));
    await act(async () => {
      renderer = TestRenderer.create(panel(activePallet));
    });

    act(() => findButton(renderer.root, 'Распечатать текущий палетный лист').props.onClick());
    await act(async () => {
      findButton(renderer.root, 'Подтвердить закрытие палета').props.onClick();
      await settle();
    });
    expect(systemPrint).toHaveBeenCalledOnce();

    await act(async () => {
      renderer.update(panel(null));
    });
    expect(renderedText(renderer.root)).toContain('Палет закрыт. Загружаем палетный лист…');

    await act(async () => {
      resolvePrint();
      await settle();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(renderedText(renderer.root)).toContain('Палет закрыт. Открыта системная печать.');
    expect(renderedText(renderer.root)).toContain('Палет пока не открыт');

    await act(async () => {
      renderer.update(
        panel({
          ...activePallet,
          id: 'pallet-3',
          palletCode: 'PAL-ORD-77-003',
          sequenceNo: 3,
        }),
      );
    });
    expect(renderedText(renderer.root)).not.toContain('Палет закрыт. Открыта системная печать.');
  });

  it('сохраняет retry после ошибки печати, если polling refresh уже убрал палет', async () => {
    const seal = vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockResolvedValue({
      ...sealedResult,
      document: {
        ...sealedResult.document,
        templateVersion: 'pallet-100x100-extended-v6',
      },
    });
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['extended-v6-preview'], { type: 'image/png' }),
    );
    let rejectPrint!: (error: Error) => void;
    vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrint = reject;
        }),
    );

    let renderer!: ReactTestRenderer;
    const refresh = vi.fn();
    const panel = (pallet: WarehouseActivePallet | null, taskId = 'task-77') => (
      <WarehouseActivePalletPanel taskId={taskId} pallet={pallet} onWarehouseRefresh={refresh} />
    );
    await act(async () => {
      renderer = TestRenderer.create(panel(activePallet));
    });
    act(() => findButton(renderer.root, 'Распечатать текущий палетный лист').props.onClick());
    await act(async () => {
      findButton(renderer.root, 'Подтвердить закрытие палета').props.onClick();
      await settle();
    });

    await act(async () => {
      renderer.update(panel(null));
    });
    expect(renderedText(renderer.root)).toContain('Палет закрыт. Загружаем палетный лист…');

    await act(async () => {
      rejectPrint(new Error('Системный диалог заблокирован'));
      await settle();
    });

    expect(seal).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
    expect(renderedText(renderer.root)).toContain(
      'Палет закрыт, но системная печать не открылась.',
    );
    expect(findButton(renderer.root, 'Повторить системную печать палетного листа')).toBeDefined();

    await act(async () => {
      renderer.update(panel(null, 'task-88'));
    });
    expect(renderedText(renderer.root)).not.toContain(
      'Палет закрыт, но системная печать не открылась.',
    );
  });

  it('не отправляет второй seal-запрос во время закрытия', async () => {
    let resolve!: (result: warehouseApi.ServerSealPalletResult) => void;
    const seal = vi.spyOn(warehouseApi, 'sealCurrentWarehousePallet').mockImplementation(
      () =>
        new Promise<warehouseApi.ServerSealPalletResult>((done) => {
          resolve = done;
        }),
    );
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(new Blob(['preview']));
    vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockResolvedValue();
    const { renderer } = await renderPanel();

    act(() => findButton(renderer.root, 'Распечатать текущий палетный лист').props.onClick());
    const confirm = findButton(renderer.root, 'Подтвердить закрытие палета');
    act(() => {
      confirm.props.onClick();
      confirm.props.onClick();
    });
    expect(seal).toHaveBeenCalledOnce();

    await act(async () => {
      resolve(sealedResult);
      await settle();
    });

    expect(seal).toHaveBeenCalledOnce();
  });

  it('повторяет только системную печать, если палет уже успешно закрыт', async () => {
    const seal = vi
      .spyOn(warehouseApi, 'sealCurrentWarehousePallet')
      .mockResolvedValue(sealedResult);
    const preview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(new Blob(['preview']));
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockRejectedValueOnce(new Error('Диалог заблокирован'))
      .mockResolvedValueOnce();
    const refresh = vi.fn();
    const { renderer } = await renderPanel({ onWarehouseRefresh: refresh });

    await openAndConfirm(renderer);

    expect(JSON.stringify(renderer.toJSON())).toContain('без повторного закрытия');
    expect(refresh).not.toHaveBeenCalled();

    expect(
      findButton(renderer.root, 'Повторить системную печать палетного листа').props.disabled,
    ).toBe(true);
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Причина повторной системной печати' })
        .props.onChange({ target: { value: 'Системный диалог не открылся' } });
    });

    await act(async () => {
      findButton(renderer.root, 'Повторить системную печать палетного листа').props.onClick();
      await settle();
    });

    expect(seal).toHaveBeenCalledOnce();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(systemPrint).toHaveBeenCalledTimes(2);
    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(warehouseApi.recordWarehousePalletSystemPrintIntent).mock.calls[0]?.[1].kind,
    ).toBe('initial');
    expect(
      vi.mocked(warehouseApi.recordWarehousePalletSystemPrintIntent).mock.calls[1]?.[1].kind,
    ).toBe('reprint');
    expect(
      vi.mocked(warehouseApi.recordWarehousePalletSystemPrintIntent).mock.calls[1]?.[1],
    ).toEqual(expect.objectContaining({ reason: 'Системный диалог не открылся' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('повторяет неоднозначный initial intent с тем же requestId без reseal и reprint', async () => {
    const seal = vi
      .spyOn(warehouseApi, 'sealCurrentWarehousePallet')
      .mockResolvedValue(sealedResult);
    const intent = vi
      .mocked(warehouseApi.recordWarehousePalletSystemPrintIntent)
      .mockRejectedValueOnce(new TypeError('network'))
      .mockImplementationOnce((palletListDocumentId, input) =>
        Promise.resolve({
          eventId: 'intent-event-1',
          requestId: input.requestId,
          palletListDocumentId,
          kind: input.kind,
          status: 'intent_recorded',
          replayed: true,
          requestedAt: '2026-08-09T07:00:00.000Z',
        }),
      );
    const preview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(new Blob(['preview']));
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);
    await act(async () => {
      findButton(renderer.root, 'Повторить системную печать палетного листа').props.onClick();
      await settle();
    });

    expect(seal).toHaveBeenCalledOnce();
    expect(intent).toHaveBeenCalledTimes(2);
    expect(intent.mock.calls[1]?.[1]).toEqual(intent.mock.calls[0]?.[1]);
    expect(intent.mock.calls[1]?.[1].kind).toBe('initial');
    expect(preview).toHaveBeenCalledOnce();
    expect(systemPrint).toHaveBeenCalledOnce();
  });

  it('сохраняет requestId после неоднозначной ошибки seal для безопасного повтора', async () => {
    const seal = vi
      .spyOn(warehouseApi, 'sealCurrentWarehousePallet')
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(sealedResult);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(new Blob(['preview']));
    vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);
    expect(JSON.stringify(renderer.toJSON())).toContain('тот же запрос');
    await openAndConfirm(renderer);

    expect(seal).toHaveBeenCalledTimes(2);
    expect(seal.mock.calls[1]?.[1].requestId).toBe(seal.mock.calls[0]?.[1].requestId);
  });

  it('повторяет seal с тем же requestId после неоднозначной parse-ошибки ответа', async () => {
    const seal = vi
      .spyOn(warehouseApi, 'sealCurrentWarehousePallet')
      .mockRejectedValueOnce(new ApiResponseParseError(200, new SyntaxError('invalid json')))
      .mockResolvedValueOnce(sealedResult);
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(new Blob(['preview']));
    vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockResolvedValue();
    const { renderer } = await renderPanel();

    await openAndConfirm(renderer);
    await openAndConfirm(renderer);

    expect(seal).toHaveBeenCalledTimes(2);
    expect(seal.mock.calls[1]?.[1].requestId).toBe(seal.mock.calls[0]?.[1].requestId);
  });

  it('объясняет, что состав палета выбирается явно после приемки', async () => {
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const { renderer } = await renderPanel({ pallet: null });

    expect(JSON.stringify(renderer.toJSON())).toContain(
      'Выберите принятые рулоны для палетного листа.',
    );
    expect(printers).not.toHaveBeenCalled();
  });
});
