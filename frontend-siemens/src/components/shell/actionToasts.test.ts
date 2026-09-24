import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  handles: Array.from({ length: 4 }, () => ({
    close: vi.fn(),
    onClose: { once: vi.fn() },
  })),
}));

vi.mock('@siemens/ix', () => ({
  setToastPosition: vi.fn(),
  toast: mocks.toast,
}));

vi.mock('@siemens/ix/components/ix-toast.js', () => ({
  defineCustomElement: vi.fn(),
}));

vi.mock('@siemens/ix/components/ix-toast-container.js', () => ({
  defineCustomElement: vi.fn(),
}));

import { operatorActionToast, showActionToast } from './actionToasts';

beforeEach(() => {
  mocks.toast.mockReset();
  for (const handle of mocks.handles) {
    handle.close.mockReset();
    handle.onClose.once.mockReset();
  }
});

describe('operator physical print toast', () => {
  it('reports transport submission without claiming physical printing', () => {
    const toast = operatorActionToast('operator-print-qr', { rollId: 'roll-1' });

    expect(toast).toEqual({
      tone: 'info',
      title: 'Задание печати отправлено',
      detail: 'roll-1: физический выход подтвердите сканером.',
    });
    expect(JSON.stringify(toast)).not.toContain('напечатан');
  });
});

describe('production toast density', () => {
  it('keeps at most two live action results visible and forgets closed entries', async () => {
    for (const handle of mocks.handles) {
      mocks.toast.mockResolvedValueOnce(handle);
    }

    showActionToast({ tone: 'success', title: 'Первый результат' });
    await vi.waitFor(() => expect(mocks.handles[0].onClose.once).toHaveBeenCalledTimes(1));
    const firstCloseListener = mocks.handles[0].onClose.once.mock.calls[0]?.[0];
    expect(firstCloseListener).toBeTypeOf('function');
    firstCloseListener?.();

    showActionToast({ tone: 'info', title: 'Второй результат' });
    showActionToast({ tone: 'warning', title: 'Третий результат' });
    showActionToast({ tone: 'success', title: 'Четвертый результат' });

    await vi.waitFor(() => expect(mocks.handles[1].close).toHaveBeenCalledTimes(1));

    expect(mocks.handles[0].close).not.toHaveBeenCalled();
    expect(mocks.handles[2].close).not.toHaveBeenCalled();
    expect(mocks.handles[3].close).not.toHaveBeenCalled();
  });
});
