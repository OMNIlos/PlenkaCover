import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  WarehouseDefectBagSurface,
  warehouseDefectBagModeForSection,
} from './WarehouseDefectBagSurface';

const bag = {
  id: 'defect-bag-1',
  code: 'DEF-cmtqqlje4004pqw07tgb9ptot',
  status: 'ready_for_warehouse' as const,
  defectType: 'secondary' as const,
  weightKg: 12.4,
  operatorName: 'Сергей Волков',
  postCode: 'POST-1',
  postName: 'Станок 1',
  shiftLabel: 'Смена оператора cmrq8e51n0003pe0jwb5id7jl',
  weighedAt: '2026-09-06T15:00:00.000Z',
};

describe('WarehouseDefectBagSurface', () => {
  it.each([
    ['Прием брака', 'receiving'],
    ['Отгрузка брака', 'shipping'],
    ['Приемка', null],
  ] as const)('maps the %s tab to %s', (section, mode) => {
    expect(warehouseDefectBagModeForSection(section)).toBe(mode);
  });

  it('renders a safe receiving queue and a permanent scanner field', () => {
    const html = renderToStaticMarkup(
      <WarehouseDefectBagSurface mode="receiving" bags={[bag]} onScan={vi.fn(async () => true)} />,
    );

    expect(html).toContain('Прием брака');
    expect(html).toContain('1 мешок в очереди');
    expect(html).toContain('Мешок брака 06.09.2026 · POST-1');
    expect(html).toContain('Смена 06.09.2026 · Сергей Волков · POST-1');
    expect(html).toContain('12,4 кг');
    expect(html).toContain('Вторичка');
    expect(html).toContain('Сергей Волков');
    expect(html).toContain('aria-label="QR мешка брака"');
    expect(html).not.toMatch(/rawPayload|qrPayload|bbt_/u);
    expect(html).not.toMatch(/cmtqqlje4004pqw07tgb9ptot|cmrq8e51n0003pe0jwb5id7jl/u);
  });

  it('submits the trimmed scan to the selected warehouse operation', async () => {
    const onScan = vi.fn(async () => true);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseDefectBagSurface mode="shipping" bags={[]} onScan={onScan} />,
      );
    });

    await act(async () => {
      renderer.root.findByProps({ 'aria-label': 'QR мешка брака' }).props.onChange({
        target: { value: '  scanned-defect-qr  ' },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onScan).toHaveBeenCalledWith('scanned-defect-qr');
    expect(renderer.root.findByProps({ 'aria-label': 'QR мешка брака' }).props.value).toBe('');
    expect(renderer.root.findByProps({ role: 'status' }).children).toEqual(['Мешок отгружен.']);
  });
});
