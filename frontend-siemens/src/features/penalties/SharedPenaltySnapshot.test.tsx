import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { PenaltySnapshotRuntime } from '../../api/penalties';
import { RoleNavigation, RoleTopNavigation } from '../../components/shell/appShell';
import { PenaltyManagementSurface } from '../../components/workbenches/directorPenalties';
import { SharedPenaltySnapshot } from './SharedPenaltySnapshot';

const snapshot: PenaltySnapshotRuntime = {
  items: [
    {
      penaltyId: 'penalty-1',
      employeeId: 'operator-1',
      employeeName: 'Илья Ковалёв',
      employeeRole: 'Оператор',
      targetRole: 'operator',
      scopeObjectId: 'Заказ A-101 целиком',
      reason: 'Брак',
      amountLabel: '10,01 ₽',
      author: 'Зав. производства',
      status: 'notified',
      createdAt: '2026-08-08T08:00:00.000Z',
      history: [],
    },
    {
      penaltyId: 'penalty-2',
      employeeId: 'missing-employee',
      employeeName: 'Сотрудник не найден',
      employeeRole: 'Зав. производства',
      targetRole: 'production_lead',
      scopeObjectId: 'без связанного объекта',
      reason: 'Вес',
      amountLabel: '20 ₽',
      author: 'Директор',
      status: 'cancelled',
      createdAt: '2026-08-08T07:00:00.000Z',
      history: [],
    },
  ],
  summary: { totalCount: 2, totalAmountKopecks: 3001, topReason: 'брак' },
};

function text(node: ReturnType<typeof create>['root']): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join(' ');
}

