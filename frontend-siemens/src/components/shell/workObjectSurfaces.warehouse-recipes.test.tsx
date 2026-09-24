import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RecipeCatalogItem } from '../../api/materialRecipeCatalog';
import { liveRawMaterialsToWorkObject } from '../../api/warehouse';
import type { MaterialRecipeCatalog } from '../../features/recipes/useMaterialRecipeCatalog';
import { DetailView } from './workObjectSurfaces';

type WarehouseRecipeCatalogFixture = Pick<
  MaterialRecipeCatalog,
  'materials' | 'recipes' | 'status' | 'error' | 'reload' | 'createRecipe'
>;

const createdRecipe: RecipeCatalogItem = {
  id: 'recipe-warehouse-1',
  name: 'Складская смесь',
  version: {
    id: 'recipe-warehouse-version-1',
    version: 1,
    ingredients: [
      {
        rawMaterialDefinitionId: 'material-primary',
        name: 'Первичное',
        shareBasisPoints: 10_000,
      },
    ],
  },
};

function catalog(): WarehouseRecipeCatalogFixture {
  return {
    materials: [{ id: 'material-primary', name: 'Первичное', kind: 'base' }],
    recipes: [createdRecipe],
    status: 'ready',
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    createRecipe: vi.fn().mockResolvedValue(createdRecipe),
  };
}

const liveInventory = liveRawMaterialsToWorkObject([
  {
    id: 'server-stock-1',
    rawMaterialId: 'server-material-1',
    label: 'ПВД с сервера',
    materialKind: 'primary',
    qty: 125,
    actualQty: 125,
    unit: 'кг',
    source: 'warehouse_fact',
    sourceOfTruthStatus: 'актуально',
    updatedAt: '2026-07-17T08:00:00.000Z',
  },
]);

const requiredProps = {
  object: liveInventory,
  templateCatalog: [],
  templateVersions: [],
  onTemplateSelect: vi.fn(),
};

describe('DetailView warehouse recipe boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hides problems and history only on the warehouse raw-material section', () => {
    const rawMaterialHtml = renderToStaticMarkup(
      <DetailView {...requiredProps} role="warehouse" activeSection="Сырье" />,
    );
    const receivingHtml = renderToStaticMarkup(
      <DetailView {...requiredProps} role="warehouse" activeSection="Приемка" />,
    );

    expect(rawMaterialHtml).not.toContain('Проблемы и история');
    expect(receivingHtml).toContain('Проблемы и история');
  });

  it('keeps the reserve landing free of generic status and history chrome', () => {
    const html = renderToStaticMarkup(
      <DetailView {...requiredProps} role="warehouse" activeSection="Запасы / резерв" />,
    );

    expect(html).not.toContain('severity-pill');
    expect(html).not.toContain('В норме');
    expect(html).not.toContain('Проблемы и история');
  });

  it('opens canonical processed stock from view without requiring section in the URL', () => {
    vi.stubGlobal('window', {
      location: { search: '?view=processed' },
      matchMedia: () => ({ matches: false }),
    });

    const html = renderToStaticMarkup(
      <DetailView {...requiredProps} role="warehouse" activeSection="Запасы и сырьё" />,
    );

    expect(html).toContain('Все рулоны временно недоступны');
    expect(html).not.toContain('warehouse-inventory-layout');
  });

  it('keeps recipe creation hidden from warehouse even when the catalog is readable', () => {
    const html = renderToStaticMarkup(
      <DetailView
        {...requiredProps}
        role="warehouse"
        activeSection="Сырье"
        warehouseMaterialRecipeCatalog={catalog()}
        effectiveCapabilities={[]}
      />,
    );

    expect(html).not.toContain('Создать рецептуру');
  });

  it('fails closed without an intentionally supplied catalog contract', () => {
    const html = renderToStaticMarkup(
      <DetailView {...requiredProps} role="warehouse" activeSection="Сырье" />,
    );

    expect(html).not.toContain('Создать рецептуру');
  });

  it('does not expose warehouse recipe creation to another role', () => {
    const html = renderToStaticMarkup(
      <DetailView
        {...requiredProps}
        role="commercial"
        activeSection="Сырье"
        warehouseMaterialRecipeCatalog={catalog()}
      />,
    );

    expect(html).not.toContain('Создать рецептуру');
  });
});
