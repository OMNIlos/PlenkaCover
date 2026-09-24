import { describe, expect, it } from 'vitest';

import {
  focusableSelector,
  isEventFromNestedDialog,
  isUsableFocusTarget,
} from './focusTrap';

type FocusTargetOptions = {
  ariaDisabled?: boolean;
  connected?: boolean;
  disabled?: boolean;
  display?: string;
  focusable?: boolean;
  hasClientRect?: boolean;
  visibility?: string;
};

function focusTarget({
  ariaDisabled = false,
  connected = true,
  disabled = false,
  display = 'block',
  focusable = true,
  hasClientRect = true,
  visibility = 'visible',
}: FocusTargetOptions = {}) {
  return {
    isConnected: connected,
    matches(selector: string) {
      if (selector === ':disabled') return disabled;
      return selector === focusableSelector ? focusable : false;
    },
    getAttribute(name: string) {
      return name === 'aria-disabled' && ariaDisabled ? 'true' : null;
    },
    getClientRects() {
      return hasClientRect ? [{}] : [];
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle() {
          return { display, visibility };
        },
      },
    },
  } as unknown as HTMLElement;
}

describe('modal focus targets', () => {
  it('includes editable regions in the shared focus order', () => {
    expect(focusableSelector).toContain('[contenteditable="true"]');
  });

  it('accepts only connected, enabled, visible focusable elements', () => {
    expect(isUsableFocusTarget(focusTarget())).toBe(true);
    expect(isUsableFocusTarget(focusTarget({ connected: false }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ disabled: true }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ ariaDisabled: true }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ display: 'none' }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ visibility: 'hidden' }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ hasClientRect: false }))).toBe(false);
    expect(isUsableFocusTarget(focusTarget({ focusable: false }))).toBe(false);
  });

  it('lets only the innermost dialog own Escape and Tab events', () => {
    const outer = { role: 'dialog' } as unknown as HTMLElement;
    const nested = {
      closest(selector: string) {
        return selector === '[role="dialog"]' ? nested : null;
      },
    } as unknown as HTMLElement;
    const direct = {
      closest(selector: string) {
        return selector === '[role="dialog"]' ? outer : null;
      },
    } as unknown as HTMLElement;

    expect(isEventFromNestedDialog(outer, nested)).toBe(true);
    expect(isEventFromNestedDialog(outer, direct)).toBe(false);
    expect(isEventFromNestedDialog(outer, null)).toBe(false);
  });
});
