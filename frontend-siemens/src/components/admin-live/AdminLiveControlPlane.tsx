import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  acknowledgeAdminIncident,
  applyAdminRoleTemplate,
  bindAdminDevice,
  blockAdminUser,
  checkAdminOneC,
  checkAdminPlatformHealth,
  commissionAdminPost,
  createAdminDevice,
  createAdminPost,
  createAdminRoleTemplate,
  createAdminUser,
  fetchAdminDeviceQuality,
  fetchAdminOneCRawSnapshot,
  fetchAdminPostQuality,
  fetchAdminUserSessions,
  importAdminOneC,
  reactivateAdminUser,
  recoverAdminDevice,
  recheckAdminIncident,
  resetAdminUserPassword,
  resolveAdminIncident,
  revokeAdminUserSessions,
  retryAdminOneC,
  rotateAdminPostToken,
  testAdminDevice,
  updateAdminDevice,
  updateAdminPost,
  updateAdminRoleTemplate,
  updateAdminUserAccess,
  type AdminAccessTemplate,
  type AdminCapability,
  type AdminCapabilityCatalogItem,
  type AdminDevice,
  type AdminIncident,
  type AdminPost,
  type AdminRole,
  type AdminSession,
  type AdminUser,
  type OneCSnapshot,
  type PlatformHealth,
} from '../../api/admin';
import { AdminCapabilityEditor, capabilityConflictKeys } from './AdminCapabilityEditor';
import { AdminPrintRecoverySection } from './AdminPrintRecoverySection';
import { AdminMaterialTypesSection } from './AdminMaterialTypesSection';
import { oneCCheckFeedback, type OneCCheckFeedback } from './oneCCheckFeedback';
import {
  loadAdminLiveResources,
  reduceTemporarySecret,
  type AdminLiveResources,
  type TemporarySecret,
} from '../../domain/adminLiveState';
import {
  PlenkiDataTable,
  PlenkiMetricStrip,
  PlenkiModal,
  PlenkiToolbar,
  type PlenkiDataTableColumn,
} from '../plenki-ui/PlenkiPrimitives';

const ADMIN_ROLES: Array<{ id: AdminRole; label: string }> = [
  { id: 'commercial', label: 'Коммерция' },
  { id: 'production_lead', label: 'Зав. производства' },
  { id: 'operator', label: 'Оператор' },
  { id: 'warehouse', label: 'Склад' },
  { id: 'finance', label: 'Бухгалтерия' },
  { id: 'director', label: 'Директор' },
  { id: 'admin', label: 'Администратор' },
];

type Editor =
  | { type: 'create-user' }
  | { type: 'user-access'; user: AdminUser }
  | { type: 'user-sessions'; user: AdminUser }
  | { type: 'create-template' }
  | { type: 'template'; template: AdminAccessTemplate }
  | { type: 'create-device' }
  | { type: 'create-post' }
  | null;

type ReasonAction =
  | { kind: 'block-user'; id: string; label: string }
  | { kind: 'reactivate-user'; id: string; label: string }
  | { kind: 'reset-password'; id: string; label: string }
  | { kind: 'bind-device'; id: string; label: string; postId: string }
  | { kind: 'toggle-device'; id: string; label: string; isEnabled: boolean }
  | { kind: 'recover-device'; id: string; label: string }
  | { kind: 'toggle-post'; id: string; label: string; status: 'active' | 'disabled' }
  | { kind: 'commission-post'; id: string; label: string }
  | { kind: 'rotate-post'; id: string; label: string }
  | { kind: 'ack-incident'; id: string; label: string }
  | { kind: 'resolve-incident'; id: string; label: string };

type RawState = {
  snapshot: OneCSnapshot;
  loading: boolean;
  value: Record<string, unknown> | null;
  error: string | null;
} | null;

type QualityState = {
  kind: 'device' | 'post';
  label: string;
  loading: boolean;
  value:
    | Awaited<ReturnType<typeof fetchAdminDeviceQuality>>
    | Awaited<ReturnType<typeof fetchAdminPostQuality>>
    | null;
  error: string | null;
} | null;

