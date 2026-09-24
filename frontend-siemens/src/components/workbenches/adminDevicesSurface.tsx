import { useState } from 'react';
import type { DeviceMockContract } from '../../domain/runtime/types';

function deviceKindCopy(kind: DeviceMockContract['kind']) {
  if (kind === 'scale') return 'Весы';
  if (kind === 'scanner') return 'Сканер';
  if (kind === 'printer') return 'Принтер';
  return 'Источник 1С';
}

function deviceStatusCopy(status: DeviceMockContract['status'], isSource = false) {
  if (isSource && (status === 'ready' || status === 'not_required')) return '1С отвечает';
  if (isSource) return '1С требует проверки';
  if (status === 'ready') return 'Готово';
  if (status === 'offline') return 'Офлайн';
  if (status === 'unstable') return 'Требует проверки';
  if (status === 'error') return 'Тест не пройден';
  return 'Отключено';
}

function deviceFallbackLabel(device: DeviceMockContract) {
  if (device.label) return device.label;
  if (device.kind === 'scale') return 'Весы линии';
  if (device.kind === 'scanner') return 'Сканер склада';
  if (device.kind === 'printer') return 'Принтер этикеток';
  return device.sourceSystem ?? 'Источник 1С';
}

function createDeviceDraft(kind: DeviceMockContract['kind'] = 'scale'): DeviceMockContract {
  const suffix = Date.now().toString(36).toUpperCase();
  const isSource = kind === 'financeSource';
  return {
    id: `${isSource ? 'SOURCE-1C' : kind.toUpperCase()}-${suffix}`,
    kind,
    label: isSource ? 'Источник 1С' : '',
    workplaceId: isSource ? 'Финансовый контур' : '',
    connectionKind: isSource ? 'Снимок' : 'Диагностика',
    sourceSystem: isSource ? '1С' : undefined,
    status: isSource ? 'not_required' : 'ready',
    ownerRole: isSource ? 'Бухгалтерия' : 'Админ',
    lastSeenAt: 'не проверялось',
    rawPayload: isSource ? 'source=1c' : 'signal=empty',
    parsedPayload: isSource ? 'Снимок не проверялся' : 'Нет результата проверки',
    recovery: isSource ? 'Повторить проверку источника или передать владельцу' : 'Проверить подключение и рабочее место',
    notes: '',
  };
}

