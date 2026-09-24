import type { KeyboardEvent } from 'react';

export const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function isUsableFocusTarget(element: HTMLElement) {
  if (
    !element.isConnected ||
    !element.matches(focusableSelector) ||
    element.matches(':disabled') ||
    element.getAttribute('aria-disabled') === 'true'
  ) {
    return false;
  }

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (
    style?.display === 'none' ||
    style?.visibility === 'hidden' ||
    style?.visibility === 'collapse'
  ) {
    return false;
  }

  return element.getClientRects().length > 0;
}

export function isEventFromNestedDialog(
  currentTarget: EventTarget,
  target: EventTarget | null,
): boolean {
  if (!target || typeof target !== 'object') return false;
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== 'function') return false;
  const owningDialog = closest.call(target, '[role="dialog"]');
  return owningDialog !== null && owningDialog !== currentTarget;
}

export function trapFocusWithin<T extends HTMLElement>(event: KeyboardEvent<T>) {
  if (event.key !== 'Tab') return;

  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(focusableSelector),
  ).filter(isUsableFocusTarget);

  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const activeElement = document.activeElement;

  if (activeElement === event.currentTarget) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
