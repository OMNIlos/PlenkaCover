import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchAdminPalletLabelLayoutEditor,
  previewAdminPalletLabelLayout,
  publishAdminPalletLabelLayout,
} from './adminPalletLabelLayout';
import { bootstrapFixture } from '../features/admin/pallet-label-layout/palletLabelLayoutTestFixtures';

describe('admin pallet label layout API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads the editor bootstrap from the dedicated admin route', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(bootstrapFixture), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    await expect(fetchAdminPalletLabelLayoutEditor()).resolves.toEqual(bootstrapFixture);
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/pallet-label-layout-editor',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('posts a draft and returns the exact server-rendered PNG blob', async () => {
    const png = new Blob(['png'], { type: 'image/png' });
    const diagnostics = { belowProvenCut: ['storage'], outsideSafeArea: [], overlaps: [] };
    const encodedDiagnostics = btoa(JSON.stringify(diagnostics))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');
    const fetch = vi.fn().mockResolvedValue(
      new Response(png, {
        status: 200,
        headers: { 'X-Pallet-Layout-Diagnostics': encodedDiagnostics },
      }),
    );
    vi.stubGlobal('fetch', fetch);

    const result = await previewAdminPalletLabelLayout({
      sourceDocumentId: 'doc-1',
      layout: bootstrapFixture.editorLayout,
    });

    expect(result.png.type).toBe('image/png');
    expect(result.diagnostics).toEqual(diagnostics);
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/pallet-label-layout-editor/preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          sourceDocumentId: 'doc-1',
          layout: bootstrapFixture.editorLayout,
        }),
      }),
    );
  });

  it('posts the exact publish command and strictly confirms the publication response', async () => {
    const publication = {
      id: 'publication-1',
      version: 1,
      contentHash: 'b'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: bootstrapFixture.editorLayout,
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ publication, replayed: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const command = {
      operationKey: '11111111-1111-4111-8111-111111111111',
      expectedActivePublicationId: null,
      sourceDocumentId: 'doc-1',
      reason: 'Новый проверенный макет',
      layout: bootstrapFixture.editorLayout,
    };

    await expect(publishAdminPalletLabelLayout(command)).resolves.toEqual({
      publication,
      replayed: false,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/admin/pallet-label-layout-editor/publish',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(command) }),
    );
  });

  it.each([
    ['id', { publication: { id: '' } }],
    ['hash', { publication: { contentHash: 'bad' } }],
    ['version', { publication: { version: -1 } }],
    ['date', { publication: { activatedAt: '2026-08-11' } }],
    ['layout', { publication: { layout: { profile: 'pallet-100x100-extended-v6' } } }],
    ['replayed', { replayed: 'false' }],
  ])('rejects malformed publish response %s', async (_label, patch) => {
    const publication = {
      id: 'publication-1',
      version: 1,
      contentHash: 'b'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: bootstrapFixture.editorLayout,
      ...('publication' in patch ? patch.publication : {}),
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ publication, replayed: false, ...patch }), { status: 200 }),
      ),
    );

    await expect(
      publishAdminPalletLabelLayout({
        operationKey: '11111111-1111-4111-8111-111111111111',
        expectedActivePublicationId: null,
        sourceDocumentId: 'doc-1',
        reason: 'Новый макет',
        layout: bootstrapFixture.editorLayout,
      }),
    ).rejects.toThrow();
  });
});
