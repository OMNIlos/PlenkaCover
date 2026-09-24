import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';
import type { Role } from './types';

describe('operator payroll navigation', () => {
  it('places a private payroll section after Shift for operators only', () => {
    const config = roleConfigs.find(({ id }) => id === 'operator');
    const template = roleTemplates.find(({ role }) => role === 'operator');
    const operatorSections = [
      roleAccessPolicies.operator.visibleSections,
      config?.nav,
      template?.visibleSections,
    ];

    for (const sections of operatorSections) {
      if (!sections) throw new Error('Operator navigation source is missing.');
      expect(sections.indexOf('Зарплата')).toBe(sections.indexOf('Смена') + 1);
    }
    expect(template?.allowedActions).toContain('Посмотреть свою зарплату');

    for (const role of [
      'commercial',
      'production',
      'finance',
      'director',
      'warehouse',
      'admin',
    ] satisfies Role[]) {
      expect(roleAccessPolicies[role].visibleSections).not.toContain('Зарплата');
      expect(roleConfigs.find(({ id }) => id === role)?.nav).not.toContain('Зарплата');
    }
  });
});
