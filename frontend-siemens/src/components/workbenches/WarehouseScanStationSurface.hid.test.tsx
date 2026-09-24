import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { warehouseWorkObjects } from '../../domain/fixtures/warehouse';
import { WarehouseScanStationSurface } from './WarehouseScanStationSurface';

describe('WarehouseScanStationSurface HID scan submission', () => {
  it('keeps a scanner payload ready for retry when the live scan rejects it', async () => {
    const object = warehouseWorkObjects.find((candidate) => candidate.id === 'WH-2606-049');
    if (!object) throw new Error('WH-2606-049 warehouse HID fixture is missing');
    const onScanPayload = vi.fn(async () => false);
    let renderer!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        <WarehouseScanStationSurface
          objects={[object]}
          activeSection="Приемка"
          selectedObjectId={null}
          onSelectObject={vi.fn()}
          onScanPayload={onScanPayload}
          onWarehouseRefresh={vi.fn()}
        />,
      );
    });

    const input = renderer.root.findByProps({ 'aria-label': 'Сканирование QR' });
    await act(async () => {
      input.props.onChange({ target: { value: 'HID-QR-0001' } });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onScanPayload).toHaveBeenCalledWith('HID-QR-0001');
    expect(renderer.root.findByProps({ 'aria-label': 'Сканирование QR' }).props.value).toBe(
      'HID-QR-0001',
    );
    expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain(
      'Скан не обработан. Проверьте код',
    );
  });
});
