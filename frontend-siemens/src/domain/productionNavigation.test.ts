import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';

describe('production navigation boundary', () => {
  it('does not expose the removed ready-for-invoice bucket in any production navigation source', () => {
    const config = roleConfigs.find(({ id }) => id === 'production');
    const template = roleTemplates.find(({ role }) => role === 'production');

    expect(config?.nav).not.toContain('Готовы к счету');
    expect(template?.visibleSections).not.toContain('Готовы к счету');
    expect(roleAccessPolicies.production.visibleSections).not.toContain('Готовы к счету');
  });

  it('does not expose the obsolete incomplete bucket in any production navigation source', () => {
    const config = roleConfigs.find(({ id }) => id === 'production');
    const template = roleTemplates.find(({ role }) => role === 'production');

    expect(config?.nav).not.toContain('Неполные');
    expect(template?.visibleSections).not.toContain('Неполные');
    expect(roleAccessPolicies.production.visibleSections).not.toContain('Неполные');
    expect(config?.nav[0]).toBe('Заказ-наряды');
  });
});
