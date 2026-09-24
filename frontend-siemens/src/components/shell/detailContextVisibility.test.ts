import { describe, expect, it } from 'vitest';
import { shouldShowInlineContextPanel } from './detailContextVisibility';

describe('shouldShowInlineContextPanel', () => {
  it('hides object-specific context on the finance registry landing', () => {
    expect(
      shouldShowInlineContextPanel('finance', {
        isFinanceRegistryPage: true,
      }),
    ).toBe(false);
  });

  it('shows object-specific context when a concrete object is selected', () => {
    expect(
      shouldShowInlineContextPanel('finance', {
        isFinanceRegistryPage: false,
      }),
    ).toBe(true);
    expect(
      shouldShowInlineContextPanel('commercial', {
        isFinanceRegistryPage: false,
      }),
    ).toBe(true);
  });
});
