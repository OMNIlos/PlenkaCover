import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRawMaterialCatalogItem,
  fetchRawMaterialCatalog,
} from '../../api/materialRecipeCatalog';
import { AdminMaterialTypesSection } from './AdminMaterialTypesSection';

vi.mock('../../api/materialRecipeCatalog', () => ({
  fetchRawMaterialCatalog: vi.fn(),
  createRawMaterialCatalogItem: vi.fn(),
}));

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('AdminMaterialTypesSection', () => {
  beforeEach(() => {
    vi.mocked(fetchRawMaterialCatalog).mockReset();
    vi.mocked(createRawMaterialCatalogItem).mockReset();
  });

  it('adds a material type and explains that both shared dropdowns receive it', async () => {
    vi.mocked(fetchRawMaterialCatalog).mockResolvedValue([
      { id: 'material-aika', name: 'Айка', kind: 'base' },
    ]);
    vi.mocked(createRawMaterialCatalogItem).mockResolvedValue({
      id: 'material-pnd',
      name: 'ПНД гранула',
      kind: 'custom',
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<AdminMaterialTypesSection />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(nodeText(renderer.root)).toContain('Заявка коммерции · Big-Bag');
    act(() =>
      renderer.root.findByType('input').props.onChange({ currentTarget: { value: 'ПНД гранула' } }),
    );
    await act(async () => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(createRawMaterialCatalogItem).toHaveBeenCalledWith('ПНД гранула');
    expect(nodeText(renderer.root)).toContain(
      'Вид сырья «ПНД гранула» добавлен в склад и коммерцию.',
    );
    expect(nodeText(renderer.root)).toContain('Добавлен админом');
  });
});