export function AdminLiveControlPlane({
  section,
  selectedIncidentId = null,
}: {
  section: string;
  selectedIncidentId?: string | null;
}) {
  const [resources, setResources] = useState<AdminLiveResources | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [reasonAction, setReasonAction] = useState<ReasonAction | null>(null);
  const [secret, dispatchSecret] = useReducer(reduceTemporarySecret, null);
  const [raw, setRaw] = useState<RawState>(null);
  const [quality, setQuality] = useState<QualityState>(null);
  const refreshGeneration = useRef(0);
  const incidentRefreshTarget = useRef<string | null>(null);

  const refresh = useCallback(async (background = false) => {
    const generation = ++refreshGeneration.current;
    if (!background) setLoading(true);
    setError(null);
    try {
      const next = await loadAdminLiveResources();
      if (generation === refreshGeneration.current) setResources(next);
    } catch (caught) {
      if (generation === refreshGeneration.current) setError(errorMessage(caught));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (section !== 'Инциденты' || !selectedIncidentId) {
      incidentRefreshTarget.current = null;
      return;
    }
    if (!resources) return;
    if (resources.incidents.some((incident) => incident.id === selectedIncidentId)) {
      if (incidentRefreshTarget.current === selectedIncidentId) {
        incidentRefreshTarget.current = null;
      }
      return;
    }
    if (incidentRefreshTarget.current === selectedIncidentId) return;
    incidentRefreshTarget.current = selectedIncidentId;
    void refresh(true);
  }, [refresh, resources, section, selectedIncidentId]);

  useEffect(() => {
    setNotice(null);
    setError(null);
    setEditor(null);
    setReasonAction(null);
    setRaw(null);
    setQuality(null);
  }, [section]);

  const run = useCallback(
    async <T,>(
      key: string,
      operation: () => Promise<T>,
      success: string | ((value: T) => OneCCheckFeedback),
      after?: (value: T) => void,
    ) => {
      setBusyKey(key);
      setError(null);
      setNotice(null);
      try {
        const result = await operation();
        after?.(result);
        const feedback: OneCCheckFeedback =
          typeof success === 'function' ? success(result) : { kind: 'notice', message: success };
        if (feedback.kind === 'notice') setNotice(feedback.message);
        await refresh(true);
        if (feedback.kind === 'error') setError(feedback.message);
        return result;
      } catch (caught) {
        setError(errorMessage(caught));
        return null;
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  async function submitReason(reason: string) {
    const action = reasonAction;
    if (!action) return;
    const key = `${action.kind}:${action.id}`;
    if (action.kind === 'block-user') {
      await run(key, () => blockAdminUser(action.id, reason), 'Аккаунт заблокирован.');
    } else if (action.kind === 'reactivate-user') {
      await run(key, () => reactivateAdminUser(action.id, reason), 'Аккаунт восстановлен.');
    } else if (action.kind === 'reset-password') {
      await run(
        key,
        () => resetAdminUserPassword(action.id, reason),
        'Пароль сброшен.',
        (result) => {
          dispatchSecret({
            type: 'received',
            secret: {
              kind: 'password',
              subject: result.user.login,
              value: result.temporaryPassword,
            },
          });
        },
      );
    } else if (action.kind === 'bind-device') {
      await run(
        key,
        () => bindAdminDevice(action.id, { postId: action.postId, reason }),
        'Привязка устройства изменена.',
      );
    } else if (action.kind === 'toggle-device') {
      await run(
        key,
        () => updateAdminDevice(action.id, { isEnabled: action.isEnabled, reason }),
        action.isEnabled ? 'Устройство включено.' : 'Устройство отключено.',
      );
    } else if (action.kind === 'recover-device') {
      await run(key, () => recoverAdminDevice(action.id, reason), 'Recovery и проверка выполнены.');
    } else if (action.kind === 'toggle-post') {
      await run(
        key,
        () => updateAdminPost(action.id, { status: action.status, reason }),
        action.status === 'active' ? 'Пост включён.' : 'Пост отключён.',
      );
    } else if (action.kind === 'commission-post') {
      await run(key, () => commissionAdminPost(action.id, reason), 'Пост введён в эксплуатацию.');
    } else if (action.kind === 'rotate-post') {
      await run(
        key,
        () => rotateAdminPostToken(action.id, reason),
        'Токен поста заменён.',
        (result) => {
          dispatchSecret({
            type: 'received',
            secret: { kind: 'gateway-token', subject: action.label, value: result.token },
          });
        },
      );
    } else if (action.kind === 'ack-incident') {
      await run(
        key,
        () => acknowledgeAdminIncident(action.id, reason),
        'Инцидент принят в работу.',
      );
    } else {
      await run(key, () => resolveAdminIncident(action.id, reason), 'Инцидент закрыт.');
    }
    setReasonAction(null);
  }

  async function openRawSnapshot(snapshot: OneCSnapshot) {
    setRaw({ snapshot, loading: true, value: null, error: null });
    try {
      const value = await fetchAdminOneCRawSnapshot(snapshot.id);
      setRaw({ snapshot, loading: false, value, error: null });
    } catch (caught) {
      setRaw({ snapshot, loading: false, value: null, error: errorMessage(caught) });
    }
  }

  async function openQuality(kind: 'device' | 'post', id: string, label: string) {
    setQuality({ kind, label, loading: true, value: null, error: null });
    try {
      const value =
        kind === 'device' ? await fetchAdminDeviceQuality(id) : await fetchAdminPostQuality(id);
      setQuality({ kind, label, loading: false, value, error: null });
    } catch (caught) {
      setQuality({ kind, label, loading: false, value: null, error: errorMessage(caught) });
    }
  }

  const productIncidents =
    resources?.incidents.filter((incident) => !isOneCRelatedIncident(incident)) ?? [];
  const productRoleTemplates =
    resources?.roleTemplates.filter(
      (template) => !hasOneCReference(template.id, template.name),
    ) ?? [];
  const productCapabilities =
    resources?.capabilities.filter(
      (capability) =>
        !hasOneCReference(
          capability.key,
          capability.label,
          capability.description,
          capability.group,
        ),
    ) ?? [];
  const unresolved = productIncidents.filter((incident) => incident.status !== 'resolved');
  const resourceError = resources ? sectionResourceError(resources, section) : null;

  return (
    <article className="admin-live-control-plane" data-testid="admin-control-plane">
      <header className="admin-live-header">
        <div>
          <h1>{sectionTitle(section)}</h1>
          <p>Управление доступами, устройствами и инцидентами.</p>
        </div>
        <button
          className="compact-action-button"
          type="button"
          disabled={loading || busyKey !== null}
          onClick={() => void refresh()}
        >
          <ix-icon name="history" size="16" />
          <span>Обновить</span>
        </button>
      </header>

      {error ? (
        <div className="admin-live-message tone-critical" role="alert">
          {error}
        </div>
      ) : null}
      {resourceError ? (
        <div className="admin-live-message tone-critical" role="alert">
          <span>{resourceError}</span>
          <button type="button" className="compact-action-button" onClick={() => void refresh()}>
            Повторить загрузку
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="admin-live-message tone-success" role="status">
          {notice}
        </div>
      ) : null}
      {loading && !resources ? <AdminLoading /> : null}

      {resources ? (
        <>
          {section === 'Доступы' ? (
            <AccountsSection
              users={resources.users.items}
              busyKey={busyKey}
              onCreate={() => setEditor({ type: 'create-user' })}
              onAccess={(user) => setEditor({ type: 'user-access', user })}
              onSessions={(user) => setEditor({ type: 'user-sessions', user })}
              onReason={setReasonAction}
            />
          ) : null}
          {section === 'Шаблоны ролей' ? (
            <RoleTemplatesSection
              templates={productRoleTemplates}
              onCreate={() => setEditor({ type: 'create-template' })}
              onEdit={(template) => setEditor({ type: 'template', template })}
            />
          ) : null}
          {section === 'Устройства' ? <AdminPrintRecoverySection /> : null}
          {section === 'Устройства' ? (
            <DevicesSection
              devices={resources.devices}
              posts={resources.posts}
              busyKey={busyKey}
              onCreate={() => setEditor({ type: 'create-device' })}
              onTest={(device) =>
                void run(
                  `test-device:${device.id}`,
                  () => testAdminDevice(device.id),
                  `Проверка «${device.label ?? device.code ?? device.id}» выполнена.`,
                )
              }
              onQuality={(device) =>
                void openQuality('device', device.id, device.label ?? device.code ?? device.id)
              }
              onReason={setReasonAction}
            />
          ) : null}
          {section === 'Посты' ? (
            <PostsSection
              posts={resources.posts}
              busyKey={busyKey}
              onCreate={() => setEditor({ type: 'create-post' })}
              onQuality={(post) => void openQuality('post', post.id, `${post.code} · ${post.name}`)}
              onReason={setReasonAction}
            />
          ) : null}
          {section === 'Виды сырья' ? <AdminMaterialTypesSection /> : null}
          {section === '1С' || section === 'Источники' ? (
            <OneCSection
              overview={resources.oneC}
              snapshots={resources.snapshots.items}
              busyKey={busyKey}
              onCheck={() => void run('onec-check', checkAdminOneC, oneCCheckFeedback)}
              onImport={(subjectType) =>
                void run(
                  `onec-import:${subjectType}`,
                  () => importAdminOneC(subjectType),
                  `Импорт «${subjectType}» завершён.`,
                )
              }
              onRetry={(journalId) =>
                void run(
                  `onec-retry:${journalId}`,
                  () => retryAdminOneC(journalId),
                  'Повтор импорта выполнен.',
                )
              }
              onRaw={(snapshot) => void openRawSnapshot(snapshot)}
            />
          ) : null}
          {section === 'Состояние платформы' ? (
            <PlatformHealthSection
              health={resources.platformHealth}
              incidents={unresolved}
              busyKey={busyKey}
              onCheck={() =>
                void run(
                  'platform-check',
                  checkAdminPlatformHealth,
                  'Полная проверка платформы выполнена.',
                )
              }
            />
          ) : null}
          {section === 'Инциденты' ? (
            <IncidentsSection
              incidents={productIncidents}
              selectedIncidentId={selectedIncidentId}
              busyKey={busyKey}
              onReason={setReasonAction}
              onRecheck={(incident) =>
                void run(
                  `incident-recheck:${incident.id}`,
                  () => recheckAdminIncident(incident.id),
                  'Повторная проверка выполнена.',
                )
              }
            />
          ) : null}
          {section === 'Проблемы / история' ? <AuditSection resources={resources} /> : null}
        </>
      ) : null}

      {editor?.type === 'create-user' ? (
        <CreateUserModal
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run(
              'create-user',
              () => createAdminUser(input),
              'Аккаунт создан.',
            );
            if (!result) return;
            setEditor(null);
            dispatchSecret({
              type: 'received',
              secret: {
                kind: 'password',
                subject: result.user.login,
                value: result.temporaryPassword,
              },
            });
          }}
          busy={busyKey === 'create-user'}
        />
      ) : null}
      {editor?.type === 'user-access' ? (
        <UserAccessModal
          user={editor.user}
          templates={productRoleTemplates}
          catalog={productCapabilities}
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run(
              `user-access:${editor.user.id}`,
              () => updateAdminUserAccess(editor.user.id, input),
              'Права пользователя обновлены; активные сессии отозваны.',
            );
            if (result) setEditor(null);
          }}
          onApply={async (input) => {
            const result = await run(
              `apply-template:${editor.user.id}`,
              () => applyAdminRoleTemplate(editor.user.id, input),
              'Шаблон применён; активные сессии отозваны.',
            );
            if (result) setEditor(null);
          }}
          busy={
            busyKey === `user-access:${editor.user.id}` ||
            busyKey === `apply-template:${editor.user.id}`
          }
        />
      ) : null}
      {editor?.type === 'user-sessions' ? (
        <SessionsModal
          user={editor.user}
          busy={busyKey === `user-sessions:${editor.user.id}`}
          onClose={() => setEditor(null)}
          onRevoke={async (input) => {
            const result = await run(
              `user-sessions:${editor.user.id}`,
              () => revokeAdminUserSessions(editor.user.id, input),
              input.sessionId ? 'Сессия отозвана.' : 'Все активные сессии отозваны.',
            );
            if (result) setEditor(null);
          }}
        />
      ) : null}
      {editor?.type === 'create-template' ? (
        <CreateTemplateModal
          catalog={productCapabilities}
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run(
              'create-template',
              () => createAdminRoleTemplate(input),
              'Шаблон роли создан.',
            );
            if (result) setEditor(null);
          }}
          busy={busyKey === 'create-template'}
        />
      ) : null}
      {editor?.type === 'template' ? (
        <TemplateModal
          template={editor.template}
          catalog={productCapabilities}
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run(
              `template:${editor.template.id}`,
              () => updateAdminRoleTemplate(editor.template.id, input),
              'Шаблон роли обновлён.',
            );
            if (result) setEditor(null);
          }}
          busy={busyKey === `template:${editor.template.id}`}
        />
      ) : null}
      {editor?.type === 'create-device' ? (
        <CreateDeviceModal
          posts={resources?.posts ?? []}
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run(
              'create-device',
              () => createAdminDevice(input),
              'Устройство добавлено.',
            );
            if (result) setEditor(null);
          }}
          busy={busyKey === 'create-device'}
        />
      ) : null}
      {editor?.type === 'create-post' ? (
        <CreatePostModal
          onClose={() => setEditor(null)}
          onSubmit={async (input) => {
            const result = await run('create-post', () => createAdminPost(input), 'Пост добавлен.');
            if (result) setEditor(null);
          }}
          busy={busyKey === 'create-post'}
        />
      ) : null}
      {reasonAction ? (
        <ReasonModal
          action={reasonAction}
          busy={busyKey === `${reasonAction.kind}:${reasonAction.id}`}
          onClose={() => setReasonAction(null)}
          onSubmit={(reason) => void submitReason(reason)}
        />
      ) : null}
      {secret ? (
        <TemporarySecretModal
          secret={secret}
          onClose={() => dispatchSecret({ type: 'dismissed' })}
        />
      ) : null}
      {raw ? <RawSnapshotModal state={raw} onClose={() => setRaw(null)} /> : null}
      {quality ? <QualityModal state={quality} onClose={() => setQuality(null)} /> : null}
    </article>
  );
}

