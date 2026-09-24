import type { NotificationItem } from '../../domain/types';
import { SiemensIcon } from '../../components/shell/SiemensIcon';
import { formatCommercialDateTime } from './commercialPresentation';

const severityOrder = { critical: 0, warning: 1, info: 2 } as const;

export function sortCommercialNotifications(notifications: NotificationItem[]) {
  return notifications
    .map((notification, index) => ({ notification, index }))
    .sort((left, right) => {
      const unread =
        Number(Boolean(left.notification.readAt)) - Number(Boolean(right.notification.readAt));
      if (unread !== 0) return unread;
      return (
        severityOrder[left.notification.severity] - severityOrder[right.notification.severity] ||
        left.index - right.index
      );
    })
    .map(({ notification }) => notification);
}

export function CommercialControlPanel({
  notifications,
  unreadCount,
  soundEnabled,
  hasMore,
  loadingMore,
  onLoadMore,
  onRead,
  onOpen,
  onClose,
}: {
  notifications: NotificationItem[];
  unreadCount: number;
  soundEnabled: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore?: () => void;
  onRead: (id: string) => void;
  onOpen: (notification: NotificationItem) => void;
  onClose: () => void;
}) {
  const sorted = sortCommercialNotifications(notifications);

  return (
    <aside
      className="floating-panel notification-panel commercial-control-panel"
      aria-label="Уведомления"
    >
      <div className="floating-panel-header">
        <div>
          <span className="eyebrow">Контроль</span>
          <h3>{unreadCount} непрочитано</h3>
        </div>
        <button
          className="icon-close-button"
          type="button"
          onClick={onClose}
          aria-label="Закрыть уведомления"
        >
          <SiemensIcon name="close" size="24" />
        </button>
      </div>

      <div className="notification-sound-state">
        <SiemensIcon name={soundEnabled ? 'info' : 'close'} size="16" />
        <span>
          {soundEnabled
            ? 'Звук включен для выбранной роли'
            : 'Звук выключен. Визуальные уведомления остаются активны.'}
        </span>
      </div>

      <div className="notification-list">
        {sorted.length === 0 ? (
          <p className="muted">Нет уведомлений для текущей роли.</p>
        ) : (
          sorted.map((notification) => (
            <article
              key={notification.id}
              className={`notification-card severity-${notification.severity} ${
                notification.readAt ? 'is-read' : 'is-unread'
              }`}
            >
              <div className="notification-card-head">
                <span className="eyebrow">
                  {notification.readAt ? 'Прочитано' : 'Требует внимания'}
                </span>
                <time>{formatCommercialDateTime(notification.createdAt)}</time>
              </div>
              <strong>{notification.title}</strong>
              <p>{notification.body}</p>
              <div className="notification-actions">
                {notification.objectId ? (
                  <button
                    className="notification-secondary-button"
                    type="button"
                    onClick={() => onOpen(notification)}
                  >
                    Открыть заявку
                  </button>
                ) : null}
                {!notification.readAt ? (
                  <button
                    className="notification-secondary-button"
                    type="button"
                    onClick={() => onRead(notification.id)}
                  >
                    <SiemensIcon name="check" size="16" />
                    Прочитано
                  </button>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
      {hasMore && onLoadMore ? (
        <div className="notification-pagination">
          <button
            className="notification-secondary-button"
            type="button"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? 'Загрузка…' : 'Показать ещё'}
          </button>
        </div>
      ) : null}
    </aside>
  );
}
