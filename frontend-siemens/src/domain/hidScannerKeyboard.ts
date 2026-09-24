const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]';
const HID_BLOCKING_TARGET_SELECTOR = [
  OPEN_MODAL_SELECTOR,
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[contenteditable="plaintext-only"]',
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
].join(', ');

type HidDocument = {
  querySelector?: (selector: string) => unknown;
};

type PhysicalScannerKey = {
  code: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
};

type HidEventTarget = EventTarget &
  HidDocument & {
    closest?: (selector: string) => unknown;
    ownerDocument?: HidDocument;
  };

export function shouldIgnoreHidCapture(target: EventTarget | null): boolean {
  const element = target as HidEventTarget | null;
  const targetDocument =
    element?.ownerDocument ??
    (typeof element?.querySelector === 'function' ? element : undefined) ??
    (typeof document !== 'undefined' ? document : undefined);
  if (targetDocument?.querySelector?.(OPEN_MODAL_SELECTOR)) return true;
  if (typeof element?.closest !== 'function') return false;
  return Boolean(element.closest(HID_BLOCKING_TARGET_SELECTOR));
}

export function consumeScannerTerminator(event: KeyboardEvent, payloadLength: number): boolean {
  if (event.key !== 'Enter' || payloadLength < 4) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

const US_PHYSICAL_KEYS: Readonly<Record<string, readonly [string, string]>> = {
  Digit0: ['0', ')'],
  Digit1: ['1', '!'],
  Digit2: ['2', '@'],
  Digit3: ['3', '#'],
  Digit4: ['4', '$'],
  Digit5: ['5', '%'],
  Digit6: ['6', '^'],
  Digit7: ['7', '&'],
  Digit8: ['8', '*'],
  Digit9: ['9', '('],
  Backquote: ['`', '~'],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Space: [' ', ' '],
  NumpadDecimal: ['.', '.'],
  NumpadAdd: ['+', '+'],
  NumpadSubtract: ['-', '-'],
  NumpadMultiply: ['*', '*'],
  NumpadDivide: ['/', '/'],
};

/**
 * Reconstructs ASCII from the USB-HID key position. `KeyboardEvent.key` follows the
 * active OS layout; `code` remains tied to the physical key emitted by the scanner.
 */
export function scannerAsciiFromPhysicalKey(event: PhysicalScannerKey): string | null {
  if (event.isComposing === true || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (/^Key[A-Z]$/u.test(event.code)) {
    const letter = event.code.slice(3);
    return event.shiftKey ? letter : letter.toLowerCase();
  }
  if (/^Numpad[0-9]$/u.test(event.code)) return event.code.slice(-1);
  const mapped = US_PHYSICAL_KEYS[event.code];
  return mapped?.[event.shiftKey ? 1 : 0] ?? null;
}
