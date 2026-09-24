import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminDevice, AdminIncident, AdminPost } from '../../api/admin';
import type { AdminLiveResources } from '../../domain/adminLiveState';
import { AdminLiveControlPlane, visibleAdminIncidents } from './AdminLiveControlPlane';

const source = readFileSync(new URL('./AdminLiveControlPlane.tsx', import.meta.url), 'utf8');

const mocks = vi.hoisted(() => ({
  loadAdminLiveResources: vi.fn(),
  applyAdminRoleTemplate: vi.fn(),
}));

vi.mock('../../domain/adminLiveState', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../domain/adminLiveState')>();
  return { ...actual, loadAdminLiveResources: mocks.loadAdminLiveResources };
});

vi.mock('../../api/admin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/admin')>();
  return { ...actual, applyAdminRoleTemplate: mocks.applyAdminRoleTemplate };
});

function incident(id: string, status: AdminIncident['status']): AdminIncident {
  return {
    id,
    fingerprint: `fingerprint:${id}`,
    scope: 'gateway',
    targetType: 'post',
    targetId: 'post-1',
    severity: 'warning',
    status,
    title: id,
    message: `message:${id}`,
    recovery: 'Проверить пост.',
    detectedAt: '2026-07-24T10:00:00.000Z',
    lastSeenAt: '2026-07-24T10:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: status === 'resolved' ? '2026-07-24T10:05:00.000Z' : null,
  };
}

function resources(incidents: AdminIncident[]): AdminLiveResources {
  return {
    users: { items: [], page: 1, pageSize: 100, total: 0 },
    roleTemplates: [],
    devices: [],
    posts: [],
    oneC: { connection: null, latestBySubject: [], journals: [], counts: {} },
    snapshots: { items: [], page: 1, pageSize: 100, total: 0 },
    platformHealth: { status: 'ready', incidents: [] },
    incidents,
    accessEvents: { items: [], page: 1, pageSize: 100, total: 0 },
    capabilities: [
      {
        key: 'production_order:read',
        label: 'Просмотр заказ-нарядов',
        description: 'Просматривать безопасные производственные данные.',
        group: 'Производство',
        baseRoles: ['production_lead'],
        grantable: true,
      },
      {
        key: 'recipe_catalog:create',
        label: 'Создание рецептур',
        description: 'Создавать версии рецептур в общем каталоге.',
        group: 'Коммерция',
        baseRoles: ['commercial'],
        grantable: true,
      },
    ],
    errors: {},
  } as AdminLiveResources;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

describe('administrator notification incident selection', () => {
  beforeEach(() => {
    mocks.loadAdminLiveResources.mockReset();
    mocks.applyAdminRoleTemplate.mockReset();
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('forces an exact resolved notification target into a filtered incident table once', () => {
    const open = incident('incident-open', 'open');
    const resolved = incident('incident-resolved', 'resolved');

    expect(visibleAdminIncidents([open, resolved], 'open', resolved.id)).toEqual([resolved, open]);
    expect(
      visibleAdminIncidents([open, resolved], 'all', resolved.id).filter(
        (item) => item.id === resolved.id,
      ),
    ).toHaveLength(1);
  });

  it('omits incidents from the disabled accounting integration', () => {
    const regular = incident('incident-post', 'open');
    const disabledIntegration = {
      ...incident('incident-accounting-source', 'open'),
      scope: 'onec',
      title: '1С недоступна',
      message: 'OneC sync failed',
    };

    expect(visibleAdminIncidents([regular, disabledIntegration], 'all', null)).toEqual([regular]);
  });

  it('renders and focuses a stable exact incident marker without decorative smooth scrolling', () => {
    expect(source).toContain('data-incident-id={incident.id}');
    expect(source).toContain('selectedIncidentRef.current?.focus({ preventScroll: true })');
    expect(source).toContain("selectedIncidentRef.current?.scrollIntoView({ block: 'nearest' })");
    expect(source).not.toContain("behavior: 'smooth'");
  });

  it('refreshes a newly selected missing incident and ignores an older navigation response', async () => {
    const initial = incident('incident-initial', 'open');
    const stale = incident('incident-stale', 'open');
    const fresh = incident('incident-fresh', 'resolved');
    const staleRefresh = deferred<AdminLiveResources>();
    const freshRefresh = deferred<AdminLiveResources>();
    const focusedNodes = new Map<
      string,
      { focus: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> }
    >();
    mocks.loadAdminLiveResources
      .mockResolvedValueOnce(resources([initial]))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockReturnValueOnce(freshRefresh.promise);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AdminLiveControlPlane, {
          section: 'Инциденты',
          selectedIncidentId: null,
        }),
        {
          createNodeMock: (element) => {
            const id = element.props['data-incident-id'] as string | undefined;
            if (!id) return {};
            const node = { focus: vi.fn(), scrollIntoView: vi.fn() };
            focusedNodes.set(id, node);
            return node;
          },
        },
      );
      await flushPromises();
    });
    expect(mocks.loadAdminLiveResources).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(
        createElement(AdminLiveControlPlane, {
          section: 'Инциденты',
          selectedIncidentId: stale.id,
        }),
      );
      await flushPromises();
    });
    await act(async () => {
      renderer.update(
        createElement(AdminLiveControlPlane, {
          section: 'Инциденты',
          selectedIncidentId: fresh.id,
        }),
      );
      await flushPromises();
    });
    expect(mocks.loadAdminLiveResources).toHaveBeenCalledTimes(3);

    await act(async () => {
      freshRefresh.resolve(resources([initial, fresh]));
      await flushPromises();
    });
    expect(renderer.root.findByProps({ 'data-incident-id': fresh.id })).toBeDefined();
    expect(focusedNodes.get(fresh.id)?.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusedNodes.get(fresh.id)?.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
    });

    await act(async () => {
      staleRefresh.resolve(resources([initial, stale]));
      await flushPromises();
    });
    expect(renderer.root.findAllByProps({ 'data-incident-id': stale.id })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-incident-id': fresh.id })).toBeDefined();
    expect(mocks.loadAdminLiveResources).toHaveBeenCalledTimes(3);
    renderer.unmount();
  });

  it('attempts one safe refresh when the selected incident remains unavailable', async () => {
    const missing = incident('incident-missing', 'open');
    mocks.loadAdminLiveResources
      .mockResolvedValueOnce(resources([]))
      .mockResolvedValueOnce(resources([]));

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AdminLiveControlPlane, {
          section: 'Инциденты',
          selectedIncidentId: missing.id,
        }),
      );
      await flushPromises();
      await flushPromises();
    });

    expect(mocks.loadAdminLiveResources).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ 'data-incident-id': missing.id })).toHaveLength(0);
    renderer.unmount();
  });
});

