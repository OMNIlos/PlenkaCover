import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  consumeScannerTerminator,
  scannerAsciiFromPhysicalKey,
  shouldIgnoreHidCapture,
} from './hidScannerKeyboard';

const INTERACTIVE_SELECTORS = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
];

afterEach(() => vi.unstubAllGlobals());

describe('warehouse HID keyboard boundary', () => {
  it('ignores interactive, editable and modal targets without a DOM runtime', () => {
    const interactive = {
      closest: vi.fn((selector: string) =>
        INTERACTIVE_SELECTORS.every((candidate) => selector.includes(candidate)) ? {} : null,
      ),
    } as unknown as EventTarget;
    const modalTarget = {
      closest: vi.fn((selector: string) =>
        selector.includes('[role="dialog"][aria-modal="true"]') ? {} : null,
      ),
    } as unknown as EventTarget;

    expect(shouldIgnoreHidCapture(interactive)).toBe(true);
    expect(shouldIgnoreHidCapture(modalTarget)).toBe(true);
    expect(
      shouldIgnoreHidCapture({ closest: vi.fn().mockReturnValue(null) } as unknown as EventTarget),
    ).toBe(false);
  });

  it('ignores background targets while their document owns an open modal', () => {
    const backgroundTarget = {
      closest: vi.fn().mockReturnValue(null),
      ownerDocument: {
        querySelector: vi.fn().mockReturnValue({}),
      },
    } as unknown as EventTarget;

    expect(shouldIgnoreHidCapture(backgroundTarget)).toBe(true);
  });

  it('uses the current document when a keyboard target has no ownerDocument', () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn().mockReturnValue({}),
    });

    expect(shouldIgnoreHidCapture(null)).toBe(true);
    expect(
      shouldIgnoreHidCapture({ closest: vi.fn().mockReturnValue(null) } as unknown as EventTarget),
    ).toBe(true);
  });

  it('recognizes an open modal when the event target is the document itself', () => {
    const documentTarget = {
      querySelector: vi.fn().mockReturnValue({}),
    } as unknown as EventTarget;

    expect(shouldIgnoreHidCapture(documentTarget)).toBe(true);
  });

  it('consumes only a scanner Enter with a complete payload', () => {
    const complete = {
      key: 'Enter',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    const short = {
      key: 'Enter',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
    const ordinaryKey = {
      key: 'x',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;

    expect(consumeScannerTerminator(complete, 4)).toBe(true);
    expect(complete.preventDefault).toHaveBeenCalledOnce();
    expect(complete.stopPropagation).toHaveBeenCalledOnce();

    expect(consumeScannerTerminator(short, 3)).toBe(false);
    expect(short.preventDefault).not.toHaveBeenCalled();
    expect(short.stopPropagation).not.toHaveBeenCalled();

    expect(consumeScannerTerminator(ordinaryKey, 8)).toBe(false);
    expect(ordinaryKey.preventDefault).not.toHaveBeenCalled();
    expect(ordinaryKey.stopPropagation).not.toHaveBeenCalled();
  });

  it.each([
    ['KeyP', false, 'з', 'p'],
    ['KeyR', false, 'к', 'r'],
    ['KeyT', false, 'е', 't'],
    ['KeyA', false, 'ф', 'a'],
    ['KeyF', true, 'А', 'F'],
    ['Digit1', false, '1', '1'],
    ['Digit1', true, '!', '!'],
    ['Minus', true, '_', '_'],
    ['Numpad9', false, '9', '9'],
  ])(
    'decodes physical %s independently of the localized key',
    (code, shiftKey, key, expected) => {
      expect(
        scannerAsciiFromPhysicalKey({
          code,
          key,
          shiftKey,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          isComposing: false,
        }),
      ).toBe(expected);
    },
  );

  it('leaves modifiers, composition and unidentified keys to the browser', () => {
    const event = {
      code: 'KeyA',
      key: 'ф',
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
    };

    expect(scannerAsciiFromPhysicalKey({ ...event, ctrlKey: true })).toBeNull();
    expect(scannerAsciiFromPhysicalKey({ ...event, altKey: true })).toBeNull();
    expect(scannerAsciiFromPhysicalKey({ ...event, metaKey: true })).toBeNull();
    expect(scannerAsciiFromPhysicalKey({ ...event, isComposing: true })).toBeNull();
    expect(scannerAsciiFromPhysicalKey({ ...event, code: 'Unidentified' })).toBeNull();
  });
});
