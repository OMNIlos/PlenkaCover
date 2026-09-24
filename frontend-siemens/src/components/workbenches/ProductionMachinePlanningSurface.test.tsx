import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductionMachinePlanningSurface } from './ProductionMachinePlanningSurface';

const assignedShift: ComponentProps<typeof ProductionMachinePlanningSurface>['shifts'][number] = {
  id: 'shift-1',
  label: 'Индивидуальная смена',
  plannedStartAt: null,
  plannedEndAt: null,
  status: 'planned',
  machineAssignments: [
    {
      id: 'assignment-1',
      shiftId: 'shift-1',
      operatorId: 'operator-1',
      postId: 'post-1',
      status: 'locked',
      lockedAt: '2026-07-27T09:00:00.000Z',
    },
  ],
};

const baseProps: Omit<ComponentProps<typeof ProductionMachinePlanningSurface>, 'onCreateShift'> = {
  shifts: [assignedShift],
  posts: [
    {
      id: 'post-1',
      code: 'POST-1',
      name: 'Станок 1',
      status: 'active',
      agentStatus: 'online',
    },
    {
      id: 'post-2',
      code: 'POST-2',
      name: 'Станок 2',
      status: 'active',
      agentStatus: 'online',
    },
  ],
  operators: [
    { id: 'operator-1', displayName: 'Сергей Волков' },
    { id: 'operator-2', displayName: 'Анна Петрова' },
  ],
  busy: false,
  onAssignMachine: vi.fn(),
  onBreakdownReassign: vi.fn(),
  onIntentionalMachineChange: vi.fn(),
};

function renderInteractive(
  onCreateShift: ComponentProps<typeof ProductionMachinePlanningSurface>['onCreateShift'],
  props: Partial<ComponentProps<typeof ProductionMachinePlanningSurface>> = {},
  dialogFocus = vi.fn(),
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <ProductionMachinePlanningSurface {...baseProps} {...props} onCreateShift={onCreateShift} />,
      {
        createNodeMock: (element) =>
          element.props.role === 'dialog' ? { focus: dialogFocus } : null,
      },
    );
  });
  return renderer;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function operatorRow(root: ReactTestInstance, displayName: string) {
  const select = root.findByProps({ 'aria-label': `Станок смены для ${displayName}` });
  const row = select.parent?.parent;
  if (!row) throw new Error(`Operator row for "${displayName}" not found`);
  return row;
}

function nodeText(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType('button')
    .find((candidate) => nodeText(candidate) === label);
  if (!button) throw new Error(`Button "${label}" not found`);
  act(() => button.props.onClick());
}

async function clickAsync(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root
    .findAllByType('button')
    .find((candidate) => nodeText(candidate) === label);
  if (!button) throw new Error(`Button "${label}" not found`);
  await act(async () => {
    await button.props.onClick();
  });
}

function change(renderer: TestRenderer.ReactTestRenderer, ariaLabel: string, value: string) {
  act(() => {
    renderer.root.findByProps({ 'aria-label': ariaLabel }).props.onChange({
      target: { value },
    });
  });
}