describe('administrator capability catalog controls', () => {
  beforeEach(() => {
    mocks.loadAdminLiveResources.mockReset();
    mocks.applyAdminRoleTemplate.mockReset();
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses searchable Russian capability choices and blocks grant-denial conflicts', async () => {
    mocks.loadAdminLiveResources.mockResolvedValue(resources([]));
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AdminLiveControlPlane, { section: 'Шаблоны ролей' }),
      );
      await flushPromises();
    });

    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Добавить шаблон'))
        ?.props.onClick();
    });

    const grantSearch = renderer.root.findByProps({
      'aria-label': 'Поиск дополнительных разрешений',
    });
    await act(async () => {
      grantSearch.props.onChange({ target: { value: 'рецептур' } });
    });
    expect(
      renderer.root.findAllByProps({
        'data-capability-key': 'production_order:read',
        'data-capability-mode': 'grant',
      }),
    ).toHaveLength(0);
    expect(renderedControlText(renderer)).toContain('Создание рецептур');

    const grant = renderer.root.findByProps({
      'data-capability-key': 'recipe_catalog:create',
      'data-capability-mode': 'grant',
    });
    const denial = renderer.root.findByProps({
      'data-capability-key': 'recipe_catalog:create',
      'data-capability-mode': 'denial',
    });
    await act(async () => {
      grant.props.onChange();
      denial.props.onChange();
    });

    expect(renderedControlText(renderer)).toContain('Одно право выбрано одновременно');
    const save = renderer.root
      .findAllByType('button')
      .find((button) => button.children.includes('Создать шаблон'));
    expect(save?.props.disabled).toBe(true);
    expect(
      renderer.root
        .findAllByType('textarea')
        .some((textarea) => textarea.props['aria-label']?.includes('capabilit')),
    ).toBe(false);
    renderer.unmount();
  });

  it('applies an existing role template through the audited server action', async () => {
    const state = resources([]);
    state.users.items = [
      {
        id: 'user-1',
        externalId: null,
        login: 'operator.1',
        displayName: 'Оператор 1',
        role: 'operator',
        status: 'active',
        mustChangePassword: false,
        passwordChangedAt: null,
        lastLoginAt: null,
        createdAt: '2026-07-27T01:00:00.000Z',
        updatedAt: '2026-07-27T01:00:00.000Z',
        capabilities: [],
        grants: [],
        denials: [],
        activeSessionCount: 1,
      },
    ];
    state.roleTemplates = [
      {
        id: 'template-1',
        name: 'Оператор линии',
        role: 'operator',
        setupStatus: 'active',
        capabilityGrants: [],
        capabilityDenials: [],
        version: 1,
        isSystem: true,
        createdAt: '2026-07-27T01:00:00.000Z',
        updatedAt: '2026-07-27T01:00:00.000Z',
      },
    ];
    mocks.loadAdminLiveResources.mockResolvedValue(state);
    mocks.applyAdminRoleTemplate.mockResolvedValue(state.users.items[0]);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(createElement(AdminLiveControlPlane, { section: 'Доступы' }));
      await flushPromises();
    });
    await act(async () => {
      renderer.root
        .findAllByType('button')
        .find((button) => button.children.includes('Права'))
        ?.props.onClick();
    });
    await act(async () => {
      renderer.root
        .findByProps({ 'aria-label': 'Причина применения шаблона' })
        .props.onChange({ target: { value: 'Назначение на линию' } });
    });
    await act(async () => {
      renderer.root.findByProps({ 'data-admin-apply-template': true }).props.onClick();
      await flushPromises();
    });

    expect(mocks.applyAdminRoleTemplate).toHaveBeenCalledWith('user-1', {
      templateId: 'template-1',
      reason: 'Назначение на линию',
    });
    renderer.unmount();
  });
});

