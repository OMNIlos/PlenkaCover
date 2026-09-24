import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { OperatorShiftSurface } from '../../components/workbenches/operatorWorkbench';
import { initialOperatorRuntime } from '../../domain/operator/fixtures';
import { MachineBreakdownForm } from './MachineBreakdownForm';

function activeRuntime() {
  return {
    ...initialOperatorRuntime,
    shift: { ...initialOperatorRuntime.shift, status: 'active' as const },
  };
}

describe('MachineBreakdownForm', () => {
  it('renders one explicit action with the complete labeled type list and optional details', () => {
    const markup = renderToStaticMarkup(
      <OperatorShiftSurface runtime={activeRuntime()} onAction={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Форма поломки станка"');
    expect(markup).toContain('for="operator-breakdown-type"');
    expect(markup).toContain('id="operator-breakdown-type"');
    expect(markup).toContain('Клин шнека');
    expect(markup).toContain('Экструдер остановился');
    expect(markup).toContain('Остановка привода');
    expect(markup).toContain('Обрыв ремня');
    expect(markup).toContain('Другая поломка');
    expect(markup).toContain('for="operator-breakdown-details"');
    expect(markup).toContain('maxLength="500"');
    expect(markup).toContain('Детали <span>необязательно</span>');
    expect(markup.match(/type="submit"/gu)).toHaveLength(1);
    expect(markup).not.toContain('Клин шнека, остановился экструдер…');
  });

  it('does not submit on selection and emits one structured command on explicit submit', () => {
    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface runtime={activeRuntime()} onAction={onAction} />,
      );
    });

    const select = renderer.root.findByProps({ id: 'operator-breakdown-type' });
    act(() => select.props.onChange({ target: { value: 'screw_jam' } }));
    expect(onAction).not.toHaveBeenCalled();

    const details = renderer.root.findByProps({ id: 'operator-breakdown-details' });
    act(() => details.props.onChange({ target: { value: '  Шнек не вращается  ' } }));
    const form = renderer.root.findByProps({ 'aria-label': 'Форма поломки станка' });
    act(() => form.props.onSubmit({ preventDefault: vi.fn() }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(
      `operator-machine-breakdown:${encodeURIComponent(
        JSON.stringify({ type: 'screw_jam', details: 'Шнек не вращается' }),
      )}`,
    );
  });

  it('exposes a structured submit callback from the isolated form', () => {
    const onSubmit = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<MachineBreakdownForm onSubmit={onSubmit} />);
    });

    act(() => {
      renderer.root
        .findByProps({ id: 'operator-breakdown-type' })
        .props.onChange({ target: { value: 'other' } });
      renderer.root
        .findByProps({ id: 'operator-breakdown-details' })
        .props.onChange({ target: { value: '  Видимая трещина  ' } });
    });
    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Форма поломки станка' })
        .props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ type: 'other', details: 'Видимая трещина' });
  });

  it('keeps values through pending and error, then clears only after confirmed success', () => {
    const onAction = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <OperatorShiftSurface
          runtime={activeRuntime()}
          onAction={onAction}
          breakdownPending={false}
          breakdownError={null}
          breakdownSuccessVersion={0}
        />,
      );
    });

    act(() => {
      renderer.root
        .findByProps({ id: 'operator-breakdown-type' })
        .props.onChange({ target: { value: 'belt_break' } });
      renderer.root
        .findByProps({ id: 'operator-breakdown-details' })
        .props.onChange({ target: { value: 'После запуска' } });
    });

    act(() => {
      renderer.update(
        <OperatorShiftSurface
          runtime={activeRuntime()}
          onAction={onAction}
          breakdownPending
          breakdownError={null}
          breakdownSuccessVersion={0}
        />,
      );
    });
    const pendingButton = renderer.root.findByProps({ type: 'submit' });
    expect(pendingButton.props.disabled).toBe(true);
    expect(pendingButton.props['aria-busy']).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).toContain('Отправляем…');
    expect(renderer.root.findByProps({ id: 'operator-breakdown-type' }).props.value).toBe(
      'belt_break',
    );

    act(() => {
      renderer.update(
        <OperatorShiftSurface
          runtime={activeRuntime()}
          onAction={onAction}
          breakdownPending={false}
          breakdownError="Заявка не отправлена"
          breakdownSuccessVersion={0}
        />,
      );
    });
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toBe(
      'Заявка не отправлена',
    );
    expect(renderer.root.findByProps({ id: 'operator-breakdown-type' }).props.value).toBe(
      'belt_break',
    );

    act(() => {
      renderer.update(
        <OperatorShiftSurface
          runtime={activeRuntime()}
          onAction={onAction}
          breakdownPending={false}
          breakdownError={null}
          breakdownSuccessVersion={1}
        />,
      );
    });
    expect(renderer.root.findByProps({ id: 'operator-breakdown-type' }).props.value).toBe('');
    expect(renderer.root.findByProps({ id: 'operator-breakdown-details' }).props.value).toBe('');
  });

  it('keeps touch controls full-width, 56px high, 18px text and a reserved feedback row', () => {
    const css = readFileSync(
      new URL('../../styles/35-production-operator-load.css', import.meta.url),
      'utf8',
    );

    expect(css).toMatch(/\.machine-breakdown-form\s*\{[^}]*width:\s*100%/su);
    expect(css).toMatch(
      /\.machine-breakdown-form\s+(?:select|textarea)[^{]*\{[^}]*min-height:\s*56px[^}]*font-size:\s*18px/su,
    );
    expect(css).toMatch(
      /\.machine-breakdown-submit\s*\{[^}]*min-height:\s*56px[^}]*font-size:\s*18px/su,
    );
    expect(css).toMatch(/\.machine-breakdown-feedback\s*\{[^}]*min-height:/su);
    expect(css).toContain('.machine-breakdown-form :focus-visible');
  });
});
