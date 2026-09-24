import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../api/client';
import { bootstrapFixture, legacyLayoutFixture } from './palletLabelLayoutTestFixtures';
import {
  PalletLabelLayoutSection,
  palletLayoutPreviewErrorMessage,
} from './PalletLabelLayoutSection';

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join(' ');
}

function button(root: TestRenderer.ReactTestInstance, label: string) {
  return root.findByProps({ 'aria-label': label });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('PalletLabelLayoutSection', () => {
  const preview = vi.fn();
  const publish = vi.fn();
  const load = vi.fn();
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.useFakeTimers();
    load.mockReset().mockResolvedValue(bootstrapFixture);
    preview.mockReset().mockResolvedValue({
      png: new Blob(['png'], { type: 'image/png' }),
      diagnostics: {
        belowProvenCut: [],
        outsideSafeArea: [],
        overlaps: [],
      },
    });
    publish.mockReset();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:exact-preview'),
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    vi.stubGlobal('crypto', {
      randomUUID: vi
        .fn()
        .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
        .mockReturnValueOnce('22222222-2222-4222-8222-222222222222'),
    });
    vi.stubGlobal('print', vi.fn());
  });

  afterEach(() => {
    renderer?.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PalletLabelLayoutSection, { api: { load, preview, publish } }),
      );
      await Promise.resolve();
    });
    return renderer.root;
  }

  it('truthfully shows the V2 base before the first publication and never exposes print actions', async () => {
    const root = await render();
    const copy = text(root);

    expect(copy).toContain('Макет палетного листа');
    expect(copy).toContain('Базовый макет v2');
    expect(copy).toContain('Опубликовать и применить');
    expect(copy).not.toMatch(/печатать|распечатать/i);
    expect(root.findByProps({ 'aria-label': 'Источник данных для предпросмотра' })).toBeTruthy();
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(true);
    expect(button(root, 'Отменить изменение').props.disabled).toBe(true);
    expect(button(root, 'Вернуть изменение').props.disabled).toBe(true);
    expect(globalThis.print).not.toHaveBeenCalled();
  });

  it('shows the active version and short hash from strict publication metadata', async () => {
    load.mockResolvedValueOnce({
      ...bootstrapFixture,
      activePublication: {
        id: 'publication-7',
        version: 7,
        contentHash: 'abcdef0123456789'.padEnd(64, '0'),
        activatedAt: '2026-08-11T21:30:00.000Z',
        layout: bootstrapFixture.editorLayout,
      },
    });
    const root = await render();

    expect(text(root)).toContain('Активный макет v7');
    expect(text(root)).toContain('abcdef01');
  });

  it('makes legacy activation explicit while editing the unpublished V2 draft', async () => {
    load.mockResolvedValueOnce({
      ...bootstrapFixture,
      activePublication: {
        id: 'legacy-publication-1',
        version: 1,
        contentHash: 'b'.repeat(64),
        activatedAt: '2026-08-11T21:30:00.000Z',
        layout: legacyLayoutFixture,
      },
    });
    const root = await render();

    expect(text(root)).toContain('Сейчас печатается исторический макет V1');
    expect(text(root)).toContain('Новый V2 начнет применяться только после публикации');
    expect(root.findAllByProps({ 'data-layout-element': 'order' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-layout-element': 'header' })).toHaveLength(0);
  });

  it('keeps QR selected but disables all geometry and font inputs', async () => {
    const root = await render();

    act(() => button(root, 'Выбрать блок QR палетного листа').props.onClick());

    expect(root.findByProps({ 'aria-label': 'X, мм' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'aria-label': 'Y, мм' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'aria-label': 'Ширина, мм' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'aria-label': 'Высота, мм' }).props.disabled).toBe(true);
    expect(root.findByProps({ 'aria-label': 'Максимальный размер шрифта' }).props.disabled).toBe(
      true,
    );
    expect(text(root)).toContain('QR зафиксирован');
  });

  it('offers exactly six system blocks and removes/restores an optional block once', async () => {
    const root = await render();
    const catalog = root.findByProps({ 'aria-label': 'Каталог системных блоков' });

    expect(
      catalog
        .findAll((node) => typeof node.props['data-catalog-element'] === 'string')
        .map((node) => node.props['data-catalog-element']),
    ).toEqual(['order', 'customer', 'formedAt', 'rollCount', 'qr', 'storage']);
    expect(text(catalog)).toContain('QR палетного листа Обязательный');
    expect(root.findAllByProps({ 'aria-label': 'Удалить блок QR палетного листа' })).toHaveLength(0);
    expect(text(catalog)).not.toMatch(/продукт|упаковка|коды рулонов|изображение/i);

    act(() => button(root, 'Удалить блок Заказчик').props.onClick());

    expect(root.findAllByProps({ 'data-layout-element': 'customer' })).toHaveLength(0);
    expect(button(root, 'Вернуть блок Заказчик')).toBeTruthy();

    act(() => button(root, 'Вернуть блок Заказчик').props.onClick());

    expect(root.findAllByProps({ 'data-layout-element': 'customer' })).toHaveLength(1);
    expect(root.findAllByProps({ 'aria-label': 'Вернуть блок Заказчик' })).toHaveLength(0);
  });

  it('keeps interactive blocks exposed to assistive tech and selection in sync with focus', async () => {
    const root = await render();
    const canvas = root.findByProps({ 'aria-label': 'Холст палетного листа 100 на 100 мм' });
    const customer = button(root, 'Выбрать блок Заказчик');

    expect(canvas.props.role).toBe('group');
    act(() => customer.props.onFocus());
    expect(customer.props['aria-pressed']).toBe(true);
    expect(text(root.findByProps({ 'aria-label': 'Параметры блока' }))).toContain('Заказчик');

    const preventDefault = vi.fn();
    act(() => customer.props.onKeyDown({ key: ' ', shiftKey: false, preventDefault }));
    expect(preventDefault).toHaveBeenCalled();
  });

  it('renders the selected block above later blocks so its resize handle stays reachable', async () => {
    const root = await render();
    const renderedIds = () =>
      root
        .findAll((node) => typeof node.props['data-layout-element'] === 'string')
        .map((node) => node.props['data-layout-element']);

    expect(renderedIds().at(-1)).toBe('order');
    act(() => button(root, 'Выбрать блок Заказчик').props.onClick());
    expect(renderedIds().at(-1)).toBe('customer');
  });

  it('keeps the larger six-block baseline inside the proven print area', async () => {
    const root = await render();

    expect(text(root)).toContain('Все блоки в гарантированной зоне');
    expect(text(root)).toContain('Все блоки внутри безопасной границы');
    expect(text(root)).toContain('Пересечений нет');
  });

  it('renders the promised 1 mm minor grid at exactly 8 dots', async () => {
    const root = await render();
    const minorGrid = root.findByProps({ id: 'pallet-layout-minor-grid' });

    expect(minorGrid.props.width).toBe(bootstrapFixture.canvas.dotsPerMm);
    expect(minorGrid.props.height).toBe(bootstrapFixture.canvas.dotsPerMm);
    expect(text(root)).toContain('Сетка 1 мм');
  });

  it('debounces exact PNG rendering and refreshes immediately after a pointer gesture ends', async () => {
    const root = await render();

    await act(async () => {
      vi.advanceTimersByTime(399);
      await Promise.resolve();
    });
    expect(preview).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(preview).toHaveBeenCalledTimes(1);

    const order = root.findByProps({ 'data-layout-element': 'order' });
    const capture = vi.fn();
    act(() =>
      order.props.onPointerDown({
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        currentTarget: { setPointerCapture: capture },
        preventDefault: vi.fn(),
      }),
    );
    act(() =>
      order.props.onPointerMove({
        pointerId: 1,
        clientX: 42,
        clientY: 26,
        currentTarget: { ownerSVGElement: { getBoundingClientRect: () => ({ width: 800 }) } },
        preventDefault: vi.fn(),
      }),
    );
    await act(async () => {
      order.props.onPointerUp({ pointerId: 1, preventDefault: vi.fn() });
      await Promise.resolve();
    });

    expect(preview).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a rollout response has no validation source', async () => {
    load.mockResolvedValueOnce({ ...bootstrapFixture, sources: [] });
    const root = await render();

    expect(text(root)).toContain('Сервер не вернул источник для предпросмотра.');
    expect(preview).not.toHaveBeenCalled();
    expect(root.findAllByProps({ 'aria-label': 'Источник данных для предпросмотра' })).toHaveLength(0);
  });

  it('uses the control label and stable control id for an otherwise purged bootstrap', async () => {
    load.mockResolvedValueOnce({
      ...bootstrapFixture,
      sources: [
        {
          ...bootstrapFixture.sources[0],
          documentId: 'control-pallet-label-layout-v1',
          kind: 'control',
          label: 'Контрольный синтетический источник',
          rollCount: 1,
        },
      ],
    });
    const root = await render();

    expect(
      text(root.findByProps({ 'aria-label': 'Источник данных для предпросмотра' })).replace(
        /\s+/gu,
        ' ',
      ),
    ).toContain(
      'Контрольный синтетический источник · 1 рул.',
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDocumentId: 'control-pallet-label-layout-v1' }),
      expect.anything(),
    );
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(false);
  });

  it('invalidates an in-flight preview immediately when its source changes', async () => {
    const first = deferred<Blob>();
    const second = deferred<Blob>();
    const firstBlob = new Blob(['first'], { type: 'image/png' });
    const secondBlob = new Blob(['second'], { type: 'image/png' });
    preview
      .mockReset()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.mocked(URL.createObjectURL).mockImplementation((blob) =>
      blob === firstBlob ? 'blob:first' : 'blob:second',
    );
    load.mockResolvedValueOnce({
      ...bootstrapFixture,
      sources: [
        ...bootstrapFixture.sources,
        {
          documentId: 'doc-2',
          kind: 'document',
          label: 'Палетный лист PAL-A-2-06',
          palletId: 'PAL-A-2-06',
          createdAt: '2026-08-10T08:00:00.000Z',
          rollCount: 2,
        },
      ],
    });
    const root = await render();

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(preview).toHaveBeenCalledTimes(1);

    act(() =>
      root
        .findByProps({ 'aria-label': 'Источник данных для предпросмотра' })
        .props.onChange({ target: { value: 'doc-2' } }),
    );
    expect(preview.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

    await act(async () => {
      first.resolve({
        png: firstBlob,
        diagnostics: { belowProvenCut: [], outsideSafeArea: [], overlaps: [] },
      } as never);
      await first.promise;
      await Promise.resolve();
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[1]?.[0].sourceDocumentId).toBe('doc-2');

    await act(async () => {
      second.resolve({
        png: secondBlob,
        diagnostics: { belowProvenCut: [], outsideSafeArea: [], overlaps: [] },
      } as never);
      await second.promise;
      await Promise.resolve();
    });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(root.findByType('img').props.src).toBe('blob:second');
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(false);
  });

  it('hides and revokes a same-source preview while its replacement fails', async () => {
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(root.findByType('img').props.src).toBe('blob:exact-preview');
    vi.mocked(URL.revokeObjectURL).mockClear();

    preview.mockRejectedValueOnce(
      new ApiError(422, 'overflow', 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW'),
    );
    act(() =>
      root.findByProps({ 'aria-label': 'X, мм' }).props.onChange({ target: { value: '6' } }),
    );

    expect(root.findAllByType('img')).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:exact-preview');
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(root.findAllByType('img')).toHaveLength(0);
    expect(text(root)).toContain('Текст не помещается');
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('unlocks publication only for the exact current preview key and publishable diagnostics', async () => {
    const root = await render();

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(false);

    act(() =>
      root.findByProps({ 'aria-label': 'X, мм' }).props.onChange({ target: { value: '6' } }),
    );
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(true);

    preview.mockResolvedValueOnce({
      png: new Blob(['invalid'], { type: 'image/png' }),
      diagnostics: {
        belowProvenCut: [],
        outsideSafeArea: [],
        overlaps: [{ first: 'order', second: 'customer' }],
      },
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(true);
    expect(text(root)).toContain('Сервер подтвердил пересечение блоков');
  });

  it('requires a visible reason confirmation and updates the active baseline after publish', async () => {
    const publication = {
      id: 'publication-1',
      version: 1,
      contentHash: 'c'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: structuredClone(bootstrapFixture.editorLayout),
    };
    publish.mockResolvedValueOnce({ publication, replayed: false });
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    act(() => button(root, 'Опубликовать и применить').props.onClick());
    expect(text(root)).toContain('Только новые палетные листы');
    expect(
      root.findByProps({
        role: 'region',
        'aria-labelledby': 'pallet-layout-publish-confirmation-title',
      }),
    ).toBeTruthy();
    expect(root.findAllByProps({ role: 'dialog' })).toHaveLength(0);
    const reason = root.findByProps({ 'aria-label': 'Причина публикации макета' });
    expect(button(root, 'Подтвердить публикацию макета').props.disabled).toBe(true);
    act(() => reason.props.onChange({ target: { value: '  Проверен новый макет  ' } }));
    expect(button(root, 'Подтвердить публикацию макета').props.disabled).toBe(false);

    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledWith({
      operationKey: '11111111-1111-4111-8111-111111111111',
      expectedActivePublicationId: null,
      sourceDocumentId: 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206',
      reason: 'Проверен новый макет',
      layout: bootstrapFixture.editorLayout,
    });
    expect(text(root)).toContain('Активный макет v1');
    expect(text(root)).toContain('Ранее сформированные листы не изменятся');
    expect(globalThis.print).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text(root)).toContain('Ранее сформированные листы не изменятся');
  });

  it('publishes the exact optional-block set confirmed by the current preview', async () => {
    const withoutCustomer = {
      ...bootstrapFixture.editorLayout,
      elements: bootstrapFixture.editorLayout.elements.filter(
        (element) => element.id !== 'customer',
      ),
    };
    publish.mockResolvedValueOnce({
      publication: {
        id: 'publication-without-customer',
        version: 1,
        contentHash: '9'.repeat(64),
        activatedAt: '2026-08-11T21:30:00.000Z',
        layout: withoutCustomer,
      },
      replayed: false,
    });
    const root = await render();

    await act(async () => {
      button(root, 'Удалить блок Заказчик').props.onClick();
      await Promise.resolve();
    });
    expect(preview.mock.calls.at(-1)?.[0].layout).toEqual(withoutCustomer);
    expect(button(root, 'Опубликовать и применить').props.disabled).toBe(false);

    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Макет без заказчика' } }),
    );
    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });

    expect(publish.mock.calls[0]?.[0].layout).toEqual(withoutCustomer);
  });

  it('reports an idempotent replay without claiming a second publication', async () => {
    publish.mockResolvedValueOnce({
      publication: {
        id: 'publication-1',
        version: 1,
        contentHash: 'd'.repeat(64),
        activatedAt: '2026-08-11T21:30:00.000Z',
        layout: bootstrapFixture.editorLayout,
      },
      replayed: true,
    });
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );
    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });

    expect(text(root)).toContain('Публикация уже была подтверждена');
  });

  it('locks publication controls and exposes a live pending state until the command resolves', async () => {
    const pending = deferred<{
      publication: {
        id: string;
        version: number;
        contentHash: string;
        activatedAt: string;
        layout: typeof bootstrapFixture.editorLayout;
      };
      replayed: boolean;
    }>();
    publish.mockReturnValueOnce(pending.promise);
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );

    act(() => button(root, 'Подтвердить публикацию макета').props.onClick());

    expect(root.findByProps({ 'aria-label': 'Макет палетного листа' }).props['aria-busy']).toBe(
      true,
    );
    expect(
      root.findByProps({ 'aria-label': 'Источник данных для предпросмотра' }).props.disabled,
    ).toBe(true);
    expect(text(root)).toContain('Публикуем…');

    const canvas = root.findByProps({ 'aria-label': 'Холст палетного листа 100 на 100 мм' });
    expect(canvas.props['aria-disabled']).toBe(true);
    const beforeX = root.findByProps({ 'aria-label': 'X, мм' }).props.value;
    const storageCalls = vi.mocked(localStorage.setItem).mock.calls.length;
    const order = root.findByProps({ 'data-layout-element': 'order' });
    act(() =>
      order.props.onPointerDown({
        pointerId: 9,
        clientX: 10,
        clientY: 10,
        currentTarget: { setPointerCapture: vi.fn() },
        preventDefault: vi.fn(),
      }),
    );
    act(() =>
      order.props.onPointerMove({
        pointerId: 9,
        clientX: 90,
        clientY: 42,
        currentTarget: { ownerSVGElement: { getBoundingClientRect: () => ({ width: 800 }) } },
        preventDefault: vi.fn(),
      }),
    );
    act(() => order.props.onPointerUp({ pointerId: 9, preventDefault: vi.fn() }));
    expect(root.findByProps({ 'aria-label': 'X, мм' }).props.value).toBe(beforeX);
    expect(localStorage.setItem).toHaveBeenCalledTimes(storageCalls);

    await act(async () => {
      pending.resolve({
        publication: {
          id: 'publication-1',
          version: 1,
          contentHash: 'f'.repeat(64),
          activatedAt: '2026-08-11T21:30:00.000Z',
          layout: bootstrapFixture.editorLayout,
        },
        replayed: false,
      });
      await pending.promise;
    });
  });

  it('shows an actionable publish error without changing geometry or history', async () => {
    publish.mockRejectedValueOnce(
      new ApiError(422, 'English backend detail', 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW'),
    );
    const root = await render();
    act(() =>
      root.findByProps({ 'aria-label': 'X, мм' }).props.onChange({ target: { value: '6' } }),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    const editedX = root.findByProps({ 'aria-label': 'X, мм' }).props.value;
    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );
    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });

    expect(text(root)).toContain('Текст не помещается в выбранные блоки');
    expect(root.findByProps({ 'aria-label': 'X, мм' }).props.value).toBe(editedX);
    expect(button(root, 'Отменить изменение').props.disabled).toBe(false);
  });

  it('retries an uncertain identical publish command with the same operation key', async () => {
    publish
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce({
        publication: {
          id: 'publication-1',
          version: 1,
          contentHash: '1'.repeat(64),
          activatedAt: '2026-08-11T21:30:00.000Z',
          layout: bootstrapFixture.editorLayout,
        },
        replayed: true,
      });
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );

    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });
    expect(text(root)).toContain('Статус публикации не подтвержден');

    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual(publish.mock.calls[0]?.[0]);
    expect(text(root)).toContain('Публикация уже была подтверждена');
  });

  it('preserves edited geometry and history after 409, refreshes metadata and uses a new key', async () => {
    const refreshedPublication = {
      id: 'publication-other',
      version: 3,
      contentHash: 'e'.repeat(64),
      activatedAt: '2026-08-11T22:00:00.000Z',
      layout: bootstrapFixture.editorLayout,
    };
    load
      .mockReset()
      .mockResolvedValueOnce(bootstrapFixture)
      .mockResolvedValueOnce({
        ...bootstrapFixture,
        activePublication: refreshedPublication,
        editorLayout: refreshedPublication.layout,
      });
    publish
      .mockRejectedValueOnce(new ApiError(409, 'stale', 'PALLET_LABEL_LAYOUT_ACTIVE_CONFLICT'))
      .mockResolvedValueOnce({
        publication: { ...refreshedPublication, id: 'publication-4', version: 4 },
        replayed: false,
      });
    const root = await render();
    act(() =>
      root.findByProps({ 'aria-label': 'X, мм' }).props.onChange({ target: { value: '6' } }),
    );
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    const editedX = root.findByProps({ 'aria-label': 'X, мм' }).props.value;

    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );
    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(root.findByProps({ 'aria-label': 'X, мм' }).props.value).toBe(editedX);
    expect(button(root, 'Отменить изменение').props.disabled).toBe(false);
    expect(text(root)).toContain('Активный макет изменился');
    expect(text(root)).toContain('Активный макет v3');

    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });
    expect(publish.mock.calls[0]?.[0].operationKey).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      operationKey: '22222222-2222-4222-8222-222222222222',
      expectedActivePublicationId: 'publication-other',
    });
  });

  it('blocks a stale 409 retry until active metadata refresh recovers', async () => {
    const refreshedPublication = {
      id: 'publication-other',
      version: 3,
      contentHash: 'e'.repeat(64),
      activatedAt: '2026-08-11T22:00:00.000Z',
      layout: bootstrapFixture.editorLayout,
    };
    load
      .mockReset()
      .mockResolvedValueOnce(bootstrapFixture)
      .mockRejectedValueOnce(new TypeError('refresh failed'))
      .mockResolvedValueOnce({
        ...bootstrapFixture,
        activePublication: refreshedPublication,
        editorLayout: refreshedPublication.layout,
      });
    publish
      .mockRejectedValueOnce(new ApiError(409, 'stale', 'PALLET_LABEL_LAYOUT_ACTIVE_CONFLICT'))
      .mockResolvedValueOnce({
        publication: { ...refreshedPublication, id: 'publication-4', version: 4 },
        replayed: false,
      });
    const root = await render();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    act(() => button(root, 'Опубликовать и применить').props.onClick());
    act(() =>
      root
        .findByProps({ 'aria-label': 'Причина публикации макета' })
        .props.onChange({ target: { value: 'Проверенный макет' } }),
    );
    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(text(root)).toContain('Не удалось обновить активную версию');
    expect(button(root, 'Подтвердить публикацию макета').props.disabled).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);

    act(() =>
      root.findByProps({ 'aria-label': 'X, мм' }).props.onChange({ target: { value: '6' } }),
    );
    expect(button(root, 'Обновить активную версию')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });

    await act(async () => {
      button(root, 'Обновить активную версию').props.onClick();
      await Promise.resolve();
    });
    expect(text(root)).toContain('Активный макет v3');
    expect(button(root, 'Подтвердить публикацию макета').props.disabled).toBe(false);

    await act(async () => {
      button(root, 'Подтвердить публикацию макета').props.onClick();
      await Promise.resolve();
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toMatchObject({
      operationKey: '22222222-2222-4222-8222-222222222222',
      expectedActivePublicationId: 'publication-other',
    });
  });
});

describe('pallet layout preview error copy', () => {
  it.each([
    [
      'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW',
      'Текст не помещается в выбранные блоки. Увеличьте блок или уменьшите шрифт.',
    ],
    [
      'PALLET_LABEL_LAYOUT_SOURCE_UNAVAILABLE',
      'Источник данных временно недоступен. Выберите другой палетный лист или попробуйте позже.',
    ],
    [
      'PALLET_LABEL_LAYOUT_SOURCE_NOT_FOUND',
      'Палетный лист для предпросмотра не найден. Выберите другой источник.',
    ],
    [
      'PALLET_LABEL_LAYOUT_INVALID',
      'Макет содержит недопустимые параметры. Проверьте размеры и положение блоков.',
    ],
  ])('maps %s to actionable Russian copy', (code, expected) => {
    expect(palletLayoutPreviewErrorMessage(new ApiError(422, 'English backend detail', code))).toBe(
      expected,
    );
  });
});