describe('administrator physical readiness matrix', () => {
  beforeEach(() => {
    mocks.loadAdminLiveResources.mockReset();
    mocks.applyAdminRoleTemplate.mockReset();
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
      requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function physicalResources() {
    const state = resources([]);
    const lastSeenAt = new Date(Date.now() - 30_000).toISOString();
    const device: AdminDevice = {
      id: 'scale-1',
      code: 'SCALE-1',
      label: 'Весы станка 1',
      kind: 'scale',
      connectionKind: 'usb-rs232',
      driverName: 'massa-k-protocol-100',
      driverVersion: '1',
      isEnabled: true,
      status: 'ready',
      ownerRole: 'admin',
      lastSeenAt,
      lastProbeAt: lastSeenAt,
      lastTestAt: null,
      parsedPayload: null,
      recovery: null,
      postId: 'post-1',
      post: null,
      createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: lastSeenAt,
    };
    const post: AdminPost = {
      id: 'post-1',
      code: 'POST-1',
      name: 'Станок 1',
      status: 'active',
      commissioningState: 'commissioned',
      commissionedAt: '2026-08-04T08:30:00.000Z',
      agentStatus: 'online',
      lastSeenAt,
      agentProtocolVersion: 2,
      agentPackageVersion: '1:0.0.1+git901.1785844317.abcdef123456',
      agentReleaseCommit: 'abcdef1234567890abcdef1234567890abcdef12',
      agentCapabilities: ['scale.read.v1', 'printer.roll-label.v1', 'printer.big-bag-label.v1'],
      agentCompatibility: 'compatible',
      connectionState: 'online',
      online: true,
      deviceCount: 1,
      capabilityReady: true,
      missingCapabilities: [],
      requiredCapabilityCount: 3,
      createdAt: '2026-08-04T08:00:00.000Z',
      updatedAt: lastSeenAt,
      devices: [device],
    };
    state.devices = [
      {
        ...device,
        rawPayload: 'SERIAL-FRAME-MUST-NOT-RENDER',
        configFingerprint: 'CONFIG-FINGERPRINT-MUST-NOT-RENDER',
      } as AdminDevice,
    ];
    state.posts = [
      {
        ...post,
        agentTokenHash: 'TOKEN-HASH-MUST-NOT-RENDER',
      } as AdminPost,
      {
        ...post,
        id: 'post-2',
        code: 'POST-2',
        name: 'Станок 2',
        commissioningState: 'uncommissioned',
        commissionedAt: null,
        agentStatus: 'online',
        lastSeenAt: '2026-08-04T08:00:00.000Z',
        agentProtocolVersion: 1,
        agentPackageVersion: '1:0.0.0',
        agentReleaseCommit: null,
        agentCapabilities: [],
        agentCompatibility: 'upgrade_required',
        connectionState: 'stale',
        online: false,
        deviceCount: 0,
        capabilityReady: false,
        missingCapabilities: ['scale.read.v1', 'printer.roll-label.v1'],
        requiredCapabilityCount: 2,
        devices: [],
      },
    ];
    return state;
  }

  it('shows commissioning, heartbeat, release and compatibility without sensitive fields', async () => {
    mocks.loadAdminLiveResources.mockResolvedValue(physicalResources());
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(createElement(AdminLiveControlPlane, { section: 'Посты' }));
      await flushPromises();
    });

    const text = renderedControlText(renderer);
    expect(text).toContain('Введён');
    expect(text).toContain('Не введён');
    expect(text).toContain('Совместим');
    expect(text).toContain('Нужно обновить');
    expect(text).toContain('Полный набор');
    expect(text).toContain('Неполный набор');
    expect(text).toContain('Протокол 2');
    expect(text).toContain('abcdef123456');
    expect(text).toContain('Связь 30');
    expect(text).not.toContain('TOKEN-HASH-MUST-NOT-RENDER');
    expect(text).not.toContain('SERIAL-FRAME-MUST-NOT-RENDER');
    renderer.unmount();
  });

  it('shows device probe and driver metadata without raw payload or fingerprint', async () => {
    mocks.loadAdminLiveResources.mockResolvedValue(physicalResources());
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = TestRenderer.create(
        createElement(AdminLiveControlPlane, { section: 'Устройства' }),
      );
      await flushPromises();
    });

    const text = renderedControlText(renderer);
    expect(text).toContain('massa-k-protocol-100 · v1');
    expect(text).toContain('Последняя проба');
    expect(text).not.toContain('SERIAL-FRAME-MUST-NOT-RENDER');
    expect(text).not.toContain('CONFIG-FINGERPRINT-MUST-NOT-RENDER');
    renderer.unmount();
  });
});

function renderedControlText(renderer: ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}