function sanitizeDeviceId(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function AdminDevicesSurface({
  devices,
  section,
  onDeviceSave,
  onDeviceTest,
}: {
  devices: DeviceMockContract[];
  section: 'Устройства' | 'Источники';
  onDeviceSave: (mode: 'create' | 'edit', device: DeviceMockContract) => void;
  onDeviceTest: (deviceId: string) => void;
}) {
  const isSourceSection = section === 'Источники';
  const visibleDevices = devices.filter((device) => (isSourceSection ? device.kind === 'financeSource' : device.kind !== 'financeSource'));
  const selectedDevice = visibleDevices[0];
  const issueCount = visibleDevices.filter((device) => device.status === 'offline' || device.status === 'unstable' || device.status === 'error').length;
  const [dialogMode, setDialogMode] = useState<'create' | 'edit' | null>(null);
  const [draftDevice, setDraftDevice] = useState<DeviceMockContract | null>(null);
  const existingIds = new Set(devices.map((device) => device.id));
  const isEditing = dialogMode === 'edit';
  const duplicateId = Boolean(draftDevice && !isEditing && existingIds.has(sanitizeDeviceId(draftDevice.id)));
  const canSave = Boolean(draftDevice?.id.trim() && draftDevice?.label?.trim() && !duplicateId);

  function closeDialog() {
    setDialogMode(null);
    setDraftDevice(null);
  }

  function openCreate() {
    setDraftDevice(createDeviceDraft(isSourceSection ? 'financeSource' : 'scale'));
    setDialogMode('create');
  }

  function openEdit(device: DeviceMockContract) {
    setDraftDevice({ ...device });
    setDialogMode('edit');
  }

  function updateDraft(patch: Partial<DeviceMockContract>) {
    setDraftDevice((current) => {
      if (!current) return current;
      const nextKind = patch.kind ?? current.kind;
      return {
        ...current,
        ...patch,
        sourceSystem: nextKind === 'financeSource' ? patch.sourceSystem ?? current.sourceSystem ?? '1С' : undefined,
      };
    });
  }

  function saveDraft() {
    if (!draftDevice || !canSave) return;
    const normalized: DeviceMockContract = {
      ...draftDevice,
      id: isEditing ? draftDevice.id : sanitizeDeviceId(draftDevice.id),
      label: draftDevice.label?.trim(),
      workplaceId: draftDevice.workplaceId?.trim(),
      connectionKind: draftDevice.connectionKind?.trim(),
      notes: draftDevice.notes?.trim(),
      sourceSystem: draftDevice.kind === 'financeSource' ? draftDevice.sourceSystem?.trim() || '1С' : undefined,
      lastSeenAt: draftDevice.lastSeenAt.trim() || 'не проверялось',
      rawPayload: draftDevice.rawPayload.trim() || 'empty',
      parsedPayload: draftDevice.parsedPayload.trim() || 'Нет результата',
      recovery: draftDevice.recovery.trim() || 'Проверить контур и назначить владельца восстановления',
    };
    onDeviceSave(isEditing ? 'edit' : 'create', normalized);
    closeDialog();
  }

  return (
    <article className="admin-access-surface admin-device-catalog detail-view">
      <header className="admin-access-header">
        <div>
          <h2>{section}</h2>
        </div>
        <span>{visibleDevices.length} записей</span>
        <button className="compact-action-button action-recommended" type="button" onClick={openCreate}>
          <ix-icon name="add" size="16" />
          <span>Добавить</span>
        </button>
      </header>

      <section className={`admin-keyline admin-template-keyline severity-${issueCount > 0 ? 'warning' : 'info'}`} aria-label="Главный факт устройств">
        <div>
          <span>{isSourceSection ? 'Источники' : 'Устройства'}</span>
          <strong>{issueCount > 0 ? `Проверить: ${issueCount}` : 'Блокеров нет'}</strong>
        </div>
      </section>

      <dl className="admin-brief-grid" aria-label="Ключевые факты каталога">
        {isSourceSection ? (
          <>
            <div>
              <dt>Система</dt>
              <dd>{selectedDevice ? deviceFallbackLabel(selectedDevice) : 'Не задана'}</dd>
            </div>
            <div>
              <dt>Владелец</dt>
              <dd>{selectedDevice?.ownerRole ?? 'Админ'}</dd>
            </div>
            <div>
              <dt>Снимок</dt>
              <dd>{selectedDevice?.lastSeenAt ?? 'не проверялось'}</dd>
            </div>
            <div>
              <dt>Статус</dt>
              <dd>{selectedDevice ? deviceStatusCopy(selectedDevice.status, true) : 'Нет источника'}</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>Объект</dt>
              <dd>{selectedDevice ? deviceFallbackLabel(selectedDevice) : 'Не задан'}</dd>
            </div>
            <div>
              <dt>Владелец</dt>
              <dd>{selectedDevice?.ownerRole ?? 'Админ'}</dd>
            </div>
            <div>
              <dt>Результат</dt>
              <dd>{selectedDevice?.parsedPayload ?? 'Нет результата'}</dd>
            </div>
            <div>
              <dt>Статус</dt>
              <dd>{selectedDevice ? deviceStatusCopy(selectedDevice.status) : 'Нет устройства'}</dd>
            </div>
          </>
        )}
      </dl>

      <details className="admin-service-details admin-diagnostics-details">
        <summary>Служебные детали</summary>
        <div className="admin-diagnostic-grid">
          <section className="admin-diagnostic-panel">
            <h4>{isSourceSection ? 'Источник' : 'Устройство'}</h4>
            <dl className="admin-brief-grid" aria-label="Сводка каталога">
              <div>
                <dt>Всего</dt>
                <dd>{visibleDevices.length}</dd>
              </div>
              <div>
                <dt>Готовы</dt>
                <dd>{visibleDevices.filter((device) => device.status === 'ready').length}</dd>
              </div>
              <div>
                <dt>Проверить</dt>
                <dd>{issueCount}</dd>
              </div>
              <div>
                <dt>Отключены</dt>
                <dd>{visibleDevices.filter((device) => device.status === 'not_required').length}</dd>
              </div>
            </dl>
          </section>
        </div>
      </details>

      <section className="admin-users-table" aria-label={isSourceSection ? 'Источники 1С' : 'Устройства'}>
        <div className="admin-section-title">
          <span className="eyebrow">{isSourceSection ? '1С' : 'Каталог'}</span>
          <h3>{isSourceSection ? 'Источники' : 'Устройства'}</h3>
        </div>
        <div className="admin-device-grid">
          <div className="admin-device-row admin-user-row-head">
            <span>Название</span>
            <span>Тип</span>
            <span>{isSourceSection ? 'Контур' : 'Рабочее место'}</span>
            <span>Статус</span>
            <span>Действия</span>
          </div>
          {visibleDevices.map((device) => (
            <div key={device.id} className={`admin-device-row status-${device.status}`}>
              <span className="admin-user-email">
                <strong>{deviceFallbackLabel(device)}</strong>
                <small>{device.id} · {device.lastSeenAt}</small>
              </span>
              <span className="admin-user-role">
                <strong>{deviceKindCopy(device.kind)}</strong>
                <small>{device.connectionKind || 'Диагностика'}</small>
              </span>
              <span className="admin-user-extra">{device.workplaceId || 'Не задано'}</span>
              <em>{deviceStatusCopy(device.status, device.kind === 'financeSource')}</em>
              <span className="admin-user-actions">
                <button className="compact-action-button" type="button" onClick={() => openEdit(device)}>Редактировать</button>
                <button className="compact-action-button action-secondary" type="button" onClick={() => onDeviceTest(device.id)}>
                  {device.kind === 'financeSource' ? 'Проверить источник' : 'Проверить связь'}
                </button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {dialogMode && draftDevice && (
        <div className="admin-access-modal-backdrop" role="presentation">
          <section className="admin-access-modal admin-device-modal" role="dialog" aria-modal="true" aria-label={isEditing ? 'Редактировать устройство' : 'Добавить устройство'}>
            <header>
              <div>
                <span className="eyebrow">{draftDevice.kind === 'financeSource' ? 'Источник' : 'Устройство'}</span>
                <h3>{isEditing ? 'Редактировать' : 'Добавить'}</h3>
              </div>
              <button className="compact-action-button" type="button" onClick={closeDialog}>Закрыть</button>
            </header>
            <div className="admin-template-edit-form admin-device-form" aria-label="Поля устройства">
              <label>
                <span>ID</span>
                <input value={draftDevice.id} disabled={isEditing} onChange={(event) => updateDraft({ id: event.target.value })} />
              </label>
              <label>
                <span>Тип</span>
                <select value={draftDevice.kind} disabled={isSourceSection} onChange={(event) => updateDraft({ kind: event.target.value as DeviceMockContract['kind'] })}>
                  <option value="scale">Весы</option>
                  <option value="scanner">Сканер</option>
                  <option value="printer">Принтер</option>
                  <option value="financeSource">Источник 1С</option>
                </select>
              </label>
              <label>
                <span>Название</span>
                <input value={draftDevice.label ?? ''} onChange={(event) => updateDraft({ label: event.target.value })} />
              </label>
              <label>
                <span>{draftDevice.kind === 'financeSource' ? 'Контур' : 'Рабочее место'}</span>
                <input value={draftDevice.workplaceId ?? ''} onChange={(event) => updateDraft({ workplaceId: event.target.value })} />
              </label>
              {draftDevice.kind === 'financeSource' && (
                <label>
                  <span>Система</span>
                  <input value={draftDevice.sourceSystem ?? ''} onChange={(event) => updateDraft({ sourceSystem: event.target.value })} />
                </label>
              )}
              <label>
                <span>Подключение</span>
                <input value={draftDevice.connectionKind ?? ''} onChange={(event) => updateDraft({ connectionKind: event.target.value })} />
              </label>
              <label>
                <span>Владелец</span>
                <select value={draftDevice.ownerRole} onChange={(event) => updateDraft({ ownerRole: event.target.value as DeviceMockContract['ownerRole'] })}>
                  <option value="Админ">Админ</option>
                  <option value="Склад">Склад</option>
                  <option value="Бухгалтерия">Бухгалтерия</option>
                </select>
              </label>
              <label>
                <span>Статус</span>
                <select value={draftDevice.status} onChange={(event) => updateDraft({ status: event.target.value as DeviceMockContract['status'] })}>
                  <option value="ready">Готово</option>
                  <option value="offline">Офлайн</option>
                  <option value="unstable">Требует проверки</option>
                  <option value="error">Тест не пройден</option>
                  <option value="not_required">Отключено</option>
                </select>
              </label>
              <label>
                <span>Последняя связь</span>
                <input value={draftDevice.lastSeenAt} onChange={(event) => updateDraft({ lastSeenAt: event.target.value })} />
              </label>
              <label className="is-wide">
                <span>Результат</span>
                <textarea rows={2} value={draftDevice.parsedPayload} onChange={(event) => updateDraft({ parsedPayload: event.target.value })} />
              </label>
              <label className="is-wide">
                <span>Recovery</span>
                <textarea rows={2} value={draftDevice.recovery} onChange={(event) => updateDraft({ recovery: event.target.value })} />
              </label>
              <label className="is-wide">
                <span>Заметка</span>
                <textarea rows={2} value={draftDevice.notes ?? ''} onChange={(event) => updateDraft({ notes: event.target.value })} />
              </label>
            </div>
            <details className="admin-service-details admin-template-service-details">
              <summary>Служебный payload</summary>
              <label className="admin-device-raw-field">
                <span>Raw payload</span>
                <textarea rows={3} value={draftDevice.rawPayload} onChange={(event) => updateDraft({ rawPayload: event.target.value })} />
              </label>
            </details>
            {duplicateId && <div className="admin-save-feedback" role="alert">ID уже есть в каталоге.</div>}
            <footer>
              <button className="compact-action-button" type="button" onClick={closeDialog}>Отмена</button>
              <button className="compact-action-button action-recommended" type="button" disabled={!canSave} onClick={saveDraft}>
                <ix-icon name="save-all" size="16" />
                <span>Сохранить</span>
              </button>
            </footer>
          </section>
        </div>
      )}
    </article>
  );
}
