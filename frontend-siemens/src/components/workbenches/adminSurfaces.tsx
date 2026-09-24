import { useEffect, useState } from 'react';
import { getRoleConfig } from '../../domain/selectors';
import type { FactScope, PermissionCapability, RoleAssignmentDraft, RoleTemplate, UserAccessEntry } from '../../domain/types';
import { PlenkiDataTable, PlenkiDrawer, PlenkiMetricStrip, PlenkiModal, PlenkiSwitch, PlenkiToolbar, type PlenkiDataTableColumn } from '../plenki-ui/PlenkiPrimitives';

export type AdminHistoryItem = {
  id: string;
  time: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
};

function accessStatusCopy(status: UserAccessEntry['status']) {
  if (status === 'blocked') return 'Отозван';
  return 'Доступ выдан';
}

const individualCapabilityOptions: Array<{ id: PermissionCapability; label: string }> = [
  { id: 'audit.view', label: 'История и аудит' },
  { id: 'qr.history.view', label: 'История QR' },
  { id: 'warehouse.override', label: 'Складские исключения' },
  { id: 'penalty.view', label: 'Штрафы' },
  { id: 'material_cost.view', label: 'Себестоимость сырья' },
  { id: 'operator.payroll.view_self', label: 'Свои начисления оператора' },
  { id: 'finance.view_safe', label: 'Финансовый обзор' },
  { id: 'admin.raw_diagnostics', label: 'Служебная диагностика' },
];

function capabilityLabel(capability: PermissionCapability) {
  return individualCapabilityOptions.find((item) => item.id === capability)?.label ?? capability;
}

function scopeCopy(scope: string) {
  const labels: Record<string, string> = {
    common: 'Общие данные',
    commercial: 'Коммерция',
    production: 'Производство',
    finance: 'Финансы',
    director: 'Директор',
    operator: 'Оператор',
    warehouse: 'Склад',
    admin: 'Админ',
    sensitiveFinance: 'Чувствительные финансы',
    legal: 'Юридические данные клиента',
    recipeAnalytics: 'Рецептурная аналитика',
    rawDiagnostics: 'Служебная диагностика',
  };
  return labels[scope] ?? scope;
}

function roleTemplateHiddenCopy(template: RoleTemplate) {
  return template.hiddenScopes.length > 0 ? template.hiddenScopes.map(scopeCopy).join(', ') : 'Нет скрытых групп';
}

function templateSetupCopy(template: RoleTemplate) {
  return template.setupStatus === 'needs_setup' ? 'Требует настройки' : 'Шаблон выбран';
}

function templateRecoveryCopy(template: RoleTemplate) {
  return template.setupStatus === 'needs_setup'
    ? 'Проверить перед назначением.'
    : 'Готов к выдаче.';
}

function templateRiskCopy(template: RoleTemplate) {
  if (template.hiddenScopes.includes('sensitiveFinance')) return 'Финансовые ограничения включены';
  if (template.hiddenScopes.includes('recipeAnalytics')) return 'Рецептурная аналитика скрыта';
  if (template.hiddenScopes.includes('rawDiagnostics')) return 'Служебная диагностика скрыта';
  return template.hiddenScopes.length > 0 ? 'Границы доступа заданы' : 'Без скрытых групп';
}

function compactScopeList(items: string[], max = 4) {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `+${items.length - max}`];
}

const editableHiddenScopes: FactScope[] = [
  'finance',
  'director',
  'operator',
  'warehouse',
  'sensitiveFinance',
  'legal',
  'recipeAnalytics',
  'rawDiagnostics',
];

function actionText(template: RoleTemplate) {
  return template.allowedActions.join('\n');
}

