import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ServerPayrollTariffMatrix } from '../../../api/payrollTariffOrders';
import type { PayrollTariffOrderEditor } from './payrollTariffOrderModel';
import { PayrollTariffMatrixEditor } from './PayrollTariffMatrixEditor';

function matrix(): ServerPayrollTariffMatrix {
  return {
    schemaVersion: 1,
    ladders: {
      urp12h: [
        { maxInclusiveGrams: 750_000, primaryRateKopecksPerKg: 400, secondaryRateKopecksPerKg: 500 },
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
      ],
      urp24h: [
        { maxInclusiveGrams: null, primaryRateKopecksPerKg: 550, secondaryRateKopecksPerKg: 650 },
      ],
      abc12h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
      ],
      abc24h: [
        { maxInclusiveGrams: null, standardRateKopecksPerKg: 500, blackWhiteRateKopecksPerKg: 550 },
      ],
    },
    specialRules: {
      thinRoll: { enabled: true, maxExclusiveGrams: 7_000, rateKopecksPerKg: 650 },
      alabuga: {
        enabled: true,
        machineFamily: 'abc_new',
        normalizedLegalName: 'ОЭЗ ППТ АЛАБУГА АО',
        rateKopecksPerKg: 400,
      },
    },
  };
}

function editor(status: PayrollTariffOrderEditor['status'] = 'draft'): PayrollTariffOrderEditor {
  return {
    orderId: '11111111-1111-4111-8111-111111111111',
    status,
    revision: 2,
    name: 'Приказ № 9-08/26',
    effectiveFrom: '2026-08-15',
    matrix: matrix(),
    review: null,
  };
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('');
}

describe('PayrollTariffMatrixEditor', () => {
  it('renders four ladder tables, editable closed bands, and a fixed open last row', () => {
    const onChange = vi.fn();
    const renderer = TestRenderer.create(
      <PayrollTariffMatrixEditor editor={editor()} fieldErrors={[]} onChange={onChange} />,
    );

    expect(renderer.root.findAllByProps({ 'data-payroll-ladder': true })).toHaveLength(4);
    expect(text(renderer.root)).toContain('УРП / Матиль / Китайка · 12 часов');
    expect(text(renderer.root)).toContain('АВС · 24 часа');
    const openThreshold = renderer.root.findByProps({
      'aria-label': 'УРП / Матиль / Китайка · 12 часов, последний открытый диапазон',
    });
    expect(openThreshold.props.disabled).toBe(true);

    const add = renderer.root.findByProps({ 'aria-label': 'Добавить диапазон УРП 12 часов' });
    act(() => add.props.onClick());
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        matrix: expect.objectContaining({
          ladders: expect.objectContaining({ urp12h: expect.any(Array) }),
        }),
      }),
    );

    const remove = renderer.root.findByProps({ 'aria-label': 'Удалить диапазон 1 УРП 12 часов' });
    act(() => remove.props.onClick());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(text(renderer.root)).not.toContain('Удалить последний диапазон');
  });

  it('shows kopeck inputs with ruble helpers plus thin-roll and Alabuga controls', () => {
    const renderer = TestRenderer.create(
      <PayrollTariffMatrixEditor editor={editor()} fieldErrors={[]} onChange={vi.fn()} />,
    );

    expect(renderer.root.findAllByProps({ inputMode: 'numeric' }).length).toBeGreaterThan(4);
    expect(text(renderer.root)).toContain('4,00 ₽/кг');
    expect(text(renderer.root)).toContain('Фальц');
    expect(text(renderer.root)).not.toMatch(/ч[её]рно-бел/u);
    expect(text(renderer.root)).toContain('Тонкий рулон');
    expect(text(renderer.root)).toContain('Алабуга');
    expect(renderer.root.findByProps({ name: 'thin-roll-enabled' }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ name: 'alabuga-enabled' }).props.checked).toBe(true);
  });

  it('maps server field errors to controls and makes a published matrix read-only', () => {
    const renderer = TestRenderer.create(
      <PayrollTariffMatrixEditor
        editor={editor('published')}
        fieldErrors={[
          {
            path: 'matrix.ladders.urp12h[0].primaryRateKopecksPerKg',
            code: 'integer',
            message: 'Только целые неотрицательные копейки',
          },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(text(renderer.root)).toContain('Только целые неотрицательные копейки');
    expect(renderer.root.findAllByType('input').every((input) => input.props.disabled)).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-action': 'add-band' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-action': 'remove-band' })).toHaveLength(0);
  });

  it('supports an explicit read-only presentation without changing the editor status', () => {
    const draft = editor('draft');
    const renderer = TestRenderer.create(
      <PayrollTariffMatrixEditor
        editor={draft}
        fieldErrors={[]}
        onChange={vi.fn()}
        readOnly
      />,
    );

    expect(draft.status).toBe('draft');
    expect(renderer.root.findAllByType('input').every((input) => input.props.disabled)).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-action': 'add-band' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-action': 'remove-band' })).toHaveLength(0);
  });
});
