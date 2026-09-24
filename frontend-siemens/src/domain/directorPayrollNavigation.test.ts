import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';
import type { Role } from './types';

describe('director payroll navigation', () => {
  it('places payroll directly after the production surface with shared roll costs', () => {
    const config = roleConfigs.find(({ id }) => id === 'director');
    const template = roleTemplates.find(({ role }) => role === 'director');
    const directorSections = [
      roleAccessPolicies.director.visibleSections,
      config?.nav,
      template?.visibleSections,
    ];

    for (const sections of directorSections) {
      if (!sections) throw new Error('Director navigation source is missing.');
      expect(sections).not.toContain('Себестоимость');
      expect(sections.indexOf('Зарплаты')).toBe(sections.indexOf('Производство') + 1);
    }
    expect(template?.allowedActions).toContain('Открыть расчёт зарплаты');

    const otherRoles: Role[] = [
      'commercial',
      'finance',
      'production',
      'operator',
      'warehouse',
      'admin',
    ];
    for (const role of otherRoles) {
      expect(roleAccessPolicies[role].visibleSections).not.toContain('Зарплаты');
      expect(roleAccessPolicies[role].visibleSections).not.toContain('Себестоимость');
      expect(roleConfigs.find(({ id }) => id === role)?.nav).not.toContain('Зарплаты');
      expect(roleConfigs.find(({ id }) => id === role)?.nav).not.toContain('Себестоимость');
      expect(
        roleTemplates.find((templateEntry) => templateEntry.role === role)?.visibleSections,
      ).not.toContain('Зарплаты');
      expect(
        roleTemplates.find((templateEntry) => templateEntry.role === role)?.visibleSections,
      ).not.toContain('Себестоимость');
    }
  });
});
