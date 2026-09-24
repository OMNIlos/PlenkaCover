import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import * as warehouseApi from '../../api/warehouse';
import type { PalletListDocument } from '../../domain/types';
import { PalletLabelPanel } from './PalletLabelPanel';
import { VoidPalletDialog } from './VoidPalletDialog';

const document = {
  id: 'document-77',
  palletId: 'PAL-ORD-77-001',
  warehousePalletId: 'pallet-77',
  origin: 'physical_pallet' as const,
  documentStatus: 'sealed' as const,
  printStatus: 'submitted' as const,
};

const voidedResult: warehouseApi.ServerVoidWarehousePalletResult = {
  ...document,
  createdAt: '2026-08-07T10:00:00.000Z',
  templateVersion: 'pallet-100x150-v1',
  printReady: true,
  rollCount: 2,
  rollCodes: ['ROLL-77-01', 'ROLL-77-02'],
  rollCodesHasMore: false,
  orderId: 'order-77',
  documentStatus: 'voided',
};

function button(root: ReactTestInstance, label: string) {
  return root.find((node) => node.type === 'button' && node.props['aria-label'] === label);
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

function renderDialog({
  printStatus = document.printStatus,
  onClose = vi.fn(),
  onSuccess = vi.fn(),
  onCanonicalRefresh = vi.fn(),
}: {
  printStatus?: 'not_printed' | 'submitted' | 'failed' | 'needs_admin';
  onClose?: () => void;
  onSuccess?: () => void;
  onCanonicalRefresh?: () => void;
} = {}) {
  return {
    renderer: TestRenderer.create(
      <VoidPalletDialog
        taskId="task-77"
        document={{ ...document, printStatus }}
        onClose={onClose}
        onSuccess={onSuccess}
        onCanonicalRefresh={onCanonicalRefresh}
      />,
    ),
    onClose,
    onSuccess,
    onCanonicalRefresh,
  };
}

function completeForm(root: ReactTestInstance, note = '  Повторно собрать палет.  ') {
  act(() => {
    root.findByProps({ 'aria-label': 'Причина аннулирования' }).props.onChange({
      target: { value: 'wrong_composition' },
    });
    root.findByProps({ 'aria-label': 'Комментарий к аннулированию' }).props.onChange({
      target: { value: note },
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VoidPalletDialog', () => {
  it('требует причину, ограничивает необязательный комментарий и объясняет судьбу напечатанной этикетки', () => {
    const { renderer } = renderDialog();
    const confirm = button(renderer.root, 'Подтвердить аннулирование палетного листа');

    expect(confirm.props.disabled).toBe(true);
    expect(
      renderer.root.findByProps({ 'aria-label': 'Причина аннулирования' }).props.autoFocus,
    ).toBe(true);
    expect(
      renderer.root.findByProps({ 'aria-label': 'Комментарий к аннулированию' }).props.maxLength,
    ).toBe(500);
    expect(text(renderer.root)).toContain('Напечатанную этикетку необходимо уничтожить');
    expect(text(renderer.root)).toContain(
      'QR-код прежнего листа останется доступен для трассировки',
    );

    completeForm(renderer.root);
    expect(button(renderer.root, 'Подтвердить аннулирование палетного листа').props.disabled).toBe(
      false,
    );
  });

  it('принимает ровно 500 символов комментария и отклоняет 501', () => {
    const { renderer } = renderDialog();
    completeForm(renderer.root, 'а'.repeat(500));
    expect(button(renderer.root, 'Подтвердить аннулирование палетного листа').props.disabled).toBe(
      false,
    );

    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Комментарий к аннулированию' }).props.onChange({
        target: { value: 'а'.repeat(501) },
      });
    });
    expect(button(renderer.root, 'Подтвердить аннулирование палетного листа').props.disabled).toBe(
      true,
    );
    expect(text(renderer.root)).toContain('501 / 500');
  });

  it('закрывается через Escape и кнопку без browser confirm', () => {
    const browserConfirm = vi.fn();
    vi.stubGlobal('confirm', browserConfirm);
    const { renderer, onClose } = renderDialog();
    const dialog = renderer.root.findByProps({ role: 'dialog' });
    const event = {
      key: 'Escape',
      defaultPrevented: false,
      currentTarget: dialog,
      target: { closest: () => dialog },
      preventDefault() {
        this.defaultPrevented = true;
      },
    };

    act(() => dialog.props.onKeyDown(event));
    act(() => button(renderer.root, 'Закрыть').props.onClick());

    expect(event.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(browserConfirm).not.toHaveBeenCalled();
  });

  it('не дублирует запрос и после успеха закрывает диалог только через каноническое обновление', async () => {
    let resolve!: (value: warehouseApi.ServerVoidWarehousePalletResult) => void;
    const request = vi.spyOn(warehouseApi, 'voidWarehousePallet').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { renderer, onClose, onSuccess } = renderDialog();
    completeForm(renderer.root);
    act(() => {
      const confirm = button(renderer.root, 'Подтвердить аннулирование палетного листа');
      confirm.props.onClick();
      confirm.props.onClick();
    });
    expect(request).toHaveBeenCalledOnce();

    await act(async () => {
      resolve(voidedResult);
      await Promise.resolve();
    });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('task-77', 'pallet-77', {
      operationKey: expect.any(String),
      reasonCode: 'wrong_composition',
      note: 'Повторно собрать палет.',
    });
  });

  it('повторяет неопределенную доставку тем же ключом и неизменным payload', async () => {
    const request = vi
      .spyOn(warehouseApi, 'voidWarehousePallet')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(voidedResult);
    const { renderer, onSuccess } = renderDialog();
    completeForm(renderer.root);

    await act(async () => {
      button(renderer.root, 'Подтвердить аннулирование палетного листа').props.onClick();
      await Promise.resolve();
    });
    expect(text(renderer.root)).toContain('Статус аннулирования не подтвержден');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Комментарий к аннулированию' }).props.disabled,
    ).toBe(true);

    await act(async () => {
      button(renderer.root, 'Повторить аннулирование палетного листа').props.onClick();
      await Promise.resolve();
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it('не позволяет закрыть неопределённую операцию до канонической сверки', async () => {
    const request = vi
      .spyOn(warehouseApi, 'voidWarehousePallet')
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(voidedResult);
    const { renderer, onClose } = renderDialog();
    completeForm(renderer.root);

    await act(async () => {
      button(renderer.root, 'Подтвердить аннулирование палетного листа').props.onClick();
      await Promise.resolve();
    });
    act(() => button(renderer.root, 'Закрыть').props.onClick());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      button(renderer.root, 'Повторить аннулирование палетного листа').props.onClick();
      await Promise.resolve();
    });
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });

  it('игнорирует поздний успешный ответ после перехода к другому палету', async () => {
    let resolve!: (result: warehouseApi.ServerVoidWarehousePalletResult) => void;
    vi.spyOn(warehouseApi, 'voidWarehousePallet').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onClose = vi.fn();
    const onSuccess = vi.fn();
    const onCanonicalRefresh = vi.fn();
    const view = (target = document) => (
      <VoidPalletDialog
        taskId="task-77"
        document={target}
        onClose={onClose}
        onSuccess={onSuccess}
        onCanonicalRefresh={onCanonicalRefresh}
      />
    );
    const renderer = TestRenderer.create(view());
    completeForm(renderer.root);
    act(() => button(renderer.root, 'Подтвердить аннулирование палетного листа').props.onClick());

    await act(async () => {
      renderer.update(
        view({
          ...document,
          palletId: 'PAL-ORD-77-002',
          warehousePalletId: 'pallet-78',
        }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolve(voidedResult);
      await Promise.resolve();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onCanonicalRefresh).not.toHaveBeenCalled();
  });

  it('на конфликте 409 обновляет каноническое состояние без устаревшего повтора', async () => {
    vi.spyOn(warehouseApi, 'voidWarehousePallet').mockRejectedValue(
      new ApiError(409, 'Палет уже изменен.', 'WAREHOUSE_PALLET_VOID_STATE_CONFLICT'),
    );
    const { renderer, onClose, onCanonicalRefresh } = renderDialog();
    completeForm(renderer.root);

    await act(async () => {
      button(renderer.root, 'Подтвердить аннулирование палетного листа').props.onClick();
      await Promise.resolve();
    });

    expect(onCanonicalRefresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Повторить аннулирование палетного листа' }),
    ).toHaveLength(0);
  });

  it('отдельно предупреждает о неясной доставке: бумажная этикетка может существовать', () => {
    const { renderer } = renderDialog({ printStatus: 'needs_admin' });

    expect(text(renderer.root)).toContain('Доставка на принтер не подтверждена');
    expect(text(renderer.root)).toContain('бумажная этикетка уже могла быть напечатана');
  });

  it('не открывается для аннулированного документа', () => {
    const renderer = TestRenderer.create(
      <VoidPalletDialog
        taskId="task-77"
        document={{ ...document, documentStatus: 'voided' }}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
        onCanonicalRefresh={vi.fn()}
      />,
    );

    expect(renderer.toJSON()).toBeNull();
  });

  it('не даёт печатать, выгружать или повторно аннулировать документ из voided-истории', async () => {
    const voidedDocument: PalletListDocument = {
      id: 'document-77',
      palletId: 'PAL-ORD-77-001',
      status: 'ready',
      formatLabel: 'PDF',
      fields: [],
      rollIds: ['ROLL-77-01'],
      warehousePalletId: 'pallet-77',
      origin: 'physical_pallet',
      documentStatus: 'voided',
      rollCount: 1,
      templateVersion: 'pallet-100x150-v1',
      printReady: true,
      printStatus: 'submitted',
      fieldSetStatus: 'contract_ready',
      availableFormats: ['word', 'excel', 'pdf'],
      sourceLabel: 'Backend API',
      auditEvent: 'audit:pallet_list_print_requested',
    };
    const preview = vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview');
    const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PalletLabelPanel
          document={voidedDocument}
          taskId="task-77"
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(text(renderer.root)).toContain('Аннулированный палетный лист');
    expect(
      renderer.root.findAll((node) =>
        node.props.className?.includes('warehouse-pallet-print-button'),
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll((node) =>
        node.props.className?.includes('warehouse-pallet-export-button'),
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Аннулировать палетный лист PAL-ORD-77-001',
      }),
    ).toHaveLength(0);
    expect(preview).not.toHaveBeenCalled();
    expect(printers).not.toHaveBeenCalled();
    expect(renderer.root.findAllByProps({ 'aria-label': 'Принтер этикеток' })).toHaveLength(0);
    expect(text(renderer.root)).not.toContain('Демонстрационный палетный лист');
    expect(text(renderer.root)).not.toContain('Device Gateway');
  });

  it.each([
    ['без статуса', undefined],
    ['с неизвестным статусом', 'unknown'],
  ] as const)(
    'fail-closed: физический документ %s не запускает lifecycle-действия',
    async (_label, documentStatus) => {
      const unresolvedDocument = {
        id: 'document-unknown',
        palletId: 'PAL-ORD-77-003',
        status: 'ready' as const,
        formatLabel: 'PDF' as const,
        fields: [],
        rollIds: ['ROLL-77-03'],
        warehousePalletId: 'pallet-79',
        origin: 'physical_pallet' as const,
        ...(documentStatus ? { documentStatus } : {}),
        templateVersion: 'pallet-100x150-v1' as const,
        printReady: true,
        printStatus: 'submitted' as const,
        fieldSetStatus: 'contract_ready' as const,
        sourceLabel: 'Backend API',
        auditEvent: 'audit:pallet_list_print_requested' as const,
      } as PalletListDocument;
      const preview = vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview');
      const printers = vi.spyOn(warehouseApi, 'fetchWarehousePrinters');
      let renderer!: TestRenderer.ReactTestRenderer;

      await act(async () => {
        renderer = TestRenderer.create(
          <PalletLabelPanel
            document={unresolvedDocument}
            taskId="task-77"
            onWarehouseRefresh={vi.fn()}
          />,
        );
        await Promise.resolve();
      });

      expect(text(renderer.root)).toContain('Статус палетного листа не подтвержден');
      expect(renderer.root.findAllByProps({ 'aria-label': 'Принтер этикеток' })).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({ 'aria-label': 'Аннулировать палетный лист PAL-ORD-77-003' }),
      ).toHaveLength(0);
      expect(preview).not.toHaveBeenCalled();
      expect(printers).not.toHaveBeenCalled();
    },
  );

  it('показывает явное аннулирование только для физического sealed-документа из истории', async () => {
    const sealedDocument: PalletListDocument = {
      id: 'document-77',
      palletId: 'PAL-ORD-77-001',
      status: 'ready',
      formatLabel: 'PDF',
      fields: [],
      rollIds: ['ROLL-77-01'],
      warehousePalletId: 'pallet-77',
      origin: 'physical_pallet',
      documentStatus: 'sealed',
      rollCount: 1,
      templateVersion: 'pallet-100x150-v1',
      printReady: true,
      printStatus: 'submitted',
      fieldSetStatus: 'contract_ready',
      availableFormats: ['word', 'excel', 'pdf'],
      sourceLabel: 'Backend API',
      auditEvent: 'audit:pallet_list_print_requested',
    };
    vi.spyOn(warehouseApi, 'fetchWarehousePalletPreview').mockResolvedValue(new Blob(['preview']));
    vi.spyOn(warehouseApi, 'fetchWarehousePrinters').mockResolvedValue([]);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <PalletLabelPanel
          document={sealedDocument}
          taskId="task-77"
          voidAllowed={false}
          onWarehouseRefresh={vi.fn()}
        />,
      );
      await Promise.resolve();
    });
    expect(
      renderer.root.findAllByProps({
        'aria-label': 'Аннулировать палетный лист PAL-ORD-77-001',
      }),
    ).toHaveLength(0);
  });
});
