import { projectOneCSnapshot } from './onec.projection';

const snap = {
  sourceKind: '1C' as const,
  subjectType: 'counterparty' as const,
  externalId: 'ext-1',
  sourceVersion: 'v9',
  staleness: 'fresh' as const,
  capturedAt: '2026-07-02T00:00:00.000Z',
  parsed: { displayName: 'УралПак', legalName: 'ООО «УралПак»', inn: '660', kpp: null, code: null },
  rawPayload: { _internal: 'RAW 1C XML — admin diagnostics only', secret: true },
};

describe('projectOneCSnapshot (ТЗ §8 — raw never leaks)', () => {
  it('drops rawPayload but keeps parsed + staleness metadata', () => {
    const view = projectOneCSnapshot(snap);
    expect('rawPayload' in view).toBe(false);
    expect(view.parsed.displayName).toBe('УралПак');
    expect(view.externalId).toBe('ext-1');
    expect(view.sourceVersion).toBe('v9');
    expect(view.staleness).toBe('fresh');
  });

  it('no serialized field carries the raw secret', () => {
    expect(JSON.stringify(projectOneCSnapshot(snap))).not.toContain('secret');
  });
});
