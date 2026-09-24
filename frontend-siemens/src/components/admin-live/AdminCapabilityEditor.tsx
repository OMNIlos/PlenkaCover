import { useMemo, useState } from 'react';

import type {
  AdminCapability,
  AdminCapabilityCatalogItem,
  AdminRole,
} from '../../api/admin';

export function capabilityConflictKeys(
  grants: AdminCapability[],
  denials: AdminCapability[],
) {
  const denied = new Set(denials);
  return grants.filter((capability) => denied.has(capability));
}

export function AdminCapabilityEditor({
  catalog,
  role,
  grants,
  denials,
  onGrantsChange,
  onDenialsChange,
}: {
  catalog: AdminCapabilityCatalogItem[];
  role: AdminRole;
  grants: AdminCapability[];
  denials: AdminCapability[];
  onGrantsChange: (capabilities: AdminCapability[]) => void;
  onDenialsChange: (capabilities: AdminCapability[]) => void;
}) {
  const [grantSearch, setGrantSearch] = useState('');
  const [denialSearch, setDenialSearch] = useState('');
  const conflicts = capabilityConflictKeys(grants, denials);
  const catalogByKey = useMemo(
    () => new Map(catalog.map((capability) => [capability.key, capability])),
    [catalog],
  );
  const baseKeys = useMemo(
    () => catalog.filter((capability) => capability.baseRoles.includes(role)).map((item) => item.key),
    [catalog, role],
  );
  const effectiveKeys = useMemo(() => {
    const effective = new Set([...baseKeys, ...grants]);
    for (const capability of denials) effective.delete(capability);
    return Array.from(effective);
  }, [baseKeys, denials, grants]);

  if (catalog.length === 0) {
    return (
      <div className="admin-capability-empty" role="status">
        <strong>Каталог разрешений недоступен</strong>
        <span>Обновите данные перед сохранением.</span>
      </div>
    );
  }

  return (
    <section className="admin-capability-editor" aria-label="Настройка разрешений">
      <div className="admin-capability-summary">
        <div>
          <span>Базовые права</span>
          <strong>{baseKeys.length}</strong>
          <small>{capabilitySummary(baseKeys, catalogByKey)}</small>
        </div>
        <div>
          <span>После изменений</span>
          <strong>{effectiveKeys.length}</strong>
          <small>{capabilitySummary(effectiveKeys, catalogByKey)}</small>
        </div>
      </div>

      {conflicts.length > 0 ? (
        <div className="admin-capability-conflict" role="alert">
          <strong>Одно право выбрано одновременно</strong>
          <span>
            Уберите конфликт из дополнительных разрешений или запретов:{' '}
            {capabilitySummary(conflicts, catalogByKey)}.
          </span>
        </div>
      ) : null}

      <div className="admin-capability-columns">
        <CapabilityColumn
          title="Дополнительные разрешения"
          searchLabel="Поиск дополнительных разрешений"
          query={grantSearch}
          onQueryChange={setGrantSearch}
          catalog={catalog}
          selected={grants}
          mode="grant"
          onChange={onGrantsChange}
        />
        <CapabilityColumn
          title="Запреты"
          searchLabel="Поиск запретов"
          query={denialSearch}
          onQueryChange={setDenialSearch}
          catalog={catalog}
          selected={denials}
          mode="denial"
          onChange={onDenialsChange}
        />
      </div>
    </section>
  );
}

function CapabilityColumn({
  title,
  searchLabel,
  query,
  onQueryChange,
  catalog,
  selected,
  mode,
  onChange,
}: {
  title: string;
  searchLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  catalog: AdminCapabilityCatalogItem[];
  selected: AdminCapability[];
  mode: 'grant' | 'denial';
  onChange: (capabilities: AdminCapability[]) => void;
}) {
  const selectedSet = new Set(selected);
  const normalizedQuery = query.trim().toLocaleLowerCase('ru-RU');
  const filtered = catalog.filter((capability) => {
    if (!normalizedQuery) return true;
    return [capability.label, capability.description, capability.group, capability.key].some(
      (value) => value.toLocaleLowerCase('ru-RU').includes(normalizedQuery),
    );
  });
  const groups = groupedCapabilities(filtered);

  return (
    <section className="admin-capability-column">
      <header>
        <strong>{title}</strong>
        <span>{selected.length}</span>
      </header>
      <label className="admin-capability-search">
        <span>{searchLabel}</span>
        <input
          type="search"
          aria-label={searchLabel}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Название или группа"
        />
      </label>
      <div className="admin-capability-list">
        {groups.length > 0 ? (
          groups.map(([group, capabilities]) => (
            <fieldset key={group}>
              <legend>{group}</legend>
              {capabilities.map((capability) => {
                const checked = selectedSet.has(capability.key);
                return (
                  <label key={capability.key} className={!capability.grantable ? 'is-limited' : ''}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!capability.grantable && !checked}
                      data-capability-key={capability.key}
                      data-capability-mode={mode}
                      onChange={() =>
                        onChange(
                          checked
                            ? selected.filter((key) => key !== capability.key)
                            : [...selected, capability.key],
                        )
                      }
                    />
                    <span>
                      <strong>{capability.label}</strong>
                      <small>{capability.description}</small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
          ))
        ) : (
          <div className="admin-capability-empty">
            <span>Совпадений нет.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function groupedCapabilities(items: AdminCapabilityCatalogItem[]) {
  const groups = new Map<string, AdminCapabilityCatalogItem[]>();
  for (const item of items) {
    const current = groups.get(item.group) ?? [];
    current.push(item);
    groups.set(item.group, current);
  }
  return Array.from(groups.entries());
}

function capabilitySummary(
  keys: AdminCapability[],
  catalog: Map<AdminCapability, AdminCapabilityCatalogItem>,
) {
  if (keys.length === 0) return 'Нет';
  const labels = keys
    .slice(0, 3)
    .map((key) => catalog.get(key)?.label)
    .filter((label): label is string => Boolean(label));
  const remaining = keys.length - labels.length;
  return `${labels.join(', ')}${remaining > 0 ? ` +${remaining}` : ''}`;
}