describe('SharedPenaltySnapshot', () => {
  it('renders the server summary and exactly the same two persisted rows', () => {
    const view = create(
      createElement(SharedPenaltySnapshot, {
        snapshot,
        filters: {},
        onFiltersChange: vi.fn(),
        onSelectPenalty: vi.fn(),
      }),
    );
    const output = text(view.root);

    expect(output).toContain('Всего 2');
    expect(output).toContain('Сумма 30,01 ₽');
    expect(output).toContain('Топ причина брак');
    expect(view.root.findAllByProps({ 'data-penalty-row': true })).toHaveLength(2);
    expect(output).toContain('Сотрудник не найден');
    expect(output).toMatch(/Назначен|Уведомлен/);
    expect(output).toContain('Отменен');
  });

  it('exposes a keyboard-scrollable journal with mobile column labels', () => {
    const view = create(
      createElement(SharedPenaltySnapshot, {
        snapshot,
        filters: {},
        onFiltersChange: vi.fn(),
        onSelectPenalty: vi.fn(),
      }),
    );
    const scrollRegion = view.root.findByProps({ className: 'director-table-wrap' });
    const cells = view.root.findAllByProps({ 'data-penalty-row': true })[0]!.findAllByType('td');

    expect(scrollRegion.props).toMatchObject({
      role: 'region',
      'aria-label': 'Прокручиваемый журнал штрафов',
      tabIndex: 0,
    });
    expect(cells.map((cell) => cell.props['data-label'])).toEqual([
      'Штраф',
      'Сотрудник',
      'Роль',
      'Сумма',
      'Статус',
      'Причина',
    ]);
  });

  it('keeps a long persisted penalty ID inside the detail card', () => {
    const longPenaltyId = 'cmsq0wtc300d7qt06ocfs9qn0';
    const view = create(
      createElement(PenaltyManagementSurface, {
        snapshot: {
          ...snapshot,
          items: [{ ...snapshot.items[0]!, penaltyId: longPenaltyId }],
          summary: { totalCount: 1, totalAmountKopecks: 1001, topReason: 'брак' },
        },
        filters: {},
        scopedObjectId: '',
        authorRole: 'director',
        assignmentEmployees: [
          { id: 'operator-1', name: 'Илья Ковалёв', role: 'Оператор' },
        ],
        canCreatePenalty: true,
        allowUpdate: false,
        onFiltersChange: vi.fn(),
        onCreate: vi.fn(),
        onUpdate: vi.fn(),
      }),
    );
    const heading = view.root.findByProps({ className: 'penalty-detail-id' });

    expect(heading.type).toBe('h2');
    expect(heading.props.title).toBe(longPenaltyId);
    expect(text(heading)).toBe(longPenaltyId);
  });

  it('renders controlled filters and returns the next filter to the snapshot owner', () => {
    const onFiltersChange = vi.fn();
    const view = create(
      createElement(SharedPenaltySnapshot, {
        snapshot,
        filters: { targetRole: 'operator', status: 'cancelled' },
        onFiltersChange,
        onSelectPenalty: vi.fn(),
      }),
    );
    const selects = view.root.findAllByType('select');

    act(() => selects[2]?.props.onChange({ currentTarget: { value: 'operator-1' } }));

    expect(selects.map((select) => select.props.value)).toEqual(['operator', 'cancelled', '']);
    expect(onFiltersChange).toHaveBeenCalledWith({
      targetRole: 'operator',
      status: 'cancelled',
      employeeId: 'operator-1',
    });
  });

  it('derives employee filter options from rows and keeps an unknown employee ID selectable', () => {
    const view = create(
      createElement(SharedPenaltySnapshot, {
        snapshot,
        filters: { employeeId: 'missing-employee' },
        onFiltersChange: vi.fn(),
        onSelectPenalty: vi.fn(),
      }),
    );
    const employeeSelect = view.root.findAllByType('select')[2];

    expect(employeeSelect?.props.value).toBe('missing-employee');
    expect(text(employeeSelect!)).toContain('Илья Ковалёв');
    expect(text(employeeSelect!)).toContain('Сотрудник не найден (missing-employee)');
  });

  it('shows the exact empty label with zero summary and no rows', () => {
    const view = create(
      createElement(SharedPenaltySnapshot, {
        snapshot: {
          items: [],
          summary: { totalCount: 0, totalAmountKopecks: 0, topReason: null },
        },
        filters: {},
        onFiltersChange: vi.fn(),
        onSelectPenalty: vi.fn(),
      }),
    );
    const output = text(view.root);

    expect(output).toContain('Штрафов нет');
    expect(output).toContain('Всего 0');
    expect(output).toContain('Сумма 0 ₽');
    expect(view.root.findAllByProps({ 'data-penalty-row': true })).toHaveLength(0);
  });

  it.each(['director', 'production'] as const)(
    'keeps one saved journal and assignment for %s without crossed-out blocks',
    (authorRole) => {
      const view = create(
        createElement(PenaltyManagementSurface, {
          snapshot,
          filters: {},
          scopedObjectId: '',
          authorRole,
          assignmentEmployees: [
            { id: 'operator-1', name: 'Илья Ковалёв', role: 'Оператор' },
          ],
          canCreatePenalty: true,
          allowUpdate: false,
          onFiltersChange: vi.fn(),
          onCreate: vi.fn(),
          onUpdate: vi.fn(),
        }),
      );
      const output = text(view.root);

      expect(output).toContain('Журнал');
      expect(output).toContain('Назначить штраф');
      for (const removed of [
        'источник:',
        'база:',
        'Проверить',
        'Где повторяется',
        'Почему повторяется',
        'Последние события',
      ]) {
        expect(output).not.toContain(removed);
      }
    },
  );

  it('hides assignment controls when effective capabilities deny penalty creation', () => {
    const view = create(
      createElement(PenaltyManagementSurface, {
        snapshot,
        filters: {},
        scopedObjectId: '',
        authorRole: 'director',
        assignmentEmployees: [
          { id: 'operator-1', name: 'Илья Ковалёв', role: 'Оператор' },
        ],
        canCreatePenalty: false,
        allowUpdate: false,
        onFiltersChange: vi.fn(),
        onCreate: vi.fn(),
        onUpdate: vi.fn(),
      }),
    );

    expect(text(view.root)).not.toContain('Назначить штраф');
    expect(view.root.findAllByProps({ className: 'penalty-assign-command-button' })).toHaveLength(0);
  });

  it.each(['director', 'production'] as const)(
    'keeps cancelled and mixed statuses at badge = summary = table parity for %s',
    (role) => {
      const mixed: PenaltySnapshotRuntime = {
        ...snapshot,
        items: [
          { ...snapshot.items[0]!, penaltyId: 'issued', status: 'issued' },
          { ...snapshot.items[0]!, penaltyId: 'disputed', status: 'disputed' },
          { ...snapshot.items[1]!, penaltyId: 'cancelled', status: 'cancelled' },
        ],
        summary: { totalCount: 3, totalAmountKopecks: 5001, topReason: 'брак' },
      };
      const journal = create(
        createElement(SharedPenaltySnapshot, {
          snapshot: mixed,
          filters: {},
          onFiltersChange: vi.fn(),
          onSelectPenalty: vi.fn(),
        }),
      );
      const navigation = create(
        createElement(role === 'director' ? RoleNavigation : RoleTopNavigation, {
          role,
          activeSection: 'Штрафы',
          sectionCounts: { Штрафы: mixed.summary.totalCount },
          onChangeSection: vi.fn(),
        }),
      );
      const penaltyButton = navigation.root
        .findAllByType('button')
        .find((button) => button.props['aria-label'] === 'Штрафы');

      expect(journal.root.findAllByProps({ 'data-penalty-row': true })).toHaveLength(3);
      expect(text(journal.root)).toContain('Всего 3');
      expect(text(journal.root)).toContain('Назначен');
      expect(text(journal.root)).toContain('На проверке');
      expect(text(journal.root)).toContain('Отменен');
      expect(text(penaltyButton!)).toContain('3');
    },
  );

  it('uses one generic injected section count for Director and Production badges', () => {
    const sectionCounts = { Штрафы: snapshot.summary.totalCount };
    const director = create(
      createElement(RoleNavigation, {
        role: 'director',
        activeSection: 'Штрафы',
        sectionCounts,
        onChangeSection: vi.fn(),
      }),
    );
    const production = create(
      createElement(RoleTopNavigation, {
        role: 'production',
        activeSection: 'Штрафы',
        sectionCounts,
        onChangeSection: vi.fn(),
      }),
    );

    for (const view of [director, production]) {
      const penalties = view.root
        .findAllByType('button')
        .find((button) => button.props['aria-label'] === 'Штрафы');
      expect(penalties).toBeDefined();
      expect(text(penalties!)).toContain('2');
    }
  });
});
