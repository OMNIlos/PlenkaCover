import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommercialWorkspace, type CommercialLiveSection } from './CommercialWorkspace';
import type { CommercialOrderSection } from './contracts';

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rawMaterialFetch() {
  return vi.fn((input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : input.toString();
    if (path === '/api/raw-materials/big-bags?page=1&pageSize=25') {
      return Promise.resolve(
        json({
          items: [
            {
              id: 'host-bag-1',
              code: 'BB-HOST-001',
              material: 'ПВД 10803-020',
              batch: 'HOST-77',
              createdAt: '2026-08-08T06:30:00.000Z',
              status: 'available',
              location: { kind: 'warehouse', postCode: null, postName: null },
              operatorName: null,
              currentWeightKg: 249.5,
              totalKopecks: 623_750,
            },
          ],
          page: 1,
          pageSize: 25,
          total: 1,
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${path}`));
  });
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : textContent(child)))
    .join('');
}

function renderRawMaterials({
  onChangeSection = vi.fn<(section: CommercialLiveSection) => void>(),
  onSelectOrder = vi.fn<(orderId: string, section?: CommercialOrderSection) => void>(),
}: {
  onChangeSection?: (section: CommercialLiveSection) => void;
  onSelectOrder?: (orderId: string, section?: CommercialOrderSection) => void;
} = {}) {
  let renderer!: ReactTestRenderer;
  return {
    onChangeSection,
    onSelectOrder,
    mount: async () => {
      await act(async () => {
        renderer = TestRenderer.create(
          <CommercialWorkspace
            activeSection="Сырьё"
            selectedOrderId={null}
            onChangeSection={onChangeSection}
            onSelectOrder={onSelectOrder}
          />,
        );
      });
      return renderer;
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CommercialWorkspace raw-material order navigation', () => {
  it('mounts only the shared business register without legacy risks or Warehouse actions', async () => {
    const fetchMock = rawMaterialFetch();
    vi.stubGlobal('fetch', fetchMock);
    const renderer = await renderRawMaterials().mount();

    const register = renderer.root.findByProps({ 'aria-label': 'Реестр Big-Bag' });
    expect(register.findAllByType('th').map(textContent)).toEqual([
      'Название Big-Bag',
      'Сырьё',
      'Дата создания',
      'Статус',
      'Оператор',
      'Текущий вес',
      'Денежный эквивалент',
    ]);
    const content = textContent(register);
    expect(content).toContain('BB-HOST-001');
    expect(content).toContain('ПВД 10803-020');
    expect(content).toContain('На складе');
    expect(register.findAllByProps({ 'data-label': 'Оператор' }).map(textContent)).toEqual(['—']);
    expect(content).toContain('249,5 кг');
    expect(content).toContain('6 237,50 ₽');
    expect(content).not.toContain('Партия HOST-77');
    expect(content).not.toContain('ПВД первичный');
    expect(textContent(renderer.root)).not.toMatch(
      /Учет и перемещение Big-Bag|Подтвердить сканирование|Печать QR-этикетки|Создать Big-Bag/u,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/raw-materials/big-bags?page=1&pageSize=25',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
