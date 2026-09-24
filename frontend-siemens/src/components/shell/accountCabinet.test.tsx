import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from '../../domain/accessPolicy';
import { roleOrder, userSessions } from '../../domain/demoData';
import { AccountCabinet } from './appShell';

describe('AccountCabinet', () => {
  it.each(roleOrder)('hides crossed-out account details for %s', (role) => {
    const policy = roleAccessPolicies[role];
    const session = {
      ...userSessions[role],
      sessionExpiresAt: '2026-08-16T20:00:00.000Z',
    };
    const markup = renderToStaticMarkup(
      <AccountCabinet
        session={session}
        policy={policy}
        onToggleSound={() => undefined}
        onToggleReducedMotion={() => undefined}
        onLogout={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(markup).toContain(session.name);
    expect(markup).toContain('Доступные разделы');
    expect(markup).toContain('Настройки уведомлений');
    expect(markup).toContain('Выйти');
    expect(markup).not.toContain('<dl class="fact-list">');
    expect(markup).not.toContain('<h4>Сводка доступа</h4>');

    for (const label of ['Роль', 'Рабочее место', 'Смена', 'Статус', 'Сессия действует до']) {
      expect(markup).not.toContain(`<dt>${label}</dt>`);
    }

    for (const item of policy.accessSummary) {
      expect(markup).not.toContain(item);
    }
  });
});
