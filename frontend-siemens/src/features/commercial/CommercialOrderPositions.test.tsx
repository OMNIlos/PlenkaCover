import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CommercialOrderPositions } from './CommercialOrderPositions';
import type { CommercialOrderPositionContract } from './contracts';

const position: CommercialOrderPositionContract = {
  id: 'position-1',
  version: 4,
  rollCount: 2,
  filmType: 'Рукав',
  actualThickness: '80',
  accountingThickness: '78',
  widthMm: 1600,
  plannedLengthM: 250,
  rawMaterialId: null,
  baseRawMaterialDefinitionId: 'material-primary',
  recipeDefinitionVersionId: null,
  recipe: {
    recipeDefinitionId: null,
    recipeDefinitionVersionId: null,
    recipeVersionNumber: null,
    recipeName: 'Первичное',
    ingredients: [
      {
        rawMaterialDefinitionId: 'material-primary',
        name: 'Первичное',
        shareBasisPoints: 10_000,
      },
    ],
  },
  spoolType: 'Тонкая',
  birka: 'ГОСТ',
  manualBirka: 'Старая маркировка',
  comment: 'Срочно',
  plannedWeightKg: 42.3,
  warehouseCoverStatus: 'not_checked',
  coveredQty: 0,
  productionQty: 2,
  fulfilledQty: 0,
  blockingReasons: ['cover_unresolved'],
  coverProposals: [],
};

function button(root: ReactTestInstance, label: string) {
  return root.findAllByType('button').find((candidate) => candidate.children.join('') === label);
}

function input(root: ReactTestInstance, label: string) {
  return root.findAllByType('input').find((candidate) => candidate.props['aria-label'] === label);
}

function select(root: ReactTestInstance, label: string) {
  return root.findAllByType('select').find((candidate) => candidate.props['aria-label'] === label);
}