function optionLabels(root: ReactTestInstance) {
  return root.findAllByType('option').map(nodeText);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProductionMachinePlanningSurface individual shift workflow', () => {
  it('removes an untouched planned machine by selecting «Без станка»', async () => {
    const onCancelAssignment = vi.fn().mockResolvedValue(true);
    const plannedShift: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        {
          id: 'assignment-planned',
          shiftId: 'shift-1',
          operatorId: 'operator-1',
          postId: 'post-1',
          status: 'planned',
        },
      ],
    };
    const renderer = renderInteractive(vi.fn(), {
      shifts: [plannedShift],
      onCancelAssignment,
    });

    expect(optionLabels(operatorRow(renderer.root, 'Сергей Волков'))).toContain('Без станка');
    change(renderer, 'Станок смены для Сергей Волков', '');
    await clickAsync(renderer, 'Снять станок');

    expect(onCancelAssignment).toHaveBeenCalledWith(
      'shift-1',
      'assignment-planned',
      'Станок снят с оператора',
    );
  });

  it('cancels an untouched planned assignment with the exact shift and assignment ids', async () => {
    const onCancelAssignment = vi.fn().mockResolvedValue(true);
    const plannedShift: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        {
          id: 'assignment-planned',
          shiftId: 'shift-1',
          operatorId: 'operator-1',
          postId: 'post-1',
          status: 'planned',
        },
      ],
    };
    const renderer = renderInteractive(vi.fn(), {
      shifts: [plannedShift],
      onCancelAssignment,
    });

    click(renderer, 'Отменить назначение');
    change(renderer, 'Причина отмены действия', 'Ошибочно выбран оператор');
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Подтвердить безопасную отмену' }).props.onChange({
        currentTarget: { checked: true },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onCancelAssignment).toHaveBeenCalledWith(
      'shift-1',
      'assignment-planned',
      'Ошибочно выбран оператор',
    );
  });

  it('cancels a pending machine change while keeping the current assignment visible', async () => {
    const onCancelMachineChange = vi.fn().mockResolvedValue(true);
    const shiftWithChange: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        {
          ...assignedShift.machineAssignments![0],
          machineChanges: [
            {
              id: 'change-1',
              assignmentId: 'assignment-1',
              shiftId: 'shift-1',
              operatorId: 'operator-1',
              fromPostId: 'post-1',
              toPostId: 'post-2',
              fromPost: { id: 'post-1', code: 'POST-1', name: 'Станок 1' },
              toPost: { id: 'post-2', code: 'POST-2', name: 'Станок 2' },
              needsFinalWeight: false,
              pendingBigBags: [],
              reason: 'Изменился план',
              status: 'ready',
              operationKey: '00000000-0000-4000-8000-000000000901',
              requestedAt: '2026-08-04T10:00:00.000Z',
              readyAt: '2026-08-04T10:01:00.000Z',
              completedAt: null,
              cancelledAt: null,
              updatedAt: '2026-08-04T10:01:00.000Z',
            },
          ],
        },
      ],
    };
    const renderer = renderInteractive(vi.fn(), {
      shifts: [shiftWithChange],
      onCancelMachineChange,
    });

    expect(nodeText(operatorRow(renderer.root, 'Сергей Волков'))).toContain('POST-1 → POST-2');
    click(renderer, 'Отменить смену станка');
    change(renderer, 'Причина отмены действия', 'Переход больше не нужен');
    act(() => {
      renderer.root.findByProps({ 'aria-label': 'Подтвердить безопасную отмену' }).props.onChange({
        currentTarget: { checked: true },
      });
    });
    await act(async () => {
      await renderer.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() });
    });

    expect(onCancelMachineChange).toHaveBeenCalledWith('change-1', 'Переход больше не нужен');
  });

  it('removes the separate shift selector and create-shift form', () => {
    const markup = renderToStaticMarkup(
      <ProductionMachinePlanningSurface {...baseProps} onCreateShift={vi.fn()} />,
    );

    expect(markup).not.toContain('Плановая смена');
    expect(markup).not.toContain('Создать индивидуальную смену');
    expect(markup).not.toContain('Название (необязательно)');
    expect(markup).not.toContain('Создать смену');
    expect(markup).toContain('Станок смены для Анна Петрова');
    expect(markup).toMatch(/<button[^>]*>Назначить<\/button>/u);
  });

  it('creates one individual shift from the selected operator row', async () => {
    const onCreateShift = vi.fn().mockResolvedValue(true);
    const onAssignMachine = vi.fn();
    const renderer = renderInteractive(onCreateShift, { onAssignMachine });

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Станок смены для Анна Петрова' })
        .props.onChange({ target: { value: 'post-2' } });
    });

    const assign = renderer.root.findByProps({ children: 'Назначить' });
    await act(async () => {
      assign.props.onClick();
      assign.props.onClick();
      await Promise.resolve();
    });

    expect(onCreateShift).toHaveBeenCalledTimes(1);
    expect(onCreateShift).toHaveBeenCalledWith({
      operatorId: 'operator-2',
      postId: 'post-2',
    });
    expect(onAssignMachine).not.toHaveBeenCalled();
  });

  it('keeps the operator table available before the first shift exists', () => {
    const markup = renderToStaticMarkup(
      <ProductionMachinePlanningSurface {...baseProps} shifts={[]} onCreateShift={vi.fn()} />,
    );

    expect(markup).toContain('Сергей Волков');
    expect(markup).toContain('Анна Петрова');
    expect(markup).not.toContain('Создайте индивидуальную смену');
  });

  it('keeps the selected post for retry when shift creation is rejected', async () => {
    const pending = deferred<boolean>();
    const onCreateShift = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(true);
    const renderer = renderInteractive(onCreateShift);

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Станок смены для Анна Петрова' })
        .props.onChange({ target: { value: 'post-2' } });
    });

    const assign = operatorRow(renderer.root, 'Анна Петрова').findByType('button');
    act(() => {
      assign.props.onClick();
      assign.props.onClick();
    });
    expect(onCreateShift).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(false);
      await pending.promise;
    });

    expect(
      renderer.root.findByProps({ 'aria-label': 'Станок смены для Анна Петрова' }).props.value,
    ).toBe('post-2');

    await act(async () => {
      await renderer.root.findByProps({ children: 'Назначить' }).props.onClick();
    });
    expect(onCreateShift).toHaveBeenCalledTimes(2);
  });

  it('does not carry a dirty post choice into a different server shift scope', () => {
    const renderer = renderInteractive(vi.fn());

    change(renderer, 'Станок смены для Анна Петрова', 'post-2');
    expect(
      renderer.root.findByProps({ 'aria-label': 'Станок смены для Анна Петрова' }).props.value,
    ).toBe('post-2');

    act(() => {
      renderer.update(
        <ProductionMachinePlanningSurface
          {...baseProps}
          shifts={[
            {
              ...assignedShift,
              id: 'shift-2',
              machineAssignments: [],
            },
          ]}
          onCreateShift={vi.fn()}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ 'aria-label': 'Станок смены для Анна Петрова' }).props.value,
    ).toBe('');
  });

  it('ignores an old assignment completion after the server shift scope changes', async () => {
    const oldPending = deferred<boolean>();
    const newPending = deferred<boolean>();
    const newOnCreateShift = vi.fn().mockReturnValue(newPending.promise);
    const renderer = renderInteractive(vi.fn().mockReturnValue(oldPending.promise));

    change(renderer, 'Станок смены для Анна Петрова', 'post-2');
    act(() => {
      operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
    });

    act(() => {
      renderer.update(
        <ProductionMachinePlanningSurface
          {...baseProps}
          shifts={[
            {
              ...assignedShift,
              id: 'shift-2',
              machineAssignments: [],
            },
          ]}
          onCreateShift={newOnCreateShift}
        />,
      );
    });

    const select = renderer.root.findByProps({
      'aria-label': 'Станок смены для Анна Петрова',
    });
    expect(select.props.value).toBe('');
    expect(select.props.disabled).toBe(false);

    change(renderer, 'Станок смены для Анна Петрова', 'post-1');
    act(() => {
      operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
    });
    expect(newOnCreateShift).toHaveBeenCalledWith({
      operatorId: 'operator-2',
      postId: 'post-1',
    });

    await act(async () => {
      oldPending.resolve(true);
      await oldPending.promise;
    });

    let row = operatorRow(renderer.root, 'Анна Петрова');
    expect(row.findByType('select').props.value).toBe('post-1');
    expect(row.findByType('select').props.disabled).toBe(true);
    expect(row.findByType('button').props.disabled).toBe(true);

    await act(async () => {
      newPending.resolve(false);
      await newPending.promise;
    });

    row = operatorRow(renderer.root, 'Анна Петрова');
    expect(row.findByType('select').props.value).toBe('post-1');
    expect(row.findByType('select').props.disabled).toBe(false);
    expect(row.findByType('button').props.disabled).toBe(false);
  });

  it('locks an accepted row until the refreshed assignment arrives', async () => {
    const onCreateShift = vi.fn().mockResolvedValue(true);
    const renderer = renderInteractive(onCreateShift);

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Станок смены для Анна Петрова' })
        .props.onChange({ target: { value: 'post-2' } });
    });
    await act(async () => {
      await operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
    });

    const row = operatorRow(renderer.root, 'Анна Петрова');
    expect(row.findByType('select').props.disabled).toBe(true);
    expect(row.findByType('button').props.disabled).toBe(true);

    await act(async () => {
      await row.findByType('button').props.onClick();
    });
    expect(onCreateShift).toHaveBeenCalledTimes(1);
  });

  it('offers a post already assigned to another operator for a separate planned shift', async () => {
    const onCreateShift = vi.fn().mockResolvedValue(false);
    const renderer = renderInteractive(onCreateShift);
    const row = operatorRow(renderer.root, 'Анна Петрова');
    const postOption = row
      .findByType('select')
      .findAllByType('option')
      .find((option) => option.props.value === 'post-1');

    expect(postOption?.props.disabled).toBe(false);
    change(renderer, 'Станок смены для Анна Петрова', 'post-1');
    await act(async () => {
      await row.findByType('button').props.onClick();
    });

    expect(onCreateShift).toHaveBeenCalledWith({ operatorId: 'operator-2', postId: 'post-1' });
  });

  it('submits the same post for multiple operators while planning requests overlap', async () => {
    const firstPending = deferred<boolean>();
    const secondPending = deferred<boolean>();
    const onCreateShift = vi
      .fn()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const renderer = renderInteractive(onCreateShift, {
      operators: [...baseProps.operators!, { id: 'operator-3', displayName: 'Иван Соколов' }],
    });

    act(() => {
      renderer.root
        .findByProps({ 'aria-label': 'Станок смены для Анна Петрова' })
        .props.onChange({ target: { value: 'post-2' } });
      renderer.root
        .findByProps({ 'aria-label': 'Станок смены для Иван Соколов' })
        .props.onChange({ target: { value: 'post-2' } });
    });

    act(() => {
      operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
      operatorRow(renderer.root, 'Иван Соколов').findByType('button').props.onClick();
    });
    expect(onCreateShift).toHaveBeenCalledTimes(2);
    expect(onCreateShift).toHaveBeenNthCalledWith(1, {
      operatorId: 'operator-2',
      postId: 'post-2',
    });
    expect(onCreateShift).toHaveBeenNthCalledWith(2, {
      operatorId: 'operator-3',
      postId: 'post-2',
    });

    await act(async () => {
      firstPending.resolve(false);
      secondPending.resolve(false);
      await Promise.all([firstPending.promise, secondPending.promise]);
    });
  });

  it('reoffers a post from a completed assignment', () => {
    const completedShift: typeof assignedShift = {
      ...assignedShift,
      status: 'open',
      machineAssignments: [
        {
          id: 'assignment-completed',
          shiftId: 'shift-1',
          operatorId: 'operator-4',
          postId: 'post-2',
          status: 'completed',
        },
      ],
    };
    const renderer = renderInteractive(vi.fn(), { shifts: [completedShift] });
    const postOption = operatorRow(renderer.root, 'Анна Петрова')
      .findByType('select')
      .findAllByType('option')
      .find((option) => option.props.value === 'post-2');

    expect(postOption?.props.disabled).toBe(false);
  });

  it('labels a changed planned assignment as Переназначить while it is pending', async () => {
    const plannedShift: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        {
          id: 'assignment-2',
          shiftId: 'shift-1',
          operatorId: 'operator-2',
          postId: 'post-2',
          status: 'planned',
        },
      ],
    };
    const onCreateShift = vi.fn();
    const pending = deferred<boolean>();
    const onAssignMachine = vi.fn().mockReturnValue(pending.promise);
    const renderer = renderInteractive(onCreateShift, {
      shifts: [plannedShift],
      posts: [
        ...baseProps.posts,
        {
          id: 'post-3',
          code: 'POST-3',
          name: 'Станок 3',
          status: 'active',
          agentStatus: 'online',
        },
      ],
      onAssignMachine,
    });

    change(renderer, 'Станок смены для Анна Петрова', 'post-3');
    expect(nodeText(operatorRow(renderer.root, 'Анна Петрова'))).toContain('Переназначить');
    act(() => {
      operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
    });

    expect(onAssignMachine).toHaveBeenCalledWith('shift-1', 'operator-2', 'post-3');
    expect(onCreateShift).not.toHaveBeenCalled();
    expect(nodeText(operatorRow(renderer.root, 'Анна Петрова'))).toContain('Переназначаем…');

    await act(async () => {
      pending.resolve(true);
      await pending.promise;
    });
  });

  it('focuses the locked-change dialog, keeps a rejected draft, and lists only a free target', async () => {
    const dialogFocus = vi.fn();
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const onChange = vi.fn().mockResolvedValue(false);
    const occupiedShift: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        ...assignedShift.machineAssignments!,
        {
          id: 'assignment-occupied',
          shiftId: 'shift-1',
          operatorId: 'operator-2',
          postId: 'post-3',
          status: 'locked',
          lockedAt: '2026-07-27T09:05:00.000Z',
        },
      ],
    };
    const renderer = renderInteractive(
      vi.fn(),
      {
        shifts: [occupiedShift],
        posts: [
          ...baseProps.posts,
          {
            id: 'post-3',
            code: 'POST-3',
            name: 'Станок 3',
            status: 'active',
            agentStatus: 'online',
          },
        ],
        onIntentionalMachineChange: onChange,
      },
      dialogFocus,
    );

    click(renderer, 'Смена станка');
    const dialog = renderer.root.findByProps({
      'aria-label': 'Преднамеренная смена станка',
    });
    expect(dialog.props.tabIndex).toBe(-1);
    expect(dialogFocus).toHaveBeenCalledOnce();
    expect(nodeText(dialog)).toContain('Текущий станок: Станок 1 · POST-1');
    expect(nodeText(dialog)).toContain(
      'Оператор сначала завершит вес всех открытых Big-Bag, затем продолжит работу на новом посту.',
    );
    expect(optionLabels(dialog)).toEqual(['Выберите пост', 'Станок 2 · POST-2']);

    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', '  Изменился план выпуска  ');
    await clickAsync(renderer, 'Подтвердить смену станка');

    expect(onChange).toHaveBeenCalledWith('assignment-1', 'post-2', 'Изменился план выпуска');
    expect(renderer.root.findByProps({ 'aria-label': 'Причина смены станка' }).props.value).toBe(
      '  Изменился план выпуска  ',
    );
    expect(
      renderer.root.findByProps({ 'aria-label': 'Преднамеренная смена станка' }),
    ).toBeDefined();
  });

  it('invalidates a stale replacement after polling and retries with a newly free post', async () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const onCreateShift = vi.fn();
    const onChange = vi.fn().mockResolvedValue(true);
    const posts = [
      ...baseProps.posts,
      {
        id: 'post-3',
        code: 'POST-3',
        name: 'Станок 3',
        status: 'active',
        agentStatus: 'online',
      },
    ];
    const initialShift: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        ...assignedShift.machineAssignments!,
        {
          id: 'assignment-occupied',
          shiftId: 'shift-1',
          operatorId: 'operator-2',
          postId: 'post-3',
          status: 'locked',
          lockedAt: '2026-07-27T09:05:00.000Z',
        },
      ],
    };
    const renderer = renderInteractive(onCreateShift, {
      shifts: [initialShift],
      posts,
      onIntentionalMachineChange: onChange,
    });

    click(renderer, 'Смена станка');
    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', 'Изменился план выпуска');
    const retainedSubmit = renderer.root.findByProps({
      children: 'Подтвердить смену станка',
    }).props.onClick;

    const refreshedShift: typeof assignedShift = {
      ...initialShift,
      machineAssignments: initialShift.machineAssignments?.map((assignment) =>
        assignment.id === 'assignment-occupied' ? { ...assignment, postId: 'post-2' } : assignment,
      ),
    };
    act(() => {
      renderer.update(
        <ProductionMachinePlanningSurface
          {...baseProps}
          shifts={[refreshedShift]}
          posts={posts}
          onCreateShift={onCreateShift}
          onIntentionalMachineChange={onChange}
        />,
      );
    });

    const submit = renderer.root.findByProps({ children: 'Подтвердить смену станка' });
    expect(renderer.root.findByProps({ 'aria-label': 'Новый станок / пост' }).props.value).toBe('');
    expect(renderer.root.findByProps({ 'aria-label': 'Причина смены станка' }).props.value).toBe(
      'Изменился план выпуска',
    );
    expect(submit.props.disabled).toBe(true);
    act(() => retainedSubmit());
    expect(onChange).not.toHaveBeenCalled();
    expect(
      optionLabels(renderer.root.findByProps({ 'aria-label': 'Преднамеренная смена станка' })),
    ).toEqual(['Выберите пост', 'Станок 3 · POST-3']);

    change(renderer, 'Новый станок / пост', 'post-3');
    await clickAsync(renderer, 'Подтвердить смену станка');
    expect(onChange).toHaveBeenCalledWith('assignment-1', 'post-3', 'Изменился план выпуска');
  });

  it('neither offers nor submits a post claimed by a committed unrefreshed assignment', async () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const committed = deferred<boolean>();
    const onCreateShift = vi.fn().mockReturnValue(committed.promise);
    const onChange = vi.fn().mockResolvedValue(true);
    const posts = [
      ...baseProps.posts,
      {
        id: 'post-3',
        code: 'POST-3',
        name: 'Станок 3',
        status: 'active' as const,
        agentStatus: 'online' as const,
      },
    ];
    const renderer = renderInteractive(onCreateShift, {
      posts,
      onIntentionalMachineChange: onChange,
    });

    click(renderer, 'Смена станка');
    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', 'Изменился план выпуска');
    const retainedSubmit = renderer.root.findByProps({
      children: 'Подтвердить смену станка',
    }).props.onClick;

    change(renderer, 'Станок смены для Анна Петрова', 'post-2');
    act(() => {
      operatorRow(renderer.root, 'Анна Петрова').findByType('button').props.onClick();
    });
    await act(async () => {
      committed.resolve(true);
      await committed.promise;
    });

    const dialog = renderer.root.findByProps({
      'aria-label': 'Преднамеренная смена станка',
    });
    expect(optionLabels(dialog)).toEqual(['Выберите пост', 'Станок 3 · POST-3']);
    expect(renderer.root.findByProps({ 'aria-label': 'Новый станок / пост' }).props.value).toBe('');
    expect(renderer.root.findByProps({ children: 'Подтвердить смену станка' }).props.disabled).toBe(
      true,
    );

    act(() => retainedSubmit());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects a retained submit handler after the dialog changes assignment', () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const onChange = vi.fn().mockResolvedValue(true);
    const shiftWithTwoAssignments: typeof assignedShift = {
      ...assignedShift,
      machineAssignments: [
        ...assignedShift.machineAssignments!,
        {
          id: 'assignment-2',
          shiftId: 'shift-1',
          operatorId: 'operator-2',
          postId: 'post-3',
          status: 'locked',
          lockedAt: '2026-07-27T09:05:00.000Z',
        },
      ],
    };
    const renderer = renderInteractive(vi.fn(), {
      shifts: [shiftWithTwoAssignments],
      posts: [
        ...baseProps.posts,
        {
          id: 'post-3',
          code: 'POST-3',
          name: 'Станок 3',
          status: 'active',
          agentStatus: 'online',
        },
      ],
      onIntentionalMachineChange: onChange,
    });

    click(renderer, 'Смена станка');
    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', 'Изменился план выпуска');
    const retainedSubmit = renderer.root.findByProps({
      children: 'Подтвердить смену станка',
    }).props.onClick;

    const changeButtons = renderer.root
      .findAllByType('button')
      .filter((button) => nodeText(button) === 'Смена станка');
    act(() => changeButtons[1]?.props.onClick());
    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', 'Изменился план выпуска');
    expect(
      nodeText(renderer.root.findByProps({ 'aria-label': 'Преднамеренная смена станка' })),
    ).toContain('Текущий станок: Станок 3 · POST-3');

    act(() => retainedSubmit());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes and resets the locked-change dialog only after an accepted change', async () => {
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: vi.fn(),
    });
    const onChange = vi.fn().mockResolvedValue(true);
    const renderer = renderInteractive(vi.fn(), { onIntentionalMachineChange: onChange });

    click(renderer, 'Смена станка');
    change(renderer, 'Новый станок / пост', 'post-2');
    change(renderer, 'Причина смены станка', 'Изменился план выпуска');
    await clickAsync(renderer, 'Подтвердить смену станка');

    expect(
      renderer.root.findAllByProps({ 'aria-label': 'Преднамеренная смена станка' }),
    ).toHaveLength(0);

    click(renderer, 'Смена станка');
    expect(renderer.root.findByProps({ 'aria-label': 'Новый станок / пост' }).props.value).toBe('');
    expect(renderer.root.findByProps({ 'aria-label': 'Причина смены станка' }).props.value).toBe(
      '',
    );
  });
});
