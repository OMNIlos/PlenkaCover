import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import type {
  RawMaterialCatalogItem,
  RecipeCatalogItem,
} from '../../api/materialRecipeCatalog';
import { RecipeEditorModal, recipeSaveErrorPresentation } from './RecipeEditorModal';

const materials: RawMaterialCatalogItem[] = [
  { id: 'material-primary', name: 'Первичное', kind: 'base' },
  { id: 'material-secondary', name: 'Вторичное', kind: 'base' },
];

const createdRecipe: RecipeCatalogItem = {
  id: 'recipe-1',
  name: 'Смесь 80/20',
  version: {
    id: 'recipe-version-1',
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

function props(overrides: Partial<React.ComponentProps<typeof RecipeEditorModal>> = {}) {
  return {
    materials,
    catalogStatus: 'ready' as const,
    catalogError: null,
    onRetryCatalog: vi.fn(),
    onSave: vi.fn().mockResolvedValue(createdRecipe),
    onCreated: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const result = root
    .findAllByType('button')
    .find((candidate) => nodeText(candidate) === label);
  if (!result) throw new Error(`Button not found: ${label}`);
  return result;
}

function inputByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('input');
}

function selectByLabel(root: ReactTestInstance, label: string): ReactTestInstance {
  const labelNode = root
    .findAllByType('label')
    .find((candidate) => nodeText(candidate).includes(label));
  if (!labelNode) throw new Error(`Label not found: ${label}`);
  return labelNode.findByType('select');
}

function makeValid(root: ReactTestInstance) {
  act(() => {
    inputByLabel(root, 'Название рецептуры').props.onChange({
      currentTarget: { value: 'Смесь 80/20' },
    });
    selectByLabel(root, 'Сырье').props.onChange({
      currentTarget: { value: 'material-primary' },
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('RecipeEditorModal', () => {
  it('allows recipe components only from the administrator-managed catalog', () => {
    const markup = renderToStaticMarkup(<RecipeEditorModal {...props()} />);

    expect(markup).not.toContain('Новое сырье');
    expect(markup).not.toContain('>Добавить +<');
    expect(markup).toContain('>Добавить продукт +<');
  });

  it('renders the compact reference hierarchy, DOM hooks, autofocus, and exact actions', () => {
    const markup = renderToStaticMarkup(<RecipeEditorModal {...props()} />);

    expect(markup).toContain('class="plenki-modal recipe-editor"');
    expect(markup).toContain('recipe-editor-header');
    expect(markup).toContain('recipe-editor-body');
    expect(markup).toContain('recipe-editor-footer');
    expect(markup).toContain('recipe-editor-ingredient');
    expect(markup).toContain('>Рецептура<');
    expect(markup).toContain('Название рецептуры');
    expect(markup).toContain('autofocus');
    expect(markup).toContain('>Сырье<');
    expect(markup).toContain('inputMode="decimal"');
    expect(markup).toContain('aria-label="Удалить компонент 1"');
    expect(markup).toContain('>Добавить продукт +<');
    expect(markup).toContain('>Отмена<');
    expect(markup).toContain('>Сохранить рецептуру<');
  });

  it('adds, activates, and removes catalog ingredient rows', () => {
    const renderer = TestRenderer.create(<RecipeEditorModal {...props()} />);

    act(() => button(renderer.root, 'Добавить продукт +').props.onClick());
    expect(renderer.root.findAllByProps({ className: 'recipe-editor-ingredient is-active' }))
      .toHaveLength(1);
    expect(renderer.root.findAllByType('select')).toHaveLength(2);

    const firstRow = renderer.root.findAll(
      (node) =>
        node.type === 'div' &&
        String(node.props.className).includes('recipe-editor-ingredient') &&
        node.props['data-ingredient-id'] === 'ingredient-1',
    )[0];
    act(() => firstRow.props.onClick());
    act(() => button(renderer.root, 'Удалить компонент 1').props.onClick());
    expect(renderer.root.findAllByProps({ 'data-ingredient-id': 'ingredient-1' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-ingredient-id': 'ingredient-2' })).not.toHaveLength(0);
  });

  it('shows inline validation only after submit and blocks an invalid total', () => {
    const onSave = vi.fn();
    const renderer = TestRenderer.create(
      <RecipeEditorModal {...props({ onSave })} />,
    );

    expect(renderer.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    act(() => {
      inputByLabel(renderer.root, 'Название рецептуры').props.onChange({
        currentTarget: { value: 'Смесь' },
      });
      selectByLabel(renderer.root, 'Сырье').props.onChange({
        currentTarget: { value: 'material-primary' },
      });
      inputByLabel(renderer.root, '%').props.onChange({
        currentTarget: { value: '99.99' },
      });
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
    });

    expect(onSave).not.toHaveBeenCalled();
    expect(nodeText(renderer.root)).toContain('Сумма долей должна быть ровно 100%.');
  });

  it('locks synchronous double-submit before awaiting and disables draft mutations', async () => {
    const pending = deferred<RecipeCatalogItem>();
    const onSave = vi.fn(() => pending.promise);
    const renderer = TestRenderer.create(
      <RecipeEditorModal {...props({ onSave })} />,
    );
    makeValid(renderer.root);
    const save = button(renderer.root, 'Сохранить рецептуру');

    act(() => {
      save.props.onClick();
      save.props.onClick();
    });

    expect(onSave).toHaveBeenCalledOnce();
    expect(button(renderer.root, 'Сохранение…').props.disabled).toBe(true);
    expect(button(renderer.root, 'Добавить продукт +').props.disabled).toBe(true);

    await act(async () => {
      pending.resolve(createdRecipe);
      await pending.promise;
    });
  });

  it('preserves every field after rejection and retries without exposing backend English', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('internal database exploded'))
      .mockResolvedValueOnce(createdRecipe);
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const renderer = TestRenderer.create(
      <RecipeEditorModal {...props({ onSave, onCreated, onClose })} />,
    );
    makeValid(renderer.root);
    act(() => button(renderer.root, 'Добавить продукт +').props.onClick());
    act(() => {
      renderer.root.findAllByType('select')[1].props.onChange({
        currentTarget: { value: 'material-secondary' },
      });
      const percentageInputs = renderer.root
        .findAllByType('input')
        .filter((input) => input.props.inputMode === 'decimal');
      percentageInputs[0].props.onChange({ currentTarget: { value: '80' } });
      percentageInputs[1].props.onChange({ currentTarget: { value: '20' } });
    });

    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nodeText(renderer.root)).toContain(
      'Не удалось сохранить рецептуру. Проверьте соединение и повторите.',
    );
    expect(nodeText(renderer.root)).not.toContain('internal database exploded');
    expect(inputByLabel(renderer.root, 'Название рецептуры').props.value).toBe('Смесь 80/20');
    expect(renderer.root.findAllByType('select')).toHaveLength(2);

    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith(createdRecipe);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('calls onCreated before onClose after successful save', async () => {
    const order: string[] = [];
    const renderer = TestRenderer.create(
      <RecipeEditorModal
        {...props({
          onCreated: vi.fn(() => order.push('created')),
          onClose: vi.fn(() => order.push('closed')),
        })}
      />,
    );
    makeValid(renderer.root);

    await act(async () => {
      button(renderer.root, 'Сохранить рецептуру').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(order).toEqual(['created', 'closed']);
  });

  it('offers catalog retry both initially and while retaining usable options', () => {
    const initialRetry = vi.fn();
    const initial = TestRenderer.create(
      <RecipeEditorModal
        {...props({
          materials: [],
          catalogStatus: 'error',
          catalogError: 'Failed to fetch',
          onRetryCatalog: initialRetry,
        })}
      />,
    );
    expect(nodeText(initial.root)).toContain('Каталог сырья недоступен.');
    act(() => button(initial.root, 'Повторить').props.onClick());
    expect(initialRetry).toHaveBeenCalledOnce();

    const retainedRetry = vi.fn();
    const retained = TestRenderer.create(
      <RecipeEditorModal
        {...props({
          catalogStatus: 'error',
          catalogError: 'Failed to fetch',
          onRetryCatalog: retainedRetry,
        })}
      />,
    );
    expect(
      retained.root.findAllByType('option').map((option) => nodeText(option)),
    ).toContain('Первичное');
    expect(nodeText(retained.root)).toContain('Не удалось обновить каталог сырья.');
    act(() => button(retained.root, 'Повторить').props.onClick());
    expect(retainedRetry).toHaveBeenCalledOnce();
  });

  it('keeps the draft through catalog changes and retains a disappeared selection as unavailable', () => {
    const componentProps = props();
    const renderer = TestRenderer.create(<RecipeEditorModal {...componentProps} />);
    makeValid(renderer.root);

    act(() => {
      renderer.update(
        <RecipeEditorModal
          {...componentProps}
          materials={[]}
          catalogStatus="ready"
        />,
      );
    });

    expect(inputByLabel(renderer.root, 'Название рецептуры').props.value).toBe('Смесь 80/20');
    const unavailable = renderer.root
      .findAllByType('option')
      .find((option) => option.props.value === 'material-primary');
    expect(unavailable?.props.disabled).toBe(true);
    expect(nodeText(unavailable!)).toContain('Первичное');
    expect(nodeText(unavailable!)).toContain('недоступно');
    expect(nodeText(renderer.root)).toContain('Выбранное сырье больше недоступно.');
  });

  it('maps known API codes to safe field messages', () => {
    expect(
      recipeSaveErrorPresentation(
        new ApiError(409, 'duplicate key value violates unique constraint', 'RECIPE_NAME_CONFLICT'),
      ),
    ).toEqual({
      field: 'name',
      message: 'Рецептура с таким названием уже существует.',
    });
    expect(
      recipeSaveErrorPresentation(
        new ApiError(409, 'raw conflict', 'RAW_MATERIAL_NAME_CONFLICT'),
      ),
    ).toEqual({
      field: 'form',
      message: 'Каталог сырья изменился. Обновите его и повторите сохранение.',
    });
    expect(
      recipeSaveErrorPresentation(
        new ApiError(
          409,
          'definition unavailable',
          'RAW_MATERIAL_DEFINITION_UNAVAILABLE',
        ),
      ),
    ).toEqual({
      field: 'material',
      message: 'Сырье больше недоступно. Обновите каталог и выберите другое.',
    });
    expect(
      recipeSaveErrorPresentation(
        new ApiError(409, 'catalog race', 'RECIPE_CATALOG_CONFLICT'),
      ),
    ).toEqual({
      field: 'form',
      message: 'Каталог изменился. Проверьте состав и повторите сохранение.',
    });
    expect(
      recipeSaveErrorPresentation(
        new ApiError(400, 'bad dto', 'INVALID_RECIPE_CATALOG_REQUEST'),
      ),
    ).toEqual({
      field: 'form',
      message: 'Проверьте название, сырье и сумму долей.',
    });
  });
});
