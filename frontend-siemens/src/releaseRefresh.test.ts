import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { reloadWhenReleaseChanges } from './releaseRefresh';

describe('reloadWhenReleaseChanges', () => {
  it('checks a continuously focused workstation for a new release every minute', () => {
    expect(readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')).toContain(
      'window.setInterval(checkRelease, 60_000);',
    );
  });

  it('reloads only when the no-cache shell points at another Vite entry', async () => {
    const reload = vi.fn();

    await reloadWhenReleaseChanges(
      '/assets/index-old.js',
      async () => '<script type="module" src="/assets/index-current.js"></script>',
      reload,
    );
    await reloadWhenReleaseChanges(
      '/assets/index-current.js',
      async () => '<script type="module" src="/assets/index-current.js"></script>',
      reload,
    );
    await reloadWhenReleaseChanges(
      '/assets/index-current.js',
      async () => Promise.reject(new Error('offline')),
      reload,
    );

    expect(reload).toHaveBeenCalledOnce();
  });
});
