import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as warehouseApi from '../../api/warehouse';
import { ApiResponseParseError } from '../../api/client';
import type { PalletListDocument } from '../../domain/types';
import * as browserPrint from './warehouseBrowserPrint';
import { PalletLabelPanel } from './PalletLabelPanel';

const squareDocument: PalletListDocument = {
  id: 'document-square-1',
  palletId: 'PAL-A-2-01',
  status: 'ready',
  formatLabel: 'PDF',
  fields: [],
  rollIds: ['A-2-roll-1'],
  warehousePalletId: 'pallet-1',
  origin: 'physical_pallet',
  documentStatus: 'sealed',
  rollCount: 1,
  templateVersion: 'pallet-100x100-square-v4',
  printReady: true,
  printStatus: 'not_printed',
  fieldSetStatus: 'contract_ready',
  availableFormats: [],
  sourceLabel: 'Backend API',
  auditEvent: 'audit:pallet_list_print_requested',
};

function findButton(root: ReactTestInstance) {
  return root.findByProps({
    'aria-label': 'Открыть системную печать палетного листа',
  });
}

function enterReprintReason(
  root: ReactTestInstance,
  reason = 'Этикетка повреждена при наклеивании',
) {
  act(() => {
    root
      .findByProps({ 'aria-label': 'Причина повторной системной печати' })
      .props.onChange({ target: { value: reason } });
  });
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function renderPanel(
  onWarehouseRefresh = vi.fn(),
  document: PalletListDocument = squareDocument,
) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <PalletLabelPanel
        document={document}
        taskId="task-1"
        onWarehouseRefresh={onWarehouseRefresh}
      />,
    );
    await settle();
  });
  return { onWarehouseRefresh, renderer };
}

beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:exact-pallet-preview');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(warehouseApi, 'recordWarehousePalletSystemPrintIntent').mockImplementation(
    (palletListDocumentId, input) =>
      Promise.resolve({
        eventId: 'event-1',
        requestId: input.requestId,
        palletListDocumentId,
        kind: input.kind,
        status: 'intent_recorded',
        replayed: false,
        requestedAt: '2026-08-09T07:00:00.000Z',
      }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PalletLabelPanel square browser reprint', () => {
  it('показывает точный PNG и после intent печатает те же байты в профиле 100×100', async () => {
    const previewBlob = new Blob(['square-preview'], { type: 'image/png' });
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(previewBlob);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const refresh = vi.fn();
    const { renderer } = await renderPanel(refresh);

    expect(printers).not.toHaveBeenCalled();
    expect(loadPreview).toHaveBeenCalledOnce();
    expect(loadPreview).toHaveBeenCalledWith(squareDocument.id);
    expect(gatewayPrint).not.toHaveBeenCalled();
    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).not.toHaveBeenCalled();
    expect(renderer.root.findByType('img').props.src).toBe('blob:exact-pallet-preview');
    expect(
      renderer.root.findByProps({
        className: 'warehouse-pallet-label-preview has-preview',
      }).props.style,
    ).toEqual(expect.objectContaining({ aspectRatio: '100 / 100' }));
    expect(renderer.root.findByType('img').props.style).toEqual(
      expect.objectContaining({ left: '2%', top: '2%', width: '71.5%', height: '71.5%' }),
    );
    expect(text(renderer.root)).toContain('100 × 100 мм');
    expect(text(renderer.root)).not.toContain('одна копия');

    expect(findButton(renderer.root).props.disabled).toBe(true);
    enterReprintReason(renderer.root);

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });

    const intent = vi.mocked(warehouseApi.recordWarehousePalletSystemPrintIntent);
    expect(intent).toHaveBeenCalledWith(
      squareDocument.id,
      expect.objectContaining({
        requestId: expect.any(String),
        kind: 'reprint',
        reason: 'Этикетка повреждена при наклеивании',
      }),
    );
    expect(loadPreview).toHaveBeenCalledOnce();
    expect(systemPrint).toHaveBeenCalledWith(previewBlob, 'pallet-100x100-square-v4');
    expect(loadPreview.mock.invocationCallOrder[0]).toBeLessThan(
      intent.mock.invocationCallOrder[0],
    );
    expect(intent.mock.invocationCallOrder[0]).toBeLessThan(
      systemPrint.mock.invocationCallOrder[0],
    );
    expect(gatewayPrint).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(text(renderer.root)).toContain('Открыта системная печать.');
    expect(
      renderer.root.findByProps({ className: 'warehouse-pallet-print-feedback is-success' }).props
        .role,
    ).toBe('status');
    expect(text(renderer.root)).not.toContain('Задание отправлено');
    act(() => renderer.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:exact-pallet-preview');
  });

  it('открывает audited browser reprint для нового safe-v5 без printer gateway', async () => {
    const safeV5Document: PalletListDocument = {
      ...squareDocument,
      id: 'document-safe-v5-1',
      palletId: 'PAL-A-2-04',
      templateVersion: 'pallet-100x100-safe-v5',
    };
    const previewBlob = new Blob(['safe-v5-preview'], { type: 'image/png' });
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(previewBlob);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const refresh = vi.fn();
    const { renderer } = await renderPanel(refresh, safeV5Document);

    expect(printers).not.toHaveBeenCalled();
    expect(text(renderer.root)).toContain('100 × 100 мм');
    enterReprintReason(renderer.root);

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      safeV5Document.id,
      expect.objectContaining({ requestId: expect.any(String), kind: 'reprint' }),
    );
    expect(loadPreview).toHaveBeenCalledWith(safeV5Document.id);
    expect(systemPrint).toHaveBeenCalledWith(previewBlob, 'pallet-100x100-safe-v5');
    expect(gatewayPrint).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('открывает audited browser reprint extended-v6 из истории без gateway и export', async () => {
    const extendedV6Document: PalletListDocument = {
      ...squareDocument,
      id: 'document-extended-v6-1',
      palletId: 'PAL-A-2-05',
      templateVersion: 'pallet-100x100-extended-v6',
    };
    const previewBlob = new Blob(['extended-v6-preview'], { type: 'image/png' });
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    const exportDocument = vi.spyOn(warehouseApi, 'downloadWarehousePalletList');
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(previewBlob);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const refresh = vi.fn();
    const { renderer } = await renderPanel(refresh, extendedV6Document);

    expect(text(renderer.root)).toContain('100 × 100 мм');
    expect(text(renderer.root)).toContain('Системная печать');
    expect(printers).not.toHaveBeenCalled();
    enterReprintReason(renderer.root);

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      extendedV6Document.id,
      expect.objectContaining({ requestId: expect.any(String), kind: 'reprint' }),
    );
    expect(loadPreview).toHaveBeenCalledWith(extendedV6Document.id);
    expect(systemPrint).toHaveBeenCalledWith(previewBlob, 'pallet-100x100-extended-v6');
    expect(gatewayPrint).not.toHaveBeenCalled();
    expect(exportDocument).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(text(renderer.root)).toContain('Открыта системная печать.');
    expect(text(renderer.root)).not.toContain('Задание отправлено');
  });

  it('для configurable-v7 reprint передаёт тот же immutable server PNG только в browser print', async () => {
    const configurableV7Document: PalletListDocument = {
      ...squareDocument,
      id: 'document-configurable-v7-1',
      palletId: 'PAL-A-2-07',
      templateVersion: 'pallet-100x100-configurable-v7',
    };
    const exactPinnedPreview = new Blob(['configurable-v7-pinned-preview'], {
      type: 'image/png',
    });
    const gatewayPrint = vi.spyOn(warehouseApi, 'printWarehousePalletList');
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(exactPinnedPreview);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel(vi.fn(), configurableV7Document);
    expect(renderer.root.findByType('img').props.style).toEqual(
      expect.objectContaining({ left: '2%', top: '2%', width: '96%', height: '96%' }),
    );
    enterReprintReason(renderer.root);

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });

    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).toHaveBeenCalledWith(
      configurableV7Document.id,
      expect.objectContaining({ kind: 'reprint' }),
    );
    expect(loadPreview).toHaveBeenCalledWith(configurableV7Document.id);
    expect(systemPrint).toHaveBeenCalledWith(exactPinnedPreview, 'pallet-100x100-configurable-v7');
    expect(gatewayPrint).not.toHaveBeenCalled();
  });

  it('повторяет неоднозначный intent с тем же requestId и не перезагружает preview', async () => {
    const intent = vi
      .mocked(warehouseApi.recordWarehousePalletSystemPrintIntent)
      .mockRejectedValueOnce(new ApiResponseParseError(200, new Error('wrong requestId echo')))
      .mockImplementationOnce((palletListDocumentId, input) =>
        Promise.resolve({
          eventId: 'event-1',
          requestId: input.requestId,
          palletListDocumentId,
          kind: input.kind,
          status: 'intent_recorded',
          replayed: true,
          requestedAt: '2026-08-09T07:00:00.000Z',
        }),
      );
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockResolvedValue(new Blob(['square-preview']));
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();
    enterReprintReason(renderer.root);

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });
    expect(loadPreview).toHaveBeenCalledOnce();
    expect(systemPrint).not.toHaveBeenCalled();
    expect(
      renderer.root.findByProps({ 'aria-label': 'Причина повторной системной печати' }).props
        .disabled,
    ).toBe(true);
    expect(text(renderer.root)).toContain('Причина зафиксирована до подтверждения запроса.');

    await act(async () => {
      findButton(renderer.root).props.onClick();
      await settle();
    });

    expect(intent).toHaveBeenCalledTimes(2);
    expect(intent.mock.calls[1]?.[1]).toEqual(intent.mock.calls[0]?.[1]);
    expect(loadPreview).toHaveBeenCalledOnce();
    expect(systemPrint).toHaveBeenCalledOnce();
  });

  it('при ошибке preview не создаёт intent и безопасно повторяет только чтение', async () => {
    const previewBlob = new Blob(['recovered-preview'], { type: 'image/png' });
    const loadPreview = vi
      .spyOn(warehouseApi, 'fetchWarehousePalletPreview')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(previewBlob);
    const systemPrint = vi
      .spyOn(browserPrint, 'openWarehousePalletSystemPrint')
      .mockResolvedValue();
    const { renderer } = await renderPanel();

    expect(text(renderer.root)).toContain('Нет связи с платформой.');
    enterReprintReason(renderer.root);
    expect(findButton(renderer.root).props.disabled).toBe(true);
    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).not.toHaveBeenCalled();
    expect(systemPrint).not.toHaveBeenCalled();

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => text(button) === 'Повторить загрузку')
        ?.props.onClick();
      await settle();
    });

    expect(loadPreview).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType('img').props.src).toBe('blob:exact-pallet-preview');
    expect(findButton(renderer.root).props.disabled).toBe(false);
    expect(warehouseApi.recordWarehousePalletSystemPrintIntent).not.toHaveBeenCalled();
  });

  it('при смене документа не показывает запоздавший PNG и освобождает оба object URL', async () => {
    const firstPreview = new Blob(['first-preview'], { type: 'image/png' });
    const secondPreview = new Blob(['second-preview'], { type: 'image/png' });
    const firstRequest = deferred<Blob>();
    const secondDocument: PalletListDocument = {
      ...squareDocument,
      id: 'document-configurable-v7-2',
      palletId: 'PAL-A-2-08',
      templateVersion: 'pallet-100x100-configurable-v7',
    };
    vi.mocked(URL.createObjectURL).mockImplementation((preview) =>
      preview === firstPreview ? 'blob:first-preview' : 'blob:second-preview',
    );
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockImplementation((documentId) =>
      documentId === squareDocument.id ? firstRequest.promise : Promise.resolve(secondPreview),
    );
    const { renderer } = await renderPanel();

    await act(async () => {
      renderer.update(
        <PalletLabelPanel document={secondDocument} taskId="task-1" onWarehouseRefresh={vi.fn()} />,
      );
      await settle();
    });
    expect(renderer.root.findByType('img').props.src).toBe('blob:second-preview');

    await act(async () => {
      firstRequest.resolve(firstPreview);
      await settle();
    });
    expect(renderer.root.findByType('img').props.src).toBe('blob:second-preview');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-preview');

    act(() => renderer.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:second-preview');
  });

  it('не создаёт дубль intent при повторном клике во время запроса', async () => {
    let resolveIntent!: () => void;
    const intent = vi
      .mocked(warehouseApi.recordWarehousePalletSystemPrintIntent)
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveIntent = () =>
              resolve({
                eventId: 'event-1',
                requestId: '11111111-1111-4111-8111-111111111111',
                palletListDocumentId: squareDocument.id,
                kind: 'reprint',
                status: 'intent_recorded',
                replayed: false,
                requestedAt: '2026-08-09T07:00:00.000Z',
              });
          }),
      );
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(
      new Blob(['square-preview']),
    );
    vi.spyOn(browserPrint, 'openWarehousePalletSystemPrint').mockResolvedValue();
    const { renderer } = await renderPanel();
    enterReprintReason(renderer.root);

    const button = findButton(renderer.root);
    act(() => {
      button.props.onClick();
      button.props.onClick();
    });
    expect(intent).toHaveBeenCalledOnce();

    await act(async () => {
      resolveIntent();
      await settle();
    });
    expect(intent).toHaveBeenCalledOnce();
  });

  it('не падает и не загружает ресурсы для неизвестного templateVersion', async () => {
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    const preview = vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview');
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PalletLabelPanel
          document={{ ...squareDocument, templateVersion: 'pallet-unknown-v99' as never }}
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await settle();
    });

    expect(text(renderer.root)).toContain('Формат не подтвержден');
    expect(printers).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(() => findButton(renderer.root)).toThrow();
  });
});
