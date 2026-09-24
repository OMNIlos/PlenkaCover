import { describe, expect, it } from 'vitest';

import { roleAccessPolicies } from './accessPolicy';
import { roleConfigs, roleTemplates } from './fixtures/access';

describe('warehouse defect navigation', () => {
  it('keeps receiving and shipping as independent warehouse tabs in every access source', () => {
    const expected = ['Прием брака', 'Отгрузка брака'];
    const config = roleConfigs.find(({ id }) => id === 'warehouse');
    const template = roleTemplates.find(({ role }) => role === 'warehouse');

    expect(config?.nav).toEqual(expect.arrayContaining(expected));
    expect(template?.visibleSections).toEqual(expect.arrayContaining(expected));
    expect(roleAccessPolicies.warehouse.visibleSections).toEqual(expect.arrayContaining(expected));
  });
});
