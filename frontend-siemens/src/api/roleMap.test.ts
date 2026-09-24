import { describe, expect, it } from 'vitest';
import { isServerRole, isUiRole, serverToUiRole, uiToServerRole } from './roleMap';

describe('roleMap', () => {
  it('маппит production_lead ↔ production', () => {
    expect(serverToUiRole('production_lead')).toBe('production');
    expect(uiToServerRole('production')).toBe('production_lead');
  });

  it('остальные роли проходят как есть, в обе стороны', () => {
    for (const role of [
      'commercial',
      'operator',
      'warehouse',
      'finance',
      'director',
      'admin',
    ] as const) {
      expect(serverToUiRole(role)).toBe(role);
      expect(uiToServerRole(role)).toBe(role);
    }
  });

  it('validates server and UI role values at runtime', () => {
    expect(isServerRole('production_lead')).toBe(true);
    expect(isServerRole('production')).toBe(false);
    expect(isServerRole('root')).toBe(false);
    expect(isUiRole('production')).toBe(true);
    expect(isUiRole('production_lead')).toBe(false);
    expect(isUiRole('root')).toBe(false);
  });
});
