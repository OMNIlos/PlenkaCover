import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { NotificationItem } from '../../domain/types';
import { canAcknowledgeNotification, NotificationCenter, RoleTopNavigation } from './appShell';

const warningNotification: NotificationItem = {
  id: 'notification-1',
  recipientRole: 'operator',
  severity: 'warning',
  title: 'Требуется действие',
  body: 'Проверьте событие.',
  createdAt: '12:00',
  requiresAck: true,
  sound: true,
};

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return '';
  return Children.toArray(node.props.children).map(textContent).join('');
}

function findButton(
  node: ReactNode,
  label: string,
): ReactElement<{
  children?: ReactNode;
  onClick?: () => void;
  type?: string;
}> {
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    throw new Error(`Button "${label}" not found`);
  }
  if (node.type === 'button' && textContent(node).includes(label)) {
    return node as ReactElement<{ children?: ReactNode; onClick?: () => void; type?: string }>;
  }
  for (const child of Children.toArray(node.props.children)) {
    try {
      return findButton(child, label);
    } catch {
      // Continue searching the remaining element children.
    }
  }
  throw new Error(`Button "${label}" not found`);
}

function notificationCenter(
  notification: NotificationItem,
  callbacks: {
    onRead?: (id: string) => void;
    onAck?: (id: string) => void;
    onOpen?: (item: NotificationItem) => void;
    onLoadMore?: () => void;
    unreadCount?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
  } = {},
) {
  return NotificationCenter({
    notifications: [notification],
    unreadCount: callbacks.unreadCount ?? 1,
    soundEnabled: false,
    onRead: callbacks.onRead ?? vi.fn(),
    onAck: callbacks.onAck ?? vi.fn(),
    onOpen: callbacks.onOpen,
    hasMore: callbacks.hasMore ?? false,
    loadingMore: callbacks.loadingMore ?? false,
    onLoadMore: callbacks.onLoadMore,
    onClose: vi.fn(),
  });
}

describe('notification acknowledgement policy', () => {
  it('never offers acknowledgement for an assigned penalty', () => {
    const penaltyNotification = {
      ...warningNotification,
      eventType: 'notification:penalty_created',
    } as NotificationItem;

    expect(canAcknowledgeNotification(penaltyNotification)).toBe(false);
  });

  it('keeps acknowledgement for ordinary actionable notifications', () => {
    const paymentNotification = {
      ...warningNotification,
      recipientRole: 'finance',
      eventType: 'notification:payment_due_invoice_needed',
    } as NotificationItem;

    expect(canAcknowledgeNotification(paymentNotification)).toBe(true);
  });

  it('does not offer acknowledgement after it was already recorded', () => {
    expect(
      canAcknowledgeNotification({
        ...warningNotification,
        acknowledgedAt: '12:05',
      }),
    ).toBe(false);
  });
});

describe('NotificationCenter actions', () => {
  it('renders expandable safe information for a fully handed-over order', () => {
    const center = notificationCenter({
      ...warningNotification,
      eventType: 'notification:production_order_fully_handed_over',
      title: 'Заказ ORDER-A полностью передан на склад',
      orderNumber: 'ORDER-A',
      orderInfo: {
        orderNumber: 'ORDER-A',
        rollCount: 22,
        rollCodes: ['ROLL-1', 'ROLL-2'],
        omittedRollCount: 20,
      },
    });
    const markup = renderToStaticMarkup(center);

    expect(markup).toContain('<details class="notification-order-info">');
    expect(markup).toContain('<summary>Информация о заказе</summary>');
    expect(markup).toContain('Номер заказа: <strong>ORDER-A</strong>');
    expect(markup).toContain('Передано рулонов: <strong>22</strong>');
    expect(markup).toContain('ROLL-1, ROLL-2');
    expect(markup).toContain('Ещё 20 рулонов');
  });

  it('renders a short button for navigable items and invokes onOpen with that item', () => {
    const notification: NotificationItem = {
      ...warningNotification,
      navigation: { section: 'Запасы / резерв', objectId: 'WH-COVER-order-1' },
    };
    const onOpen = vi.fn();
    const center = notificationCenter(notification, { onOpen });

    expect(renderToStaticMarkup(center)).toContain('>Открыть</button>');
    const button = findButton(center, 'Открыть');
    expect(button.props.type).toBe('button');

    button.props.onClick?.();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(notification);
  });

  it('does not infer navigation from a legacy objectId', () => {
    const center = notificationCenter(
      { ...warningNotification, objectId: 'legacy-object' },
      { onOpen: vi.fn() },
    );

    expect(renderToStaticMarkup(center)).not.toContain('>Открыть</button>');
  });

  it('preserves read and acknowledgement button behavior', () => {
    const onRead = vi.fn();
    const onAck = vi.fn();
    const center = notificationCenter(warningNotification, { onRead, onAck });
    const readButton = findButton(center, 'Прочитано');
    const ackButton = findButton(center, 'Подтвердить');

    expect(readButton.props.type).toBe('button');
    expect(ackButton.props.type).toBe('button');
    readButton.props.onClick?.();
    ackButton.props.onClick?.();

    expect(onRead).toHaveBeenCalledWith(warningNotification.id);
    expect(onAck).toHaveBeenCalledWith(warningNotification.id);
  });

  it('renders the server unread total and a bounded compact load-more action', () => {
    const onLoadMore = vi.fn();
    const center = notificationCenter(warningNotification, {
      unreadCount: 37,
      hasMore: true,
      onLoadMore,
    });
    const markup = renderToStaticMarkup(center);

    expect(markup).toContain('<h3>37 непрочитано</h3>');
    expect(markup).toContain('class="notification-pagination"');
    const button = findButton(center, 'Показать ещё');
    button.props.onClick?.();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it('hides pagination at the end and exposes a disabled loading state while fetching', () => {
    const complete = notificationCenter(warningNotification, {
      unreadCount: 1,
      hasMore: false,
      onLoadMore: vi.fn(),
    });
    const loading = notificationCenter(warningNotification, {
      unreadCount: 1,
      hasMore: true,
      loadingMore: true,
      onLoadMore: vi.fn(),
    });

    expect(renderToStaticMarkup(complete)).not.toContain('Показать ещё');
    expect(renderToStaticMarkup(loading)).toContain('Загрузка…');
    expect(renderToStaticMarkup(loading)).toContain('disabled=""');
  });
});

describe('RoleTopNavigation explicit section counts', () => {
  it('does not render the removed warehouse consumables and movements tabs', () => {
    const html = renderToStaticMarkup(
      createElement(RoleTopNavigation, {
        role: 'warehouse',
        activeSection: 'Сырье',
        onChangeSection: vi.fn(),
      }),
    );

    expect(html).not.toContain('Расходники');
    expect(html).not.toContain('Движения');
  });

  it('treats an explicit zero as authoritative instead of falling back to container objects', () => {
    const html = renderToStaticMarkup(
      createElement(RoleTopNavigation, {
        role: 'warehouse',
        activeSection: 'Сырье',
        sectionCounts: {
          Сырье: 2,
          'Все рулоны': 0,
          Расходники: 0,
          Движения: 0,
        },
        onChangeSection: vi.fn(),
      }),
    );

    expect(html).toContain('title="Сырье: 2 строки.');
    expect(html).toContain('title="Все рулоны: Фактические рулоны и следующий маршрут.');
    expect(html).not.toContain('title="Все рулоны: 1 строка.');
    expect(html).not.toContain('title="Все рулоны: 0 строк.');
  });
});