describe('CommercialOrderPositions', () => {
  it('keeps a user-provided amendment reason for the audit trail', async () => {
    const onAmend = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[position]}
          editable={false}
          amendable
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          onAmend={onAmend}
        />,
      );
    });

    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    expect(input(renderer.root, 'Ширина, мм')?.props.value).toBe('1600');
    expect(input(renderer.root, 'Метраж, м')?.props.value).toBe('250');
    expect(input(renderer.root, 'Ручная бирка')?.props.value).toBe('Старая маркировка');

    act(() => {
      renderer.root
        .findAllByType('textarea')
        .find((candidate) => candidate.props['aria-label'] === 'Причина изменения')
        ?.props.onChange({
          currentTarget: { value: 'Клиент уточнил параметры' },
        });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });
    expect(onAmend).toHaveBeenCalledWith(
      'position-1',
      expect.objectContaining({
        expectedVersion: 4,
        widthMm: 1600,
        plannedLengthM: 250,
        manualBirka: 'Старая маркировка',
      }),
      'Клиент уточнил параметры',
    );
  });

  it('saves a governed amendment without requiring a user comment', async () => {
    const onAmend = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[{ ...position, comment: null }]}
          editable={false}
          amendable
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          onAmend={onAmend}
        />,
      );
    });

    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    act(() => {
      input(renderer.root, 'Ширина, мм')?.props.onChange({
        currentTarget: { value: '1650' },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onAmend).toHaveBeenCalledWith(
      'position-1',
      expect.objectContaining({
        widthMm: 1650,
        comment: '',
      }),
      'Параметры заявки изменены коммерцией',
    );
  });

  it('preserves a legacy material assignment when editing another parameter', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[
            {
              ...position,
              rawMaterialId: 'legacy-material',
              baseRawMaterialDefinitionId: null,
              recipeDefinitionVersionId: null,
            },
          ]}
          editable
          onUpdate={onUpdate}
        />,
      );
    });

    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    act(() => {
      input(renderer.root, 'Метраж, м')?.props.onChange({
        currentTarget: { value: '300' },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onUpdate).toHaveBeenCalledOnce();
    const [, command] = onUpdate.mock.calls[0];
    expect(command).toEqual(
      expect.objectContaining({
        plannedLengthM: 300,
      }),
    );
    expect(command).not.toHaveProperty('baseRawMaterialDefinitionId');
    expect(command).not.toHaveProperty('recipeDefinitionVersionId');
  });

  it('adds a fully specified position after invoice handoff', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[position]}
          editable={false}
          amendable
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          onAdd={onAdd}
        />,
      );
    });

    act(() => button(renderer.root, 'Добавить позицию')?.props.onClick());
    expect(input(renderer.root, 'Новая позиция — ширина, мм')?.props.value).toBe('1600');
    expect(input(renderer.root, 'Новая позиция — метраж, м')?.props.value).toBe('250');
    expect(input(renderer.root, 'Новая позиция — плановый вес, кг')?.props).toMatchObject({
      min: '0.001',
      max: '100000',
      step: '0.001',
    });
    act(() => {
      renderer.root
        .findAllByType('textarea')
        .find((candidate) => candidate.props['aria-label'] === 'Причина добавления позиции')
        ?.props.onChange({
          currentTarget: { value: 'Добавлен второй формат по просьбе клиента' },
        });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        rollCount: 1,
        widthMm: 1600,
        plannedLengthM: 250,
        birka: 'ГОСТ',
        manualBirka: 'Старая маркировка',
        baseRawMaterialDefinitionId: 'material-primary',
      }),
      'Добавлен второй формат по просьбе клиента',
    );
  });

  it('edits an unlocked position and submits an optimistic-lock command', async () => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[position]}
          editable
          materials={[
            { id: 'material-primary', name: 'Первичное', kind: 'base' },
            { id: 'material-admin', name: 'ПНД гранула', kind: 'custom' },
          ]}
          recipes={[
            {
              id: 'recipe-blue',
              name: 'Синяя рецептура',
              version: {
                id: 'recipe-blue-v2',
                version: 2,
                ingredients: [
                  {
                    rawMaterialDefinitionId: 'material-primary',
                    name: 'Первичное',
                    shareBasisPoints: 10_000,
                  },
                ],
              },
            },
          ]}
          onUpdate={onUpdate}
        />,
      );
    });

    expect(button(renderer.root, 'Изменить параметры')).toBeTruthy();
    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    expect(
      select(renderer.root, 'Сырьё / рецептура')
        ?.findAllByType('option')
        .some((option) => option.children.join('') === 'ПНД гранула'),
    ).toBe(true);

    act(() => {
      input(renderer.root, 'Количество рулонов')?.props.onChange({
        currentTarget: { value: '3' },
      });
      input(renderer.root, 'Тип плёнки')?.props.onChange({
        currentTarget: { value: 'Полотно' },
      });
      input(renderer.root, 'Ширина, мм')?.props.onChange({
        currentTarget: { value: '1700' },
      });
      input(renderer.root, 'Метраж, м')?.props.onChange({
        currentTarget: { value: '275' },
      });
      input(renderer.root, 'Ручная бирка')?.props.onChange({
        currentTarget: { value: 'Маркировка А-17' },
      });
      select(renderer.root, 'Сырьё / рецептура')?.props.onChange({
        currentTarget: { value: 'recipe:recipe-blue-v2' },
      });
    });

    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onUpdate).toHaveBeenCalledWith('position-1', {
      expectedVersion: 4,
      rollCount: 3,
      filmType: 'Полотно',
      actualThickness: '80',
      accountingThickness: '78',
      widthMm: 1700,
      plannedLengthM: 275,
      baseRawMaterialDefinitionId: null,
      recipeDefinitionVersionId: 'recipe-blue-v2',
      plannedWeightKg: 42.3,
      spoolType: 'Тонкая',
      birka: 'ГОСТ',
      manualBirka: 'Маркировка А-17',
      comment: 'Срочно',
    });
    expect(button(renderer.root, 'Изменить параметры')).toBeTruthy();
  });

  it.each([
    ['38', 38],
    ['37.5', 37.5],
    ['37,001', 37.001],
  ])('accepts exact planned weight %s', async (value, expected) => {
    const onUpdate = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[position]}
          editable
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          onUpdate={onUpdate}
        />,
      );
    });
    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    act(() => {
      input(renderer.root, 'Плановый вес, кг')?.props.onChange({
        currentTarget: { value },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onUpdate).toHaveBeenCalledWith(
      'position-1',
      expect.objectContaining({ plannedWeightKg: expected }),
    );

    act(() => {
      renderer.update(
        <CommercialOrderPositions
          positions={[{ ...position, plannedWeightKg: expected }]}
          editable
          materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
          onUpdate={onUpdate}
        />,
      );
    });
    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    expect(input(renderer.root, 'Плановый вес, кг')?.props).toMatchObject({
      type: 'text',
      inputMode: 'decimal',
      min: '0.001',
      max: '100000',
      step: '0.001',
      value: String(expected),
    });
  });

  it.each(['0', '-1', '37.0001', '100000.001'])(
    'rejects planned weight %s with the exact message',
    async (value) => {
      const onUpdate = vi.fn().mockResolvedValue(true);
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <CommercialOrderPositions
            positions={[position]}
            editable
            materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
            onUpdate={onUpdate}
          />,
        );
      });
      act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
      act(() => {
        input(renderer.root, 'Плановый вес, кг')?.props.onChange({
          currentTarget: { value },
        });
      });
      await act(async () => {
        await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      });

      expect(onUpdate).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain(
        'Введите вес от 0,001 до 100 000 кг, не более трёх знаков после запятой.',
      );
    },
  );

  it.each(['0', '-1', 'not-a-number'])(
    'rejects an invalid width %s without calling the mutation',
    async (widthMm) => {
      const onUpdate = vi.fn().mockResolvedValue(true);
      let renderer!: TestRenderer.ReactTestRenderer;
      act(() => {
        renderer = TestRenderer.create(
          <CommercialOrderPositions
            positions={[position]}
            editable
            materials={[{ id: 'material-primary', name: 'Первичное', kind: 'base' }]}
            onUpdate={onUpdate}
          />,
        );
      });
      act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
      act(() => {
        input(renderer.root, 'Ширина, мм')?.props.onChange({
          currentTarget: { value: widthMm },
        });
      });

      await act(async () => {
        await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
      });

      expect(onUpdate).not.toHaveBeenCalled();
      expect(renderer.root.findByProps({ role: 'alert' }).children.join('')).toContain(
        'Укажите ширину и метраж больше нуля.',
      );
    },
  );

  it('shows the invoice boundary and no mutation controls for a locked order', () => {
    const markup = TestRenderer.create(
      <CommercialOrderPositions
        positions={[position]}
        editable={false}
        amendable={false}
        lockReason="invoice_issued"
        onAmend={vi.fn()}
        onAdd={vi.fn()}
      />,
    );

    expect(button(markup.root, 'Изменить параметры')).toBeUndefined();
    expect(button(markup.root, 'Добавить позицию')).toBeUndefined();
    expect(
      markup.root
        .findAllByType('span')
        .some(
          (candidate) =>
            candidate.children.join('') === 'Параметры закрыты после выставления счёта',
        ),
    ).toBe(true);
  });

  it('closes an open editor when refreshed data reports an invoice lock', () => {
    const onAmend = vi.fn().mockResolvedValue(true);
    let renderer!: TestRenderer.ReactTestRenderer;

    act(() => {
      renderer = TestRenderer.create(
        <CommercialOrderPositions
          positions={[position]}
          editable={false}
          amendable
          lockReason={null}
          onAmend={onAmend}
        />,
      );
    });
    act(() => button(renderer.root, 'Изменить параметры')?.props.onClick());
    expect(renderer.root.findAllByType('form')).toHaveLength(1);

    act(() => {
      renderer.update(
        <CommercialOrderPositions
          positions={[position]}
          editable={false}
          amendable={false}
          lockReason="invoice_issued"
          onAmend={onAmend}
        />,
      );
    });

    expect(renderer.root.findAllByType('form')).toHaveLength(0);
    expect(button(renderer.root, 'Изменить параметры')).toBeUndefined();
  });
});
