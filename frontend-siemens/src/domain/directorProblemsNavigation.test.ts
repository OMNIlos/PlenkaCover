import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';

describe('director problems navigation', () => {
  it('publishes one shared Problems section in every director navigation projection', () => {
    const projections = [
      roleConfigs.find(({ id }) => id === 'director')?.nav,
      roleTemplates.find(({ role }) => role === 'director')?.visibleSections,
      roleAccessPolicies.director.visibleSections,
    ];

    for (const sections of projections) {
      expect(sections?.[0]).toBe('Контроль');
      expect(sections?.filter((section) => section === 'Проблемы')).toHaveLength(1);
      expect(sections?.indexOf('Проблемы')).toBeGreaterThan(0);
    }
  });
});
