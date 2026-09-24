import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { roleConfigs, roleTemplates } from '../../domain/demoData';
import { roleAccessPolicies } from '../../domain/accessPolicy';
import { userSessions } from '../../domain/fixtures/access';
import { ProductHeader, RoleNavigation, RoleTopNavigation } from './appShell';

function navigationLabels(view: ReturnType<typeof create>, className: string) {
  return view.root
    .findAllByType('button')
    .filter((button) => String(button.props.className).includes(className))
    .map((button) => button.props['aria-label']);
}

function nodeText(node: ReturnType<typeof create>['root']): string {
  return node.children
    .map((child) => (typeof child === 'string' ? child : nodeText(child)))
    .join('');
}

describe('finance desktop navigation', () => {
  it('uses the finance surface title without the redundant rail eyebrow and total', () => {
    const finance = create(
      createElement(RoleNavigation, {
        role: 'finance',
        activeSection: 'Оплаты',
        onChangeSection: vi.fn(),
      }),
    );
    const commercial = create(
      createElement(RoleNavigation, {
        role: 'commercial',
        activeSection: 'Входящие заявки',
        onChangeSection: vi.fn(),
      }),
    );

    expect(nodeText(finance.root)).toContain('Финансовый контур');
    expect(nodeText(finance.root)).not.toContain('Рабочая поверхность');
    expect(finance.root.findAllByProps({ className: 'role-nav-total' })).toHaveLength(0);
    expect(nodeText(commercial.root)).toContain('Рабочая поверхность');
    expect(commercial.root.findAllByProps({ className: 'role-nav-total' })).toHaveLength(1);
  });
});

describe('warehouse runtime navigation', () => {
  it('publishes the exact canonical warehouse order without legacy duplicate stock items', () => {
    const config = roleConfigs.find(({ id }) => id === 'warehouse');
    const template = roleTemplates.find(({ role }) => role === 'warehouse');
    const expected = [
      'Приемка',
      'Прием брака',
      'Отгрузка брака',
      'Все рулоны',
      'Выдача',
      'Сырье',
    ];

    for (const sections of [config?.nav, template?.visibleSections]) {
      expect(sections).toEqual(expected);
      expect(sections?.filter((section) => section === 'Все рулоны')).toHaveLength(1);
      expect(sections).not.toContain('Склад рулонов');
      expect(sections).not.toContain('Запасы / резерв');
      expect(sections).not.toContain('Отгрузка');
      expect(sections).not.toContain('Расходники');
      expect(sections).not.toContain('Движения');
    }

    const view = create(
      createElement(RoleTopNavigation, {
        role: 'warehouse',
        activeSection: 'Выдача',
        onChangeSection: vi.fn(),
      }),
    );

    const desktopLabels = navigationLabels(view, 'role-top-nav-item');
    expect(desktopLabels).toEqual(expected);
    expect(desktopLabels.filter((label) => label === 'Все рулоны')).toHaveLength(1);
    expect(desktopLabels.filter((label) => label === 'Выдача')).toHaveLength(1);
    expect(desktopLabels).not.toContain('Склад рулонов');
    expect(desktopLabels).not.toContain('Запасы / резерв');
    expect(desktopLabels).not.toContain('Отгрузка');
    expect(desktopLabels).not.toContain('Расходники');
    expect(desktopLabels).not.toContain('Движения');

    const mobileMore = view.root
      .findAllByType('button')
      .find((button) => String(button.props.className).includes('mobile-section-nav-more'));
    if (!mobileMore) throw new Error('Warehouse mobile navigation must expose its section drawer.');
    act(() => mobileMore.props.onClick());

    const mobileLabels = navigationLabels(view, 'mobile-').filter((label) =>
      expected.includes(label),
    );
    expect([...mobileLabels].sort()).toEqual([...expected].sort());
    expect(mobileLabels.filter((label) => label === 'Все рулоны')).toHaveLength(1);
    expect(mobileLabels.filter((label) => label === 'Выдача')).toHaveLength(1);
    expect(mobileLabels).not.toContain('Склад рулонов');
    expect(mobileLabels).not.toContain('Запасы / резерв');
    expect(mobileLabels).not.toContain('Отгрузка');
  });
});

describe('admin pallet label layout navigation', () => {
  it('exposes the sandbox consistently and keeps it in the mobile system group', () => {
    const section = 'Макет палетного листа';
    const config = roleConfigs.find(({ id }) => id === 'admin');
    const template = roleTemplates.find(({ role }) => role === 'admin');

    expect(config?.nav).toContain(section);
    expect(template?.visibleSections).toContain(section);
    expect(roleAccessPolicies.admin.visibleSections).toContain(section);
    expect(roleAccessPolicies.admin.capabilities).toContain('pallet_label_layout:manage');
    expect(
      Object.entries(roleAccessPolicies)
        .filter(([role]) => role !== 'admin')
        .every(([, policy]) => !policy.capabilities.includes('pallet_label_layout:manage')),
    ).toBe(true);

    const view = create(
      createElement(RoleNavigation, {
        role: 'admin',
        activeSection: 'Доступы',
        onChangeSection: vi.fn(),
      }),
    );
    const desktopItem = view.root.findAllByProps({ 'aria-label': section })[0];
    expect(desktopItem.props.className).toContain('group-system');

    const mobileMore = view.root
      .findAllByType('button')
      .find((button) => String(button.props.className).includes('mobile-section-nav-more'));
    if (!mobileMore) throw new Error('Admin mobile navigation must expose its system drawer.');
    act(() => mobileMore.props.onClick());

    expect(
      view.root
        .findAllByProps({ 'aria-label': section })
        .some((node) => String(node.props.className).includes('mobile-nav-drawer-item')),
    ).toBe(true);
  });
});

describe('account header', () => {
  it('shows the account name once without a duplicated gray role subtitle', () => {
    const view = create(
      createElement(ProductHeader, {
        activeSection: 'Контроль',
        configLabel: 'Директор',
        session: userSessions.director,
        unread: 0,
        pendingAck: 0,
        openPanel: 'none',
        onOpenPanel: vi.fn(),
      }),
    );
    const account = view.root
      .findAllByType('button')
      .find((button) => String(button.props.className).includes('account-button'));
    if (!account) throw new Error('Account button is missing.');

    expect(nodeText(account)).toBe('Директор');
    expect(account.findAllByType('small')).toHaveLength(0);
  });
});