function AccountsSection({
  users,
  busyKey,
  onCreate,
  onAccess,
  onSessions,
  onReason,
}: {
  users: AdminUser[];
  busyKey: string | null;
  onCreate: () => void;
  onAccess: (user: AdminUser) => void;
  onSessions: (user: AdminUser) => void;
  onReason: (action: ReasonAction) => void;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? users.filter((user) =>
          [user.login, user.displayName, roleLabel(user.role)].some((value) =>
            value.toLowerCase().includes(normalized),
          ),
        )
      : users;
  }, [query, users]);
  const columns: Array<PlenkiDataTableColumn<AdminUser>> = [
    {
      id: 'account',
      header: 'Аккаунт',
      render: (user) => (
        <span className="admin-live-primary-cell">
          <strong>{user.displayName}</strong>
          <small>{user.login}</small>
        </span>
      ),
    },
    { id: 'role', header: 'Роль', render: (user) => roleLabel(user.role) },
    { id: 'status', header: 'Статус', render: (user) => <StatusText status={user.status} /> },
    { id: 'sessions', header: 'Сессии', align: 'right', render: (user) => user.activeSessionCount },
    {
      id: 'actions',
      header: 'Действия',
      width: '470px',
      render: (user) => (
        <span className="admin-live-row-actions">
          <button type="button" className="compact-action-button" onClick={() => onAccess(user)}>
            Права
          </button>
          <button type="button" className="compact-action-button" onClick={() => onSessions(user)}>
            Сессии
          </button>
          <button
            type="button"
            className="compact-action-button"
            disabled={busyKey !== null}
            onClick={() => onReason({ kind: 'reset-password', id: user.id, label: user.login })}
          >
            Сбросить пароль
          </button>
          <button
            type="button"
            className={`compact-action-button ${user.status === 'blocked' ? '' : 'action-destructive'}`}
            disabled={busyKey !== null}
            onClick={() =>
              onReason({
                kind: user.status === 'blocked' ? 'reactivate-user' : 'block-user',
                id: user.id,
                label: user.login,
              })
            }
          >
            {user.status === 'blocked' ? 'Восстановить' : 'Заблокировать'}
          </button>
        </span>
      ),
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-accounts">
      <PlenkiMetricStrip
        metrics={[
          { id: 'all', label: 'Аккаунты', value: users.length, caption: 'в системе' },
          {
            id: 'active',
            label: 'Активны',
            value: users.filter((user) => user.status === 'active').length,
            tone: 'success',
          },
          {
            id: 'setup',
            label: 'Первый вход',
            value: users.filter((user) => user.status === 'password_setup').length,
            tone: 'warning',
          },
          {
            id: 'blocked',
            label: 'Заблокированы',
            value: users.filter((user) => user.status === 'blocked').length,
            tone: 'critical',
          },
        ]}
      />
      <PlenkiToolbar
        searchValue={query}
        searchPlaceholder="Поиск по имени, логину или роли"
        onSearchChange={setQuery}
        meta={
          <span>
            {visible.length} из {users.length}
          </span>
        }
        actions={
          <button
            type="button"
            className="compact-action-button action-recommended"
            onClick={onCreate}
          >
            Добавить аккаунт
          </button>
        }
      />
      <PlenkiDataTable
        caption="Аккаунты"
        columns={columns}
        rows={visible}
        getRowKey={(user) => user.id}
      />
    </section>
  );
}

