import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  isEventFromNestedDialog,
  PlenkiDataTable,
  PlenkiModal,
  restorePlenkiModalFocus,
} from './PlenkiPrimitives';

describe('PlenkiModal semantics', () => {
  it('renders a labelled modal dialog with a keyboard-focus fallback', () => {
    const markup = renderToStaticMarkup(
      <PlenkiModal title="Проверка" onClose={() => undefined}>
        <p>Содержимое</p>
      </PlenkiModal>,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Проверка"');
    expect(markup).toContain('tabindex="-1"');
    expect(markup).toContain('aria-label="Закрыть"');
  });

  it('renders header actions and dedicated header, body, and footer classes', () => {
    const markup = renderToStaticMarkup(
      <PlenkiModal
        title="Проверка"
        headerActions={<button type="button">Добавить +</button>}
        headerClassName="recipe-editor-header"
        bodyClassName="recipe-editor-body"
        footerClassName="recipe-editor-footer"
        footer={<button type="button">Готово</button>}
        onClose={() => undefined}
      >
        <p>Содержимое</p>
      </PlenkiModal>,
    );

    expect(markup).toContain('class="plenki-modal-head recipe-editor-header"');
    expect(markup).toContain('class="plenki-modal-body recipe-editor-body"');
    expect(markup).toContain('class="plenki-modal-footer recipe-editor-footer"');
    expect(markup).toContain('>Добавить +<');
  });

  it('detects nested dialog ownership without requiring a browser Element global', () => {
    const outer = { role: 'dialog' } as unknown as EventTarget;
    const inner = { role: 'dialog' } as unknown as EventTarget;

    expect(
      isEventFromNestedDialog(outer, {
        closest: vi.fn(() => inner),
      } as unknown as EventTarget),
    ).toBe(true);
    expect(
      isEventFromNestedDialog(outer, {
        closest: vi.fn(() => outer),
      } as unknown as EventTarget),
    ).toBe(false);
    expect(isEventFromNestedDialog(outer, null)).toBe(false);
  });

  it('lets only the inner dialog own Escape and leaves it default-prevented for window', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();
    const renderer = TestRenderer.create(
      <PlenkiModal title="Внешний" onClose={outerClose}>
        <PlenkiModal title="Внутренний" onClose={innerClose}>
          <button type="button">Поле</button>
        </PlenkiModal>
      </PlenkiModal>,
    );
    const dialogs = renderer.root.findAllByProps({ role: 'dialog' });
    const outer = dialogs[0];
    const inner = dialogs[1];
    const event = {
      key: 'Escape',
      defaultPrevented: false,
      currentTarget: inner,
      target: {
        closest: () => inner,
      },
      preventDefault() {
        this.defaultPrevented = true;
      },
    };

    act(() => {
      inner.props.onKeyDown(event);
      event.currentTarget = outer;
      outer.props.onKeyDown(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
  });

  it('ignores already-prevented Tab instead of stealing nested focus', () => {
    const renderer = TestRenderer.create(
      <PlenkiModal title="Проверка" onClose={vi.fn()}>
        <button type="button">Поле</button>
      </PlenkiModal>,
    );
    const dialog = renderer.root.findByProps({ role: 'dialog' });
    const preventDefault = vi.fn();

    act(() =>
      dialog.props.onKeyDown({
        key: 'Tab',
        defaultPrevented: true,
        currentTarget: dialog,
        target: { closest: () => dialog },
        preventDefault,
      }),
    );

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('restores a still-usable opening trigger without a browser DOM', () => {
    const focus = vi.fn();
    const trigger = {
      isConnected: true,
      matches: vi.fn((selector: string) => selector !== ':disabled'),
      getAttribute: vi.fn(() => null),
      ownerDocument: {
        defaultView: {
          getComputedStyle: vi.fn(() => ({
            display: 'block',
            visibility: 'visible',
          })),
        },
      },
      getClientRects: vi.fn(() => [{ width: 1, height: 1 }]),
      focus,
    } as unknown as HTMLElement;

    restorePlenkiModalFocus(trigger);

    expect(focus).toHaveBeenCalledOnce();
  });

  it('passes the exact interactive row to modal-opening handlers', () => {
    const onRowClick = vi.fn();
    const renderer = TestRenderer.create(
      <PlenkiDataTable
        columns={[{ id: 'code', header: 'Код', render: (row: { code: string }) => row.code }]}
        rows={[{ code: 'ROLL-001' }]}
        getRowKey={(row) => row.code}
        onRowClick={onRowClick}
      />,
    );
    const row = renderer.root.findByProps({ role: 'button' });
    const focus = vi.fn();
    const trigger = { focus } as unknown as HTMLTableRowElement;

    act(() => {
      row.props.onClick({ currentTarget: trigger });
    });

    expect(focus).toHaveBeenCalledOnce();
    expect(onRowClick).toHaveBeenCalledWith({ code: 'ROLL-001' }, 0, trigger);
  });
});
