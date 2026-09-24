import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './domain/accessPolicy';
import { roleTemplates } from './domain/fixtures/access';
import { getRoleConfig } from './domain/selectors';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const adminLiveStateSource = readFileSync(
  new URL('./domain/adminLiveState.ts', import.meta.url),
  'utf8',
);

describe('production and director regression guard', () => {
  it('renders the production penalty page as one full-width direct-detail workspace', () => {
    expect(appSource).toMatch(
      /data-direct-detail=\{[\s\S]*?isProductionPenaltySection[\s\S]*?\? 'true'/u,
    );
  });

  it('does not expose the obsolete director decision queue as a navigation tab', () => {
    expect(getRoleConfig('director').nav).not.toContain('Требуют решения');
    expect(roleAccessPolicies.director.visibleSections).not.toContain('Требуют решения');
    expect(
      roleTemplates.find((template) => template.role === 'director')?.visibleSections,
    ).not.toContain('Требуют решения');
  });

  it('exposes the shared all-rolls registry in every director navigation source', () => {
    expect(getRoleConfig('director').nav).toContain('Все рулоны');
    expect(roleAccessPolicies.director.visibleSections).toContain('Все рулоны');
    expect(
      roleTemplates.find((template) => template.role === 'director')?.visibleSections,
    ).toContain('Все рулоны');
  });

  it('removes 1C from product navigation and disables warehouse exports', () => {
    expect(getRoleConfig('admin').nav).not.toContain('1С');
    expect(roleAccessPolicies.admin.visibleSections).not.toContain('1С');
    expect(
      roleTemplates.find((template) => template.role === 'admin')?.visibleSections,
    ).not.toContain('1С');
    expect(
      roleTemplates.find((template) => template.role === 'admin')?.allowedActions,
    ).not.toContain('Проверять 1С');
    expect(roleTemplates.find((template) => template.role === 'admin')?.summary).not.toContain(
      '1С',
    );
    expect(appSource).toContain('const canPushWarehouseOneC = false;');
    expect(adminLiveStateSource).not.toContain('fetchAdminOneCOverview');
    expect(adminLiveStateSource).not.toContain('fetchAdminOneCSnapshots');
    expect(adminLiveStateSource).not.toContain('fetchAdminOneCRawSnapshot');
  });
});