function parseActionText(value: string) {
  return value
    .split(/\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function cloneTemplate(template: RoleTemplate): RoleTemplate {
  const suffix = Date.now().toString(36);
  return {
    ...template,
    id: `${template.id}-draft-${suffix}`,
    name: `${template.name} · черновик`,
    setupStatus: 'needs_setup',
    visibleSections: [...template.visibleSections],
    hiddenScopes: [...template.hiddenScopes],
    capabilities: [...template.capabilities],
    allowedActions: [...template.allowedActions],
    summary: `${template.summary} Черновик требует проверки перед назначением.`,
  };
}

export function AdminUsersSurface({
  users,
  templates,
  draft,
  onDraftChange,
  onAssign,
  onUserSave,
  onRevokeAccess,
}: {
  users: UserAccessEntry[];
  templates: RoleTemplate[];
  draft: RoleAssignmentDraft;
  onDraftChange: (draft: RoleAssignmentDraft) => void;
  onAssign: () => void;
  onUserSave: (entry: UserAccessEntry) => void;
  onRevokeAccess: (entry: UserAccessEntry) => void;
}) {
  const selectedTemplate = templates.find((template) => template.id === draft.roleTemplateId) ?? templates[0];
  const canAssign = draft.email.trim().includes('@') && Boolean(selectedTemplate);
  const activeUsers = users.filter((user) => user.status !== 'blocked').length;
  const revokedUsers = users.length - activeUsers;
  const [accessDialog, setAccessDialog] = useState<'assign' | 'edit' | null>(null);
  const [editingUser, setEditingUser] = useState<UserAccessEntry | null>(null);
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userStatusFilter, setUserStatusFilter] = useState<'all' | 'active' | 'blocked'>('all');
  const [accessFeedback, setAccessFeedback] = useState<string | null>(null);

  const visibleUsers = users.filter((user) => {
    const template = templates.find((item) => item.id === user.roleTemplateId);
    const matchesStatus = userStatusFilter === 'all' || user.status === userStatusFilter;
    const query = userSearchQuery.trim().toLowerCase();
    const matchesSearch = !query || [
      user.email,
      user.assignedBy,
      template?.name ?? '',
      template ? getRoleConfig(template.role).label : '',
      ...(user.extraCapabilities ?? []).map(capabilityLabel),
    ].some((value) => value.toLowerCase().includes(query));
    return matchesStatus && matchesSearch;
  });

  function closeDialog() {
    setAccessDialog(null);
    setEditingUser(null);
  }

  function openEditUser(user: UserAccessEntry) {
    setEditingUser({
      ...user,
      extraCapabilities: [...(user.extraCapabilities ?? [])],
    });
    setAccessDialog('edit');
  }

  function toggleEditingCapability(capability: PermissionCapability) {
    setEditingUser((current) => {
      if (!current) return current;
      const extraCapabilities = current.extraCapabilities ?? [];
      return {
        ...current,
        extraCapabilities: extraCapabilities.includes(capability)
          ? extraCapabilities.filter((item) => item !== capability)
          : [...extraCapabilities, capability],
      };
    });
  }

  function assignAndClose() {
    if (!canAssign) return;
    onAssign();
    setAccessFeedback(`Доступ выдан: ${draft.email.trim()}.`);
    setAccessDialog(null);
  }

  function saveEditingUser() {
    if (!editingUser) return;
    onUserSave({
      ...editingUser,
      status: 'active',
      extraCapabilities: [...(editingUser.extraCapabilities ?? [])],
    });
    setAccessFeedback(`Доступ сохранен: ${editingUser.email}.`);
    closeDialog();
  }

  function revokeAndClose(user: UserAccessEntry) {
    onRevokeAccess(user);
    setAccessFeedback(`Доступ отозван: ${user.email}.`);
  }

  const userTableColumns: Array<PlenkiDataTableColumn<UserAccessEntry>> = [
    {
      id: 'email',
      header: 'Email',
      dataLabel: 'Email',
      render: (user) => (
        <span className="admin-user-email">
          <strong>{user.email}</strong>
          <small>{user.assignedAt} · {user.assignedBy}</small>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Роль',
      dataLabel: 'Роль',
      render: (user) => {
        const template = templates.find((item) => item.id === user.roleTemplateId);
        return (
          <span className="admin-user-role">
            <strong>{template?.name ?? 'Шаблон роли'}</strong>
            <small>{getRoleConfig(template?.role ?? 'admin').label}</small>
          </span>
        );
      },
    },
    {
      id: 'extra',
      header: 'Индивидуально',
      dataLabel: 'Доп. права',
      render: (user) => {
        const extraCapabilities = user.extraCapabilities ?? [];
        return extraCapabilities.length > 0 ? extraCapabilities.map(capabilityLabel).join(', ') : 'Нет';
      },
    },
    {
      id: 'status',
      header: 'Доступ',
      dataLabel: 'Доступ',
      render: (user) => <em>{accessStatusCopy(user.status)}</em>,
    },
    {
      id: 'actions',
      header: 'Действия',
      dataLabel: 'Действия',
      width: '240px',
      render: (user) => (
        <span className="admin-user-actions">
          <button className="compact-action-button" type="button" onClick={(event) => { event.stopPropagation(); openEditUser(user); }}>Редактировать</button>
          <button className="compact-action-button action-destructive" type="button" disabled={user.status === 'blocked'} onClick={(event) => { event.stopPropagation(); revokeAndClose(user); }}>Отозвать доступ</button>
        </span>
      ),
    },
  ];

  return (
    <article className="admin-access-surface">
      <header className="admin-access-header">
        <div>
          <h2>Доступы</h2>
        </div>
        <button className="compact-action-button action-recommended" type="button" onClick={() => setAccessDialog('assign')}>
          <ix-icon name="user-management-settings-filled" size="16" />
          <span>Выдать доступ</span>
        </button>
      </header>

      {accessFeedback && <div className="admin-save-feedback" role="status">{accessFeedback}</div>}

      <PlenkiMetricStrip
        metrics={[
          { id: 'active', label: 'Выдано', value: activeUsers, caption: 'текущий доступ', tone: 'success' },
          { id: 'blocked', label: 'Отозвано', value: revokedUsers, caption: 'вход закрыт', tone: revokedUsers > 0 ? 'warning' : 'muted' },
          { id: 'extra', label: 'Индивидуально', value: users.filter((user) => (user.extraCapabilities ?? []).length > 0).length, caption: 'поверх шаблона', tone: 'info' },
        ]}
      />

      <section className="admin-users-table" aria-label="Текущие доступы">
        <div className="admin-section-title">
          <span className="eyebrow">Доступы</span>
          <h3>Сотрудники</h3>
        </div>
        <PlenkiToolbar
          searchValue={userSearchQuery}
          searchPlaceholder="Поиск по email, роли, праву"
          onSearchChange={setUserSearchQuery}
          filters={[
            { id: 'all', label: 'Все', count: users.length, active: userStatusFilter === 'all', onClick: () => setUserStatusFilter('all') },
            { id: 'active', label: 'Активные', count: activeUsers, active: userStatusFilter === 'active', onClick: () => setUserStatusFilter('active') },
            { id: 'blocked', label: 'Отозванные', count: revokedUsers, active: userStatusFilter === 'blocked', onClick: () => setUserStatusFilter('blocked') },
          ]}
          meta={<span>{visibleUsers.length} из {users.length}</span>}
        />
        <PlenkiDataTable
          caption="Текущие доступы"
          columns={userTableColumns}
          rows={visibleUsers}
          getRowKey={(user) => user.id}
          getRowClassName={(user) => `status-${user.status}`}
          onRowClick={openEditUser}
        />
      </section>

      {accessDialog === 'assign' && (
        <PlenkiModal
          className="admin-access-modal"
          eyebrow="Доступ"
          title="Выдать доступ"
          onClose={closeDialog}
          footer={(
            <>
              <button className="compact-action-button" type="button" onClick={closeDialog}>Отмена</button>
              <button className="compact-action-button action-recommended" type="button" disabled={!canAssign} onClick={assignAndClose}>
                <ix-icon name="user-management-settings-filled" size="16" />
                <span>Выдать доступ</span>
              </button>
            </>
          )}
        >
            <div className="admin-assignment-form">
              <label>
                <span>Email сотрудника</span>
                <input
                  value={draft.email}
                  onChange={(event) => onDraftChange({ ...draft, email: event.target.value })}
                  placeholder="new-operator@example.com"
                  inputMode="email"
                />
              </label>
              <label>
                <span>Шаблон роли</span>
                <select value={draft.roleTemplateId} onChange={(event) => onDraftChange({ ...draft, roleTemplateId: event.target.value })}>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {selectedTemplate && (
              <div className="admin-template-preview" aria-label="Выбранный шаблон">
                <span>{selectedTemplate.name}</span>
                <strong>{selectedTemplate.summary}</strong>
              </div>
            )}
        </PlenkiModal>
      )}

      {accessDialog === 'edit' && editingUser && (
        <PlenkiDrawer
          eyebrow="Доступ сотрудника"
          title={editingUser.email}
          onClose={closeDialog}
          footer={(
            <>
              <button className="compact-action-button action-destructive" type="button" disabled={editingUser.status === 'blocked'} onClick={() => {
                revokeAndClose(editingUser);
                closeDialog();
              }}>
                Отозвать доступ
              </button>
              <button className="compact-action-button action-recommended" type="button" onClick={saveEditingUser}>Сохранить доступ</button>
            </>
          )}
        >
            <div className="admin-assignment-form">
              <label>
                <span>Шаблон роли</span>
                <select value={editingUser.roleTemplateId} onChange={(event) => setEditingUser({ ...editingUser, roleTemplateId: event.target.value })}>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>{template.name}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="admin-template-checkbox-group" aria-label="Индивидуальные дополнительные доступы">
              <span>Дополнительные доступы поверх шаблона</span>
              <div>
                {individualCapabilityOptions.map((capability) => (
                  <PlenkiSwitch
                    key={capability.id}
                    checked={(editingUser.extraCapabilities ?? []).includes(capability.id)}
                    onChange={() => toggleEditingCapability(capability.id)}
                    label={capability.label}
                    description="Индивидуально поверх шаблона"
                  />
                ))}
              </div>
            </div>
        </PlenkiDrawer>
      )}
    </article>
  );
}

export function AdminRoleTemplatesSurface({
  templates,
  history,
  onTemplateSave,
}: {
  templates: RoleTemplate[];
  history: AdminHistoryItem[];
  onTemplateSave: (template: RoleTemplate) => void;
}) {
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(() => templates.find((template) => template.setupStatus === 'needs_setup')?.id ?? templates[0]?.id ?? '');
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];
  const [draftTemplate, setDraftTemplate] = useState<RoleTemplate | null>(selectedTemplate ?? null);
  const readyTemplates = templates.filter((template) => template.setupStatus !== 'needs_setup').length;
  const setupRequiredTemplates = templates.length - readyTemplates;
  const hiddenScopeTotal = templates.reduce((sum, template) => sum + template.hiddenScopes.length, 0);
  const availableSections = draftTemplate ? getRoleConfig(draftTemplate.role).nav : [];
  const hasDraftChanges = Boolean(draftTemplate && selectedTemplate && JSON.stringify(draftTemplate) !== JSON.stringify(selectedTemplate));
  const templateStatus = setupRequiredTemplates > 0 ? `Требуют настройки: ${setupRequiredTemplates}` : 'Все готовы';

  useEffect(() => {
    if (!selectedTemplate) return;
    setDraftTemplate({
      ...selectedTemplate,
      visibleSections: [...selectedTemplate.visibleSections],
      hiddenScopes: [...selectedTemplate.hiddenScopes],
      capabilities: [...selectedTemplate.capabilities],
      allowedActions: [...selectedTemplate.allowedActions],
    });
  }, [selectedTemplate?.id]);

  function saveTemplate(template: RoleTemplate) {
    setSavedTemplateId(template.id);
    onTemplateSave(template);
  }

  function updateDraft(patch: Partial<RoleTemplate>) {
    setDraftTemplate((current) => current ? { ...current, ...patch } : current);
  }

  function toggleVisibleSection(section: string) {
    setDraftTemplate((current) => {
      if (!current) return current;
      const nextSections = current.visibleSections.includes(section)
        ? current.visibleSections.filter((item) => item !== section)
        : [...current.visibleSections, section];
      return { ...current, visibleSections: nextSections };
    });
  }

  function toggleHiddenScope(scope: FactScope) {
    setDraftTemplate((current) => {
      if (!current) return current;
      const nextScopes = current.hiddenScopes.includes(scope)
        ? current.hiddenScopes.filter((item) => item !== scope)
        : [...current.hiddenScopes, scope];
      return { ...current, hiddenScopes: nextScopes };
    });
  }

  function createDraftFromSelected() {
    if (!selectedTemplate) return;
    const nextTemplate = cloneTemplate(selectedTemplate);
    setSelectedTemplateId(nextTemplate.id);
    setDraftTemplate(nextTemplate);
    saveTemplate(nextTemplate);
  }

  const templateTableColumns: Array<PlenkiDataTableColumn<RoleTemplate>> = [
    {
      id: 'role',
      header: 'Роль',
      dataLabel: 'Роль',
      render: (template) => (
        <>
          <strong>{template.name}</strong>
          <small>{getRoleConfig(template.role).label}</small>
        </>
      ),
    },
    {
      id: 'status',
      header: 'Готовность',
      dataLabel: 'Готовность',
      render: (template) => (
        <>
          <em>{templateSetupCopy(template)}</em>
          <small>{templateRecoveryCopy(template)}</small>
        </>
      ),
    },
    {
      id: 'sections',
      header: 'Разделы',
      dataLabel: 'Разделы',
      render: (template) => (
        <>
          <strong>{template.visibleSections.length}</strong>
          <small>{compactScopeList(template.visibleSections, 3).join(', ')}</small>
        </>
      ),
    },
    {
      id: 'boundary',
      header: 'Граница',
      dataLabel: 'Граница',
      render: (template) => (
        <>
          <strong>{template.hiddenScopes.length}</strong>
          <small>{templateRiskCopy(template)}</small>
        </>
      ),
    },
  ];

  const historyColumns: Array<PlenkiDataTableColumn<AdminHistoryItem>> = [
    { id: 'time', header: 'Время', dataLabel: 'Время', render: (event) => <strong>{event.time}</strong> },
    { id: 'action', header: 'Действие', dataLabel: 'Действие', render: (event) => <strong>{event.action}</strong> },
    { id: 'target', header: 'Шаблон', dataLabel: 'Шаблон', render: (event) => <em>{event.target}</em> },
    { id: 'detail', header: 'Деталь', dataLabel: 'Деталь', render: (event) => <small>{event.detail}</small> },
  ];

  return (
    <article className="admin-access-surface">
      <header className="admin-access-header">
        <div>
          <h2 title="Готовые наборы доступа для типовых ролей. Настройка не выполняет действия производственных ролей.">Шаблоны ролей</h2>
        </div>
      </header>

      {savedTemplateId && (
        <div className="admin-save-feedback" role="status">
          Шаблон сохранен: {templates.find((template) => template.id === savedTemplateId)?.name ?? 'шаблон роли'}.
        </div>
      )}

      <PlenkiMetricStrip
        metrics={[
          { id: 'templates', label: 'Шаблоны', value: templates.length, caption: templateStatus, tone: setupRequiredTemplates > 0 ? 'warning' : 'success' },
          { id: 'ready', label: 'Готовы', value: readyTemplates, caption: 'к назначению', tone: 'success' },
          { id: 'hidden', label: 'Скрытые группы', value: hiddenScopeTotal, caption: 'в матрице', tone: 'info' },
          { id: 'selected', label: 'Выбран', value: selectedTemplate?.name ?? '-', caption: hasDraftChanges ? 'есть правки' : 'без правок', tone: hasDraftChanges ? 'warning' : 'muted' },
        ]}
      />

      {selectedTemplate && draftTemplate && (
        <section className="admin-template-workbench" aria-label="Матрица и выбранный шаблон роли">
          <div className="admin-template-list-panel">
            <div className="admin-section-title">
              <span className="eyebrow">Матрица доступа</span>
              <h3>Роли для назначения</h3>
            </div>
            <PlenkiDataTable
              caption="Шаблоны ролей"
              columns={templateTableColumns}
              rows={templates}
              getRowKey={(template) => template.id}
              getRowClassName={(template) => `setup-${template.setupStatus ?? 'ready'}`}
              isRowSelected={(template) => template.id === selectedTemplate.id}
              onRowClick={(template) => setSelectedTemplateId(template.id)}
            />
          </div>

          <aside className={`admin-template-decision-panel setup-${selectedTemplate.setupStatus ?? 'ready'}`} aria-label="Выбранный шаблон роли">
            <div className="admin-template-decision-head">
              <span className="eyebrow">{getRoleConfig(draftTemplate.role).label}</span>
              <h3>{draftTemplate.name}</h3>
            </div>
            <div className="admin-template-decision-grid">
              <div>
                <span>Состояние</span>
                <strong>{templateSetupCopy(draftTemplate)}</strong>
              </div>
              <div>
                <span>Действие</span>
                <strong>{hasDraftChanges ? 'Сохранить изменения перед назначением.' : templateRecoveryCopy(draftTemplate)}</strong>
              </div>
              <div>
                <span>Разделы</span>
                <strong>{draftTemplate.visibleSections.length}</strong>
              </div>
              <div>
                <span>Действия</span>
                <strong>{draftTemplate.allowedActions.length}</strong>
              </div>
            </div>
            <div className="admin-template-edit-form" aria-label="Редактировать выбранный шаблон">
              <label>
                <span>Название</span>
                <input value={draftTemplate.name} onChange={(event) => updateDraft({ name: event.target.value })} />
              </label>
              <label>
                <span>Готовность</span>
                <select value={draftTemplate.setupStatus ?? 'ready'} onChange={(event) => updateDraft({ setupStatus: event.target.value as RoleTemplate['setupStatus'] })}>
                  <option value="ready">Готов к назначению</option>
                  <option value="needs_setup">Требует настройки</option>
                </select>
              </label>
              <label className="is-wide">
                <span>Описание</span>
                <textarea value={draftTemplate.summary} rows={3} onChange={(event) => updateDraft({ summary: event.target.value })} />
              </label>
            </div>
            <div className="admin-template-checkbox-group" aria-label="Видимые разделы шаблона">
              <span>Видимые разделы</span>
              <div>
                {availableSections.map((section) => (
                  <PlenkiSwitch
                    key={section}
                    checked={draftTemplate.visibleSections.includes(section)}
                    onChange={() => toggleVisibleSection(section)}
                    label={section}
                    description="Показывать в роли"
                  />
                ))}
              </div>
            </div>
            <div className="admin-template-checkbox-group" aria-label="Скрытые группы шаблона">
              <span>Скрыто от роли</span>
              <div>
                {editableHiddenScopes.map((scope) => (
                  <PlenkiSwitch
                    key={scope}
                    checked={draftTemplate.hiddenScopes.includes(scope)}
                    onChange={() => toggleHiddenScope(scope)}
                    label={scopeCopy(scope)}
                    description="Скрыть группу"
                  />
                ))}
              </div>
            </div>
            <div className="admin-template-boundary">
              <span>Текущая граница</span>
              <strong>{roleTemplateHiddenCopy(draftTemplate)}</strong>
            </div>
            <details className="admin-service-details admin-template-service-details">
              <summary>Служебные детали шаблона</summary>
              <div className="admin-template-scope-chips" aria-label="Разделы выбранной роли">
                {draftTemplate.visibleSections.map((section) => (
                  <span key={section}>{section}</span>
                ))}
              </div>
              <label className="admin-template-actions-editor">
                <span>Допустимые действия</span>
                <textarea value={actionText(draftTemplate)} rows={5} onChange={(event) => updateDraft({ allowedActions: parseActionText(event.target.value) })} />
              </label>
              <div className="admin-template-actions-preview" aria-label="Допустимые действия выбранной роли">
                <span>Предпросмотр действий</span>
                <ul>
                  {draftTemplate.allowedActions.map((action) => (
                    <li key={action}>{action}</li>
                  ))}
                </ul>
              </div>
            </details>
            <div className="admin-template-editor-actions">
              <button className="compact-action-button action-secondary" type="button" onClick={() => saveTemplate(draftTemplate)} disabled={!draftTemplate.name.trim() || draftTemplate.visibleSections.length === 0}>
                <ix-icon name="check" size="16" />
                <span>Сохранить шаблон</span>
              </button>
              <button className="compact-action-button" type="button" onClick={createDraftFromSelected}>
                <ix-icon name="add-circle" size="16" />
                <span>Создать и сохранить черновик</span>
              </button>
            </div>
          </aside>
        </section>
      )}

      <details className="admin-service-details admin-history-details" aria-label="История шаблонов ролей">
        <summary>История шаблонов</summary>
        <PlenkiDataTable
          caption="История шаблонов"
          columns={historyColumns}
          rows={history}
          getRowKey={(event) => event.id}
        />
      </details>
    </article>
  );
}
