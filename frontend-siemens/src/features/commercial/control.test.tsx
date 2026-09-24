import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '../../api/auth';
import { roleAccessPolicies } from '../../domain/accessPolicy';
import type { NotificationItem } from '../../domain/types';
import { CommercialControlPanel } from './CommercialControlPanel';
import { CommercialProfilePanel, commercialSessionFromMe } from './CommercialProfilePanel';
import { mapCommercialNotification, type ServerCommercialNotification } from './api';

const me: MeResponse = {
  userId: 'commercial-user',
  role: 'commercial',
  capabilities: ['commercial_notification:read'],
  displayName: 'Ирина Коммерция',
  isActive: true,
  sessionPurpose: 'full',
  session: {
    id: 'session-1',
    purpose: 'full',
    state: 'active',
    createdAt: '2026-07-14T08:00:00.000Z',
    expiresAt: '2026-07-14T20:00:00.000Z',
    lastSeenAt: '2026-07-14T10:00:00.000Z',
  },
  workContext: { kind: 'office', assignment: null },
  passwordChangeRequired: false,
};

const serverNotification: ServerCommercialNotification = {
  id: 'event-1',
  eventType: 'audit:warehouse_cover_proposed',
  recipientRole: 'commercial',
  severity: 'info',
  orderId: 'order-1',
  orderNumber: 'A-1',
  taskId: 'proposal-1',
  positionId: null,
  rollId: null,
  title: 'Склад предложил покрытие',
  body: 'Проверьте складское покрытие заявки A-1.',
  createdAt: '2026-07-14T10:00:00.000Z',
  unread: true,
  nextOwnerRole: 'commercial',
  cta: { kind: 'warehouse_cover', targetId: 'order-1', section: 'В работе' },
};

describe('commercial profile and Control', () => {
  it('maps real account data but keeps session details out of the cabinet', () => {
    const session = commercialSessionFromMe(me, {
      notificationSound: false,
      reducedMotion: false,
    });
    const markup = renderToStaticMarkup(
      <CommercialProfilePanel
        session={session}
        policy={roleAccessPolicies.commercial}
        onToggleSound={vi.fn()}
        onToggleReducedMotion={vi.fn()}
        onLogout={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(session).toMatchObject({
      name: 'Ирина Коммерция',
      workplace: null,
      shift: null,
      status: 'active',
      sessionExpiresAt: '2026-07-14T20:00:00.000Z',
    });
    expect(markup).toContain('Ирина Коммерция');
    expect(markup).toContain('Доступные разделы');
    expect(markup).not.toContain('Рабочее место не назначено');
    expect(markup).not.toContain('Смена не назначена');
    expect(markup).not.toContain('Дневная смена');
    expect(markup).not.toContain('Сессия действует до');
    expect(markup).not.toContain('Сводка доступа');
  });

  it('maps the event id/read state and renders a safe order CTA', () => {
    const notification = mapCommercialNotification(serverNotification);
    const markup = renderToStaticMarkup(
      <CommercialControlPanel
        notifications={[notification]}
        unreadCount={1}
        soundEnabled={false}
        hasMore={false}
        loadingMore={false}
        onRead={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(notification).toMatchObject({ id: 'event-1', objectId: 'order-1' });
    expect(notification.readAt).toBeUndefined();
    expect(markup).toContain('class="floating-panel notification-panel commercial-control-panel"');
    expect(markup).toContain('14.07.2026');
    expect(markup).toContain('Склад предложил покрытие');
    expect(markup).toContain('Открыть заявку');
    expect(markup).not.toContain('order-1');
    expect(markup).not.toContain('2026-07-14T10:00:00.000Z');

    const readNotification: NotificationItem = {
      ...notification,
      id: 'event-2',
      title: 'Ранее прочитано',
      severity: 'critical',
      readAt: '2026-07-14T10:05:00.000Z',
    };
    const orderedMarkup = renderToStaticMarkup(
      <CommercialControlPanel
        notifications={[readNotification, notification]}
        unreadCount={1}
        soundEnabled={false}
        hasMore={false}
        loadingMore={false}
        onRead={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(orderedMarkup.indexOf('Склад предложил покрытие')).toBeLessThan(
      orderedMarkup.indexOf('Ранее прочитано'),
    );
    expect(orderedMarkup).toContain('Прочитано');
  });

  it('uses the complete server unread total and the shared bounded pagination control', () => {
    const notification = mapCommercialNotification(serverNotification);
    const onLoadMore = vi.fn();
    const markup = renderToStaticMarkup(
      <CommercialControlPanel
        notifications={[notification]}
        unreadCount={37}
        soundEnabled={false}
        hasMore
        loadingMore={false}
        onLoadMore={onLoadMore}
        onRead={vi.fn()}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('<h3>37 непрочитано</h3>');
    expect(markup).toContain('class="notification-pagination"');
    expect(markup).toContain('Показать ещё');
  });
});