function RoleTemplatesSection({
  templates,
  onCreate,
  onEdit,
}: {
  templates: AdminAccessTemplate[];
  onCreate: () => void;
  onEdit: (template: AdminAccessTemplate) => void;
}) {
  const columns: Array<PlenkiDataTableColumn<AdminAccessTemplate>> = [
    {
      id: 'name',
      header: 'Шаблон',
      render: (template) => (
        <span className="admin-live-primary-cell">
          <strong>{template.name}</strong>
          <small>
            v{template.version}
            {template.isSystem ? ' · системный' : ''}
          </small>
        </span>
      ),
    },
    { id: 'role', header: 'Роль', render: (template) => roleLabel(template.role) },
    {
      id: 'status',
      header: 'Состояние',
      render: (template) => <StatusText status={template.setupStatus} />,
    },
    {
      id: 'grants',
      header: 'Доп. права',
      align: 'right',
      render: (template) => template.capabilityGrants.length,
    },
    {
      id: 'denials',
      header: 'Запреты',
      align: 'right',
      render: (template) => template.capabilityDenials.length,
    },
    {
      id: 'actions',
      header: 'Действия',
      width: '140px',
      render: (template) => (
        <button type="button" className="compact-action-button" onClick={() => onEdit(template)}>
          Редактировать
        </button>
      ),
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-role-templates">
      <div className="admin-live-callout">
        <strong>Шаблоны определяют разрешения</strong>
        <span>
          Изменение версии требует причины; применение пользователю отзывает его активные сессии.
        </span>
      </div>
      <PlenkiToolbar
        actions={
          <button
            type="button"
            className="compact-action-button action-recommended"
            onClick={onCreate}
          >
            Добавить шаблон
          </button>
        }
      />
      <PlenkiDataTable
        caption="Шаблоны ролей"
        columns={columns}
        rows={templates}
        getRowKey={(template) => template.id}
      />
    </section>
  );
}

function DevicesSection({
  devices,
  posts,
  busyKey,
  onCreate,
  onTest,
  onQuality,
  onReason,
}: {
  devices: AdminDevice[];
  posts: AdminPost[];
  busyKey: string | null;
  onCreate: () => void;
  onTest: (device: AdminDevice) => void;
  onQuality: (device: AdminDevice) => void;
  onReason: (action: ReasonAction) => void;
}) {
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const columns: Array<PlenkiDataTableColumn<AdminDevice>> = [
    {
      id: 'device',
      header: 'Устройство',
      render: (device) => (
        <span className="admin-live-primary-cell">
          <strong>{device.label ?? device.code ?? device.id}</strong>
          <small>
            {device.code ?? device.id} · {device.connectionKind ?? 'тип связи не задан'}
          </small>
        </span>
      ),
    },
    { id: 'kind', header: 'Тип', render: (device) => deviceKindLabel(device.kind) },
    {
      id: 'status',
      header: 'Состояние',
      render: (device) => <StatusText status={device.isEnabled ? device.status : 'disabled'} />,
    },
    {
      id: 'diagnostics',
      header: 'Проверка и драйвер',
      width: '260px',
      render: (device) => (
        <span className="admin-live-primary-cell">
          <strong>{deviceDriverLabel(device)}</strong>
          <small>Последняя проба: {formatDate(device.lastProbeAt)}</small>
          <small>Последняя связь: {formatDate(device.lastSeenAt)}</small>
        </span>
      ),
    },
    {
      id: 'post',
      header: 'Пост',
      width: '220px',
      render: (device) => (
        <select
          className="admin-live-select"
          value={bindings[device.id] ?? device.postId ?? ''}
          onChange={(event) =>
            setBindings((current) => ({ ...current, [device.id]: event.target.value }))
          }
          aria-label={`Пост для ${device.label ?? device.id}`}
        >
          <option value="">Не привязано</option>
          {posts.map((post) => (
            <option key={post.id} value={post.id}>
              {post.code} · {post.name}
            </option>
          ))}
        </select>
      ),
    },
    {
      id: 'actions',
      header: 'Действия',
      width: '470px',
      render: (device) => {
        const targetPostId = bindings[device.id] ?? device.postId ?? '';
        return (
          <span className="admin-live-row-actions">
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null || !device.isEnabled || !device.postId}
              onClick={() => onTest(device)}
            >
              Тест
            </button>
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null}
              onClick={() => onQuality(device)}
            >
              Качество
            </button>
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null || !device.postId}
              onClick={() =>
                onReason({
                  kind: 'recover-device',
                  id: device.id,
                  label: device.label ?? device.id,
                })
              }
            >
              Recovery
            </button>
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null || !targetPostId || targetPostId === device.postId}
              onClick={() =>
                onReason({
                  kind: 'bind-device',
                  id: device.id,
                  label: device.label ?? device.id,
                  postId: targetPostId,
                })
              }
            >
              Привязать
            </button>
            <button
              type="button"
              className={`compact-action-button ${device.isEnabled ? 'action-destructive' : ''}`}
              disabled={busyKey !== null}
              onClick={() =>
                onReason({
                  kind: 'toggle-device',
                  id: device.id,
                  label: device.label ?? device.id,
                  isEnabled: !device.isEnabled,
                })
              }
            >
              {device.isEnabled ? 'Отключить' : 'Включить'}
            </button>
          </span>
        );
      },
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-devices">
      <PlenkiMetricStrip
        metrics={[
          { id: 'all', label: 'Устройства', value: devices.length },
          {
            id: 'ready',
            label: 'Готовы',
            value: devices.filter((device) => device.isEnabled && device.status === 'ready').length,
            tone: 'success',
          },
          {
            id: 'issues',
            label: 'Требуют внимания',
            value: devices.filter((device) => device.isEnabled && device.status !== 'ready').length,
            tone: 'warning',
          },
          {
            id: 'disabled',
            label: 'Отключены',
            value: devices.filter((device) => !device.isEnabled).length,
            tone: 'muted',
          },
        ]}
      />
      <PlenkiToolbar
        meta={<span>Служебные данные загружаются только по запросу</span>}
        actions={
          <button
            type="button"
            className="compact-action-button action-recommended"
            onClick={onCreate}
          >
            Добавить устройство
          </button>
        }
      />
      <PlenkiDataTable
        caption="Устройства"
        columns={columns}
        rows={devices}
        getRowKey={(device) => device.id}
      />
    </section>
  );
}

function PostsSection({
  posts,
  busyKey,
  onCreate,
  onQuality,
  onReason,
}: {
  posts: AdminPost[];
  busyKey: string | null;
  onCreate: () => void;
  onQuality: (post: AdminPost) => void;
  onReason: (action: ReasonAction) => void;
}) {
  const columns: Array<PlenkiDataTableColumn<AdminPost>> = [
    {
      id: 'post',
      header: 'Пост',
      render: (post) => (
        <span className="admin-live-primary-cell">
          <strong>
            {post.code} · {post.name}
          </strong>
          <small>
            {post.deviceCount} устройств · {statusLabel(post.status)}
          </small>
        </span>
      ),
    },
    {
      id: 'commissioning',
      header: 'Ввод',
      render: (post) => (
        <span className="admin-live-primary-cell">
          <StatusText status={post.commissioningState} />
          <small>{formatDate(post.commissionedAt)}</small>
        </span>
      ),
    },
    {
      id: 'connection',
      header: 'Связь',
      render: (post) => (
        <span className="admin-live-primary-cell">
          <StatusText status={post.connectionState} />
          <small>{`Связь ${formatAge(post.lastSeenAt)}`}</small>
        </span>
      ),
    },
    {
      id: 'compatibility',
      header: 'Версия и совместимость',
      width: '300px',
      render: (post) => (
        <span className="admin-live-primary-cell">
          <StatusText status={post.agentCompatibility} />
          <small>{`${post.agentPackageVersion ?? 'Пакет не сообщён'} · Протокол ${
            post.agentProtocolVersion ?? 'не сообщён'
          }`}</small>
          <small>Commit {shortCommit(post.agentReleaseCommit)}</small>
        </span>
      ),
    },
    {
      id: 'capabilities',
      header: 'Возможности',
      width: '260px',
      render: (post) => (
        <span className="admin-live-primary-cell">
          <StatusText status={post.capabilityReady ? 'complete' : 'incomplete'} />
          <small>
            {post.agentCapabilities.length} из {post.requiredCapabilityCount}
          </small>
          <small>
            {post.missingCapabilities.length > 0
              ? `Нет: ${post.missingCapabilities.join(' · ')}`
              : post.agentCapabilities.join(' · ')}
          </small>
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Действия',
      width: '400px',
      render: (post) => (
        <span className="admin-live-row-actions">
          <button
            type="button"
            className="compact-action-button"
            disabled={busyKey !== null}
            onClick={() => onQuality(post)}
          >
            Качество
          </button>
          {post.commissioningState !== 'commissioned' ? (
            <button
              type="button"
              className="compact-action-button action-recommended"
              disabled={busyKey !== null}
              onClick={() => onReason({ kind: 'commission-post', id: post.id, label: post.code })}
            >
              Ввести
            </button>
          ) : null}
          <button
            type="button"
            className="compact-action-button"
            disabled={busyKey !== null}
            onClick={() => onReason({ kind: 'rotate-post', id: post.id, label: post.code })}
          >
            Новый токен
          </button>
          <button
            type="button"
            className={`compact-action-button ${post.status === 'active' ? 'action-destructive' : ''}`}
            disabled={busyKey !== null}
            onClick={() =>
              onReason({
                kind: 'toggle-post',
                id: post.id,
                label: post.code,
                status: post.status === 'active' ? 'disabled' : 'active',
              })
            }
          >
            {post.status === 'active' ? 'Отключить' : 'Включить'}
          </button>
        </span>
      ),
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-posts">
      <div className="admin-live-callout">
        <strong>Variant B: один автономный пост на станок</strong>
        <span>
          Новый станок добавляется записью поста; gateway-токен показывается только один раз.
        </span>
      </div>
      <PlenkiToolbar
        actions={
          <button
            type="button"
            className="compact-action-button action-recommended"
            onClick={onCreate}
          >
            Добавить пост
          </button>
        }
      />
      <PlenkiDataTable
        caption="Машинные посты"
        columns={columns}
        rows={posts}
        getRowKey={(post) => post.id}
      />
    </section>
  );
}

function OneCSection({
  overview,
  snapshots,
  busyKey,
  onCheck,
  onImport,
  onRetry,
  onRaw,
}: {
  overview: AdminLiveResources['oneC'];
  snapshots: OneCSnapshot[];
  busyKey: string | null;
  onCheck: () => void;
  onImport: (subjectType: string) => void;
  onRetry: (journalId: string) => void;
  onRaw: (snapshot: OneCSnapshot) => void;
}) {
  const snapshotColumns: Array<PlenkiDataTableColumn<OneCSnapshot>> = [
    {
      id: 'subject',
      header: 'Сущность',
      render: (snapshot) => snapshot.subjectType ?? 'не определено',
    },
    { id: 'external', header: 'External ID', render: (snapshot) => snapshot.externalId ?? '—' },
    { id: 'source', header: 'Источник', render: (snapshot) => snapshot.sourceKind },
    {
      id: 'freshness',
      header: 'Актуальность',
      render: (snapshot) => <StatusText status={snapshot.staleness} />,
    },
    {
      id: 'time',
      header: 'Получено',
      render: (snapshot) => formatDate(snapshot.importedAt ?? snapshot.createdAt),
    },
    {
      id: 'raw',
      header: 'Диагностика',
      width: '140px',
      render: (snapshot) => (
        <button
          type="button"
          className="compact-action-button"
          data-testid="admin-open-raw"
          onClick={() => onRaw(snapshot)}
        >
          Открыть raw
        </button>
      ),
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-onec">
      <div className="admin-live-split">
        <div className="admin-live-callout">
          <strong>Соединение 1С</strong>
          <span>
            {overview.connection
              ? `${overview.connection.status} · ${overview.connection.latencyMs ?? 0} мс`
              : 'Проверка ещё не выполнялась'}
          </span>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={busyKey !== null}
            onClick={onCheck}
          >
            Проверить соединение
          </button>
        </div>
        <div className="admin-live-callout">
          <strong>Импорт по сущностям</strong>
          <span className="admin-live-row-actions">
            {['counterparty', 'payment', 'shipment', 'stock'].map((subject) => (
              <button
                key={subject}
                type="button"
                className="compact-action-button"
                disabled={busyKey !== null}
                onClick={() => onImport(subject)}
              >
                {oneCSubjectLabel(subject)}
              </button>
            ))}
          </span>
        </div>
      </div>
      {overview.journals.some(
        (journal) => journal.status === 'error' || journal.status === 'manual_review',
      ) ? (
        <section className="admin-live-journals" aria-label="Ошибки синхронизации 1С">
          <h2>Требуют повтора</h2>
          {overview.journals
            .filter((journal) => journal.status === 'error' || journal.status === 'manual_review')
            .map((journal) => (
              <div key={journal.id}>
                <span>
                  <strong>{journal.entity}</strong>
                  <small>{journal.recovery ?? journal.status}</small>
                </span>
                <button
                  type="button"
                  className="compact-action-button"
                  disabled={busyKey !== null}
                  onClick={() => onRetry(journal.id)}
                >
                  Повторить
                </button>
              </div>
            ))}
        </section>
      ) : null}
      <PlenkiDataTable
        caption="Безопасные снимки 1С"
        columns={snapshotColumns}
        rows={snapshots}
        getRowKey={(snapshot) => snapshot.id}
      />
    </section>
  );
}

function PlatformHealthSection({
  health,
  incidents,
  busyKey,
  onCheck,
}: {
  health: PlatformHealth;
  incidents: AdminIncident[];
  busyKey: string | null;
  onCheck: () => void;
}) {
  const components = Object.entries(health.components ?? {}).filter(
    ([name]) => !hasOneCReference(name),
  );
  return (
    <section className="admin-live-section" data-testid="admin-platform-health">
      <div className="admin-live-health-head">
        <div>
          <span>Общее состояние</span>
          <strong>
            <StatusText status={health.status} />
          </strong>
          <small>
            {health.checkedAt
              ? formatDate(health.checkedAt)
              : 'Новая полная проверка ещё не выполнялась'}
          </small>
        </div>
        <button
          type="button"
          className="compact-action-button action-recommended"
          disabled={busyKey !== null}
          onClick={onCheck}
        >
          Проверить платформу
        </button>
      </div>
      <div className="admin-live-component-grid">
        {components.length > 0 ? (
          components.map(([name, component]) => (
            <article key={name}>
              <span>{componentLabel(name)}</span>
              <strong>
                <StatusText status={component.status} />
              </strong>
              <small>{component.latencyMs} мс</small>
              <dl>
                {Object.entries(component)
                  .filter(([key]) => !['status', 'latencyMs'].includes(key))
                  .slice(0, 4)
                  .map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{String(value ?? '—')}</dd>
                    </div>
                  ))}
              </dl>
            </article>
          ))
        ) : (
          <div className="admin-live-empty">
            Запустите проверку, чтобы получить состояние компонентов.
          </div>
        )}
      </div>
      {incidents.length > 0 ? (
        <div className="admin-live-callout tone-warning">
          <strong>{incidents.length} незакрытых инцидентов</strong>
          <span>Откройте раздел «Инциденты» для разбора и повторной проверки.</span>
        </div>
      ) : null}
    </section>
  );
}

export function visibleAdminIncidents(
  incidents: readonly AdminIncident[],
  status: 'all' | AdminIncident['status'],
  selectedIncidentId: string | null,
) {
  const productIncidents = incidents.filter((incident) => !isOneCRelatedIncident(incident));
  const filtered =
    status === 'all'
      ? productIncidents
      : productIncidents.filter((incident) => incident.status === status);
  if (!selectedIncidentId) return filtered;
  const selected = productIncidents.find((incident) => incident.id === selectedIncidentId);
  return selected
    ? [selected, ...filtered.filter((incident) => incident.id !== selectedIncidentId)]
    : filtered;
}

function isOneCRelatedIncident(incident: AdminIncident) {
  return hasOneCReference(
    incident.scope,
    incident.targetType,
    incident.targetId,
    incident.title,
    incident.message,
    incident.recovery,
  );
}

function hasOneCReference(...values: Array<string | null | undefined>) {
  return values.some((value) => /(?:1[сc]|onec)/iu.test(value ?? ''));
}

function IncidentsSection({
  incidents,
  selectedIncidentId,
  busyKey,
  onReason,
  onRecheck,
}: {
  incidents: AdminIncident[];
  selectedIncidentId: string | null;
  busyKey: string | null;
  onReason: (action: ReasonAction) => void;
  onRecheck: (incident: AdminIncident) => void;
}) {
  const [status, setStatus] = useState<'all' | AdminIncident['status']>('all');
  const selectedIncidentRef = useRef<HTMLSpanElement | null>(null);
  const focusedIncidentIdRef = useRef<string | null>(null);
  const selectedIncidentExists = incidents.some((incident) => incident.id === selectedIncidentId);
  const visible = visibleAdminIncidents(incidents, status, selectedIncidentId);

  useEffect(() => {
    if (!selectedIncidentId || !selectedIncidentExists) {
      if (!selectedIncidentId) focusedIncidentIdRef.current = null;
      return undefined;
    }
    if (focusedIncidentIdRef.current === selectedIncidentId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      selectedIncidentRef.current?.focus({ preventScroll: true });
      selectedIncidentRef.current?.scrollIntoView({ block: 'nearest' });
      focusedIncidentIdRef.current = selectedIncidentId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedIncidentExists, selectedIncidentId]);

  const columns: Array<PlenkiDataTableColumn<AdminIncident>> = [
    {
      id: 'incident',
      header: 'Инцидент',
      render: (incident) => {
        const selected = incident.id === selectedIncidentId;
        return (
          <span
            className={`admin-live-primary-cell ${selected ? 'is-notification-target' : ''}`}
            data-incident-id={incident.id}
            tabIndex={selected ? -1 : undefined}
            ref={selected ? selectedIncidentRef : undefined}
          >
            <strong>{incident.title}</strong>
            <small>{incident.message}</small>
          </span>
        );
      },
    },
    { id: 'scope', header: 'Контур', render: (incident) => incident.scope },
    {
      id: 'severity',
      header: 'Критичность',
      render: (incident) => <StatusText status={incident.severity} />,
    },
    {
      id: 'status',
      header: 'Статус',
      render: (incident) => <StatusText status={incident.status} />,
    },
    { id: 'seen', header: 'Обновлён', render: (incident) => formatDate(incident.lastSeenAt) },
    {
      id: 'actions',
      header: 'Действия',
      width: '330px',
      render: (incident) => (
        <span className="admin-live-row-actions">
          <button
            type="button"
            className="compact-action-button"
            disabled={busyKey !== null}
            onClick={() => onRecheck(incident)}
          >
            Перепроверить
          </button>
          {incident.status === 'open' ? (
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null}
              onClick={() =>
                onReason({ kind: 'ack-incident', id: incident.id, label: incident.title })
              }
            >
              Принять
            </button>
          ) : null}
          {incident.status !== 'resolved' ? (
            <button
              type="button"
              className="compact-action-button"
              disabled={busyKey !== null}
              onClick={() =>
                onReason({ kind: 'resolve-incident', id: incident.id, label: incident.title })
              }
            >
              Закрыть
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <section className="admin-live-section" data-testid="admin-incidents">
      <PlenkiToolbar
        filters={[
          {
            id: 'all',
            label: 'Все',
            count: incidents.length,
            active: status === 'all',
            onClick: () => setStatus('all'),
          },
          {
            id: 'open',
            label: 'Открыты',
            count: incidents.filter((item) => item.status === 'open').length,
            active: status === 'open',
            onClick: () => setStatus('open'),
          },
          {
            id: 'acknowledged',
            label: 'В работе',
            count: incidents.filter((item) => item.status === 'acknowledged').length,
            active: status === 'acknowledged',
            onClick: () => setStatus('acknowledged'),
          },
          {
            id: 'resolved',
            label: 'Закрыты',
            count: incidents.filter((item) => item.status === 'resolved').length,
            active: status === 'resolved',
            onClick: () => setStatus('resolved'),
          },
        ]}
      />
      <PlenkiDataTable
        caption="Операционные инциденты"
        columns={columns}
        rows={visible}
        getRowKey={(incident) => incident.id}
        isRowSelected={(incident) => incident.id === selectedIncidentId}
      />
    </section>
  );
}

function AuditSection({ resources }: { resources: AdminLiveResources }) {
  const productEvents = resources.accessEvents.items.filter(
    (event) => !hasOneCReference(event.type, event.objectId, event.label, event.reason),
  );
  const columns: Array<PlenkiDataTableColumn<AdminLiveResources['accessEvents']['items'][number]>> =
    [
      {
        id: 'time',
        header: 'Время',
        width: '180px',
        render: (event) => formatDate(event.createdAt),
      },
      {
        id: 'event',
        header: 'Событие',
        render: (event) => (
          <span className="admin-live-primary-cell">
            <strong>{event.type}</strong>
            <small>{event.objectId ?? 'системное событие'}</small>
          </span>
        ),
      },
      { id: 'actor', header: 'Инициатор', render: (event) => roleLabel(event.actorRole) },
      { id: 'reason', header: 'Причина', render: (event) => event.reason ?? '—' },
    ];
  return (
    <section className="admin-live-section" data-testid="admin-audit">
      <div className="admin-live-callout">
        <strong>История доступа</strong>
        <span>Изменения не перезаписывают прошлые факты; коррекция создаёт новое событие.</span>
      </div>
      <PlenkiDataTable
        caption="История административных действий"
        columns={columns}
        rows={productEvents}
        getRowKey={(event) => event.id}
      />
    </section>
  );
}

function CreateUserModal({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (input: { login: string; displayName: string; role: AdminRole }) => void;
  busy: boolean;
}) {
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<AdminRole>('operator');
  return (
    <PlenkiModal
      title="Добавить аккаунт"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={busy || !login.trim() || !displayName.trim()}
            onClick={() => onSubmit({ login: login.trim(), displayName: displayName.trim(), role })}
          >
            Создать
          </button>
        </>
      }
    >
      <div className="admin-live-form">
        <label>
          <span>Логин</span>
          <input
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            autoComplete="off"
          />
        </label>
        <label>
          <span>Имя сотрудника</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          <span>Базовая роль</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
            {ADMIN_ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </PlenkiModal>
  );
}

function UserAccessModal({
  user,
  templates,
  catalog,
  onClose,
  onSubmit,
  onApply,
  busy,
}: {
  user: AdminUser;
  templates: AdminAccessTemplate[];
  catalog: AdminCapabilityCatalogItem[];
  onClose: () => void;
  onSubmit: (input: {
    role: AdminRole;
    grants: AdminCapability[];
    denials: AdminCapability[];
    reason: string;
  }) => void;
  onApply: (input: { templateId: string; reason: string }) => void;
  busy: boolean;
}) {
  const [role, setRole] = useState(user.role);
  const [grants, setGrants] = useState<AdminCapability[]>(user.grants);
  const [denials, setDenials] = useState<AdminCapability[]>(user.denials);
  const [reason, setReason] = useState('');
  const availableTemplates = useMemo(
    () => templates.filter((item) => item.role === role && item.setupStatus === 'active'),
    [role, templates],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    () => availableTemplates.find((item) => item.isSystem)?.id ?? availableTemplates[0]?.id ?? '',
  );
  const conflicts = capabilityConflictKeys(grants, denials);
  const selectedTemplate =
    availableTemplates.find((item) => item.id === selectedTemplateId) ?? availableTemplates[0];

  useEffect(() => {
    if (availableTemplates.some((item) => item.id === selectedTemplateId)) return;
    setSelectedTemplateId(
      availableTemplates.find((item) => item.isSystem)?.id ?? availableTemplates[0]?.id ?? '',
    );
  }, [availableTemplates, selectedTemplateId]);

  return (
    <PlenkiModal
      title={`Права: ${user.login}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button"
            data-admin-apply-template
            disabled={busy || !selectedTemplate || reason.trim().length < 3}
            onClick={() => {
              if (!selectedTemplate) return;
              onApply({ templateId: selectedTemplate.id, reason: reason.trim() });
            }}
          >
            Применить шаблон
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={
              busy || catalog.length === 0 || conflicts.length > 0 || reason.trim().length < 3
            }
            onClick={() => onSubmit({ role, grants, denials, reason: reason.trim() })}
          >
            Сохранить и отозвать сессии
          </button>
        </>
      }
    >
      <div className="admin-live-form">
        <label>
          <span>Роль</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
            {ADMIN_ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="admin-live-form-note">
          Сейчас действует {user.capabilities.length} разрешений. После сохранения или применения
          шаблона активные сессии пользователя будут отозваны.
        </div>
        <label>
          <span>Шаблон для применения</span>
          <select
            value={selectedTemplate?.id ?? ''}
            disabled={availableTemplates.length === 0}
            onChange={(event) => setSelectedTemplateId(event.target.value)}
          >
            {availableTemplates.length === 0 ? (
              <option value="">Нет активных шаблонов для роли</option>
            ) : null}
            {availableTemplates.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.isSystem ? ' · системный' : ''}
              </option>
            ))}
          </select>
        </label>
        <AdminCapabilityEditor
          catalog={catalog}
          role={role}
          grants={grants}
          denials={denials}
          onGrantsChange={setGrants}
          onDenialsChange={setDenials}
        />
        <label>
          <span>Причина изменения</span>
          <textarea
            aria-label="Причина применения шаблона"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
          />
        </label>
      </div>
    </PlenkiModal>
  );
}

function SessionsModal({
  user,
  busy,
  onClose,
  onRevoke,
}: {
  user: AdminUser;
  busy: boolean;
  onClose: () => void;
  onRevoke: (input: { sessionId?: string; reason: string }) => void;
}) {
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>();
  const [reason, setReason] = useState('');

  useEffect(() => {
    let active = true;
    void fetchAdminUserSessions(user.id)
      .then((value) => {
        if (active) setSessions(value);
      })
      .catch((caught) => {
        if (active) setLoadError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [user.id]);

  const activeSessions =
    sessions?.filter(
      (session) => !session.revokedAt && new Date(session.expiresAt).getTime() > Date.now(),
    ) ?? [];

  return (
    <PlenkiModal
      title={`Сессии: ${user.login}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="button"
            className="compact-action-button action-destructive"
            disabled={busy || activeSessions.length === 0 || reason.trim().length < 3}
            onClick={() => onRevoke({ sessionId: selectedSessionId, reason: reason.trim() })}
          >
            {selectedSessionId ? 'Отозвать выбранную' : 'Отозвать все активные'}
          </button>
        </>
      }
    >
      <div className="admin-live-form">
        <div className="admin-live-form-note">
          Показаны только безопасные метаданные. Токены и их хэши скрыты.
        </div>
        {loadError ? (
          <div className="admin-live-message tone-critical" role="alert">
            {loadError}
          </div>
        ) : null}
        {!sessions && !loadError ? <span>Загрузка сессий…</span> : null}
        {sessions ? (
          <label>
            <span>Активная сессия · пустое значение означает все</span>
            <select
              value={selectedSessionId ?? ''}
              onChange={(event) => setSelectedSessionId(event.target.value || undefined)}
            >
              <option value="">Все активные сессии ({activeSessions.length})</option>
              {activeSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {formatDate(session.lastSeenAt ?? session.createdAt)} ·{' '}
                  {session.ip ?? 'IP не определён'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Причина отзыва</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
        </label>
      </div>
    </PlenkiModal>
  );
}

function CreateTemplateModal({
  catalog,
  onClose,
  onSubmit,
  busy,
}: {
  catalog: AdminCapabilityCatalogItem[];
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    role: AdminRole;
    setupStatus: 'draft' | 'active';
    grants: AdminCapability[];
    denials: AdminCapability[];
    reason: string;
  }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<AdminRole>('operator');
  const [setupStatus, setSetupStatus] = useState<'draft' | 'active'>('draft');
  const [grants, setGrants] = useState<AdminCapability[]>([]);
  const [denials, setDenials] = useState<AdminCapability[]>([]);
  const [reason, setReason] = useState('');
  const conflicts = capabilityConflictKeys(grants, denials);
  return (
    <PlenkiModal
      title="Новый шаблон роли"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={
              busy ||
              catalog.length === 0 ||
              conflicts.length > 0 ||
              !name.trim() ||
              reason.trim().length < 3
            }
            onClick={() =>
              onSubmit({
                name: name.trim(),
                role,
                setupStatus,
                grants,
                denials,
                reason: reason.trim(),
              })
            }
          >
            Создать шаблон
          </button>
        </>
      }
    >
      <div className="admin-live-form two-columns">
        <label>
          <span>Название</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Роль</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
            {ADMIN_ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Состояние</span>
          <select
            value={setupStatus}
            onChange={(event) => setSetupStatus(event.target.value as 'draft' | 'active')}
          >
            <option value="draft">Черновик</option>
            <option value="active">Активен</option>
          </select>
        </label>
        <div className="is-wide">
          <AdminCapabilityEditor
            catalog={catalog}
            role={role}
            grants={grants}
            denials={denials}
            onGrantsChange={setGrants}
            onDenialsChange={setDenials}
          />
        </div>
        <label className="is-wide">
          <span>Причина</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
        </label>
      </div>
    </PlenkiModal>
  );
}

function TemplateModal({
  template,
  catalog,
  onClose,
  onSubmit,
  busy,
}: {
  template: AdminAccessTemplate;
  catalog: AdminCapabilityCatalogItem[];
  onClose: () => void;
  onSubmit: (input: {
    expectedVersion: number;
    name: string;
    role: AdminRole;
    setupStatus: 'draft' | 'active';
    grants: AdminCapability[];
    denials: AdminCapability[];
    reason: string;
  }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState(template.name);
  const [role, setRole] = useState(template.role);
  const [setupStatus, setSetupStatus] = useState(template.setupStatus);
  const [grants, setGrants] = useState<AdminCapability[]>(template.capabilityGrants);
  const [denials, setDenials] = useState<AdminCapability[]>(template.capabilityDenials);
  const [reason, setReason] = useState('');
  const conflicts = capabilityConflictKeys(grants, denials);
  return (
    <PlenkiModal
      title={`Шаблон v${template.version}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={
              busy ||
              catalog.length === 0 ||
              conflicts.length > 0 ||
              !name.trim() ||
              reason.trim().length < 3
            }
            onClick={() =>
              onSubmit({
                expectedVersion: template.version,
                name: name.trim(),
                role,
                setupStatus,
                grants,
                denials,
                reason: reason.trim(),
              })
            }
          >
            Сохранить новую версию
          </button>
        </>
      }
    >
      <div className="admin-live-form two-columns">
        <label>
          <span>Название</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Роль</span>
          <select value={role} onChange={(event) => setRole(event.target.value as AdminRole)}>
            {ADMIN_ROLES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Состояние</span>
          <select
            value={setupStatus}
            onChange={(event) => setSetupStatus(event.target.value as 'draft' | 'active')}
          >
            <option value="draft">Черновик</option>
            <option value="active">Активен</option>
          </select>
        </label>
        <div className="is-wide">
          <AdminCapabilityEditor
            catalog={catalog}
            role={role}
            grants={grants}
            denials={denials}
            onGrantsChange={setGrants}
            onDenialsChange={setDenials}
          />
        </div>
        <label className="is-wide">
          <span>Причина</span>
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
        </label>
      </div>
    </PlenkiModal>
  );
}

function CreateDeviceModal({
  posts,
  onClose,
  onSubmit,
  busy,
}: {
  posts: AdminPost[];
  onClose: () => void;
  onSubmit: (input: {
    code: string;
    label: string;
    kind: AdminDevice['kind'];
    connectionKind?: string;
    postId?: string;
  }) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<AdminDevice['kind']>('scale');
  const [connectionKind, setConnectionKind] = useState('usb-rs232');
  const [postId, setPostId] = useState('');
  return (
    <PlenkiModal
      title="Добавить устройство"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={busy || !code.trim() || !label.trim()}
            onClick={() =>
              onSubmit({
                code: code.trim(),
                label: label.trim(),
                kind,
                connectionKind: connectionKind.trim() || undefined,
                postId: postId || undefined,
              })
            }
          >
            Добавить
          </button>
        </>
      }
    >
      <div className="admin-live-form two-columns">
        <label>
          <span>Код</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="SCALE-6"
          />
        </label>
        <label>
          <span>Название</span>
          <input value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span>Тип</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as AdminDevice['kind'])}
          >
            <option value="scale">Весы</option>
            <option value="scanner">Сканер</option>
            <option value="printer">Принтер</option>
          </select>
        </label>
        <label>
          <span>Подключение</span>
          <input
            value={connectionKind}
            onChange={(event) => setConnectionKind(event.target.value)}
          />
        </label>
        <label className="is-wide">
          <span>Пост · можно назначить позже</span>
          <select value={postId} onChange={(event) => setPostId(event.target.value)}>
            <option value="">Без привязки</option>
            {posts.map((post) => (
              <option key={post.id} value={post.id}>
                {post.code} · {post.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </PlenkiModal>
  );
}

function CreatePostModal({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (input: { code: string; name: string; status?: string }) => void;
  busy: boolean;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <PlenkiModal
      title="Добавить машинный пост"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={busy || !code.trim() || !name.trim()}
            onClick={() => onSubmit({ code: code.trim(), name: name.trim(), status: 'active' })}
          >
            Добавить
          </button>
        </>
      }
    >
      <div className="admin-live-form">
        <label>
          <span>Код поста</span>
          <input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder="POST-6"
          />
        </label>
        <label>
          <span>Название станка</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
    </PlenkiModal>
  );
}

function ReasonModal({
  action,
  busy,
  onClose,
  onSubmit,
}: {
  action: ReasonAction;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <PlenkiModal
      title={reasonActionTitle(action)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="compact-action-button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="compact-action-button action-recommended"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onSubmit(reason.trim())}
          >
            Подтвердить
          </button>
        </>
      }
    >
      <div className="admin-live-form">
        <div className="admin-live-form-note">
          Объект: {action.label}. Причина сохранится в истории.
        </div>
        <label>
          <span>Причина</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={4}
            autoFocus
          />
        </label>
      </div>
    </PlenkiModal>
  );
}

function TemporarySecretModal({
  secret,
  onClose,
}: {
  secret: TemporarySecret;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(secret.value);
    setCopied(true);
  }
  return (
    <PlenkiModal
      title={secret.kind === 'password' ? 'Временный пароль' : 'Новый gateway-токен'}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="compact-action-button action-recommended"
          onClick={onClose}
        >
          Я сохранил, закрыть
        </button>
      }
    >
      <div className="admin-live-secret">
        <strong>Показывается только один раз</strong>
        <span>{secret.subject}</span>
        <code>{secret.value}</code>
        <button type="button" className="compact-action-button" onClick={() => void copy()}>
          {copied ? 'Скопировано' : 'Скопировать'}
        </button>
        <p>После закрытия значение удалится из памяти интерфейса и не попадёт в localStorage.</p>
      </div>
    </PlenkiModal>
  );
}

function RawSnapshotModal({
  state,
  onClose,
}: {
  state: NonNullable<RawState>;
  onClose: () => void;
}) {
  return (
    <PlenkiModal
      title={`Raw 1С: ${state.snapshot.externalId ?? state.snapshot.id}`}
      onClose={onClose}
      footer={
        <button type="button" className="compact-action-button" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <div className="admin-live-raw">
        <div className="admin-live-message tone-warning">
          Служебная диагностика. Не передавайте эти данные другим ролям.
        </div>
        {state.loading ? <span>Загрузка служебных данных…</span> : null}
        {state.error ? <div role="alert">{state.error}</div> : null}
        {state.value ? <pre>{JSON.stringify(state.value, null, 2)}</pre> : null}
      </div>
    </PlenkiModal>
  );
}

function QualityModal({
  state,
  onClose,
}: {
  state: NonNullable<QualityState>;
  onClose: () => void;
}) {
  const quality = state.value?.quality;
  return (
    <PlenkiModal
      title={`Качество связи: ${state.label}`}
      onClose={onClose}
      footer={
        <button type="button" className="compact-action-button" onClick={onClose}>
          Закрыть
        </button>
      }
    >
      <div className="admin-live-form" data-testid="admin-quality">
        {state.loading ? <span>Загрузка метрик…</span> : null}
        {state.error ? (
          <div className="admin-live-message tone-critical" role="alert">
            {state.error}
          </div>
        ) : null}
        {quality ? (
          <>
            <PlenkiMetricStrip
              metrics={[
                { id: 'freshness', label: 'Свежесть', value: statusLabel(quality.freshness) },
                {
                  id: 'success',
                  label: 'Успешность',
                  value:
                    quality.successRatePct === null ? 'нет данных' : `${quality.successRatePct}%`,
                },
                {
                  id: 'latency',
                  label: 'Медиана',
                  value:
                    quality.medianLatencyMs === null
                      ? 'нет данных'
                      : `${quality.medianLatencyMs} мс`,
                },
                {
                  id: 'incidents',
                  label: 'Инциденты',
                  value: quality.openIncidentCount,
                  tone: quality.openIncidentCount > 0 ? 'warning' : 'success',
                },
              ]}
            />
            <div className="admin-live-form-note">
              Проверок: {quality.totalChecks}; успешных: {quality.successfulChecks}. Метрики
              рассчитаны по сохранённым проверкам.
            </div>
          </>
        ) : null}
      </div>
    </PlenkiModal>
  );
}

function AdminLoading() {
  return (
    <div className="admin-live-loading" role="status">
      <ix-icon name="history" size="24" />
      <span>Загружаем состояние системы…</span>
    </div>
  );
}

function StatusText({ status }: { status: string }) {
  return (
    <span className={`admin-live-status tone-${statusTone(status)}`}>{statusLabel(status)}</span>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Операция не выполнена. Повторите попытку.';
}

function roleLabel(role: AdminRole) {
  return ADMIN_ROLES.find((item) => item.id === role)?.label ?? role;
}

function sectionTitle(section: string) {
  if (section === 'Доступы') return 'Аккаунты и доступы';
  if (section === '1С' || section === 'Источники') return 'Связь с 1С';
  if (section === 'Проблемы / история') return 'История администрирования';
  return section;
}

function reasonActionTitle(action: ReasonAction) {
  const labels: Record<ReasonAction['kind'], string> = {
    'block-user': 'Заблокировать аккаунт',
    'reactivate-user': 'Восстановить аккаунт',
    'reset-password': 'Сбросить пароль',
    'bind-device': 'Изменить привязку устройства',
    'toggle-device':
      action.kind === 'toggle-device' && action.isEnabled
        ? 'Включить устройство'
        : 'Отключить устройство',
    'recover-device': 'Выполнить recovery',
    'toggle-post':
      action.kind === 'toggle-post' && action.status === 'active'
        ? 'Включить пост'
        : 'Отключить пост',
    'commission-post': 'Ввести пост в эксплуатацию',
    'rotate-post': 'Заменить gateway-токен',
    'ack-incident': 'Принять инцидент',
    'resolve-incident': 'Закрыть инцидент',
  };
  return labels[action.kind];
}

function statusTone(status: string) {
  if (
    [
      'ready',
      'active',
      'online',
      'fresh',
      'resolved',
      'passed',
      'commissioned',
      'compatible',
      'complete',
    ].includes(status)
  )
    return 'success';
  if (
    ['unavailable', 'offline', 'critical', 'failed', 'error', 'blocked', 'unsupported'].includes(
      status,
    )
  )
    return 'critical';
  if (
    [
      'degraded',
      'warning',
      'unstable',
      'open',
      'password_setup',
      'draft',
      'stale',
      'acknowledged',
      'uncommissioned',
      'upgrade_required',
      'incomplete',
    ].includes(status)
  )
    return 'warning';
  return 'muted';
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    ready: 'Готово',
    active: 'Активен',
    online: 'Онлайн',
    fresh: 'Актуально',
    resolved: 'Закрыт',
    passed: 'Пройдено',
    unavailable: 'Недоступно',
    offline: 'Офлайн',
    critical: 'Критично',
    failed: 'Ошибка',
    error: 'Ошибка',
    blocked: 'Заблокирован',
    degraded: 'Деградация',
    warning: 'Внимание',
    unstable: 'Нестабильно',
    open: 'Открыт',
    password_setup: 'Первый вход',
    draft: 'Черновик',
    stale: 'Устарело',
    acknowledged: 'В работе',
    disabled: 'Отключено',
    unknown: 'Не проверено',
    checked: 'Проверено',
    info: 'Информация',
    misconfigured: 'Не настроено',
    test_failed: 'Тест не пройден',
    manual_review: 'Ручная проверка',
    waiting: 'Ожидание',
    commissioned: 'Введён',
    uncommissioned: 'Не введён',
    compatible: 'Совместим',
    upgrade_required: 'Нужно обновить',
    unsupported: 'Не поддерживается',
    complete: 'Полный набор',
    incomplete: 'Неполный набор',
  };
  return labels[status] ?? status;
}

function deviceKindLabel(kind: AdminDevice['kind']) {
  return kind === 'scale' ? 'Весы' : kind === 'scanner' ? 'Сканер' : 'Принтер';
}

function oneCSubjectLabel(subject: string) {
  const labels: Record<string, string> = {
    counterparty: 'Контрагенты',
    payment: 'Оплаты',
    shipment: 'Отгрузки',
    stock: 'Остатки',
  };
  return labels[subject] ?? subject;
}

function componentLabel(component: string) {
  const labels: Record<string, string> = {
    database: 'PostgreSQL',
    onec: '1С',
    gateway: 'Gateway и посты',
    background: 'Фоновые операции',
  };
  return labels[component] ?? component;
}

function sectionResourceError(resources: AdminLiveResources, section: string) {
  const keys: Array<keyof AdminLiveResources['errors']> =
    section === 'Виды сырья'
      ? []
      : section === 'Доступы'
        ? ['users', 'roleTemplates', 'capabilities']
        : section === 'Шаблоны ролей'
          ? ['roleTemplates', 'capabilities']
          : section === 'Устройства'
            ? ['devices', 'posts']
            : section === 'Посты'
              ? ['posts']
              : section === '1С' || section === 'Источники'
                ? ['oneC', 'snapshots']
                : section === 'Состояние платформы'
                  ? ['platformHealth', 'incidents']
                  : section === 'Инциденты'
                    ? ['incidents']
                    : ['accessEvents'];
  const messages = Array.from(
    new Set(
      keys.map((key) => resources.errors[key]).filter((message): message is string => !!message),
    ),
  );
  return messages.length > 0 ? `Часть данных недоступна: ${messages.join(' · ')}` : null;
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'нет данных';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatAge(value: string | null | undefined) {
  if (!value) return 'не подтверждена';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'не подтверждена';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds} сек назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч назад`;
}

function shortCommit(value: string | null) {
  return value ? value.slice(0, 12) : 'не сообщён';
}

function deviceDriverLabel(device: AdminDevice) {
  if (!device.driverName) return 'Драйвер не сообщён';
  return device.driverVersion
    ? `${device.driverName} · v${device.driverVersion}`
    : device.driverName;
}
