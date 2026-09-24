import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { fetchAdminUnresolvedPrintJobs, reconcileAdminPrintJob } from '../../api/admin';
import { PlenkiModal } from '../plenki-ui/PlenkiPrimitives';
import { AdminPrintRecoverySection } from './AdminPrintRecoverySection';

vi.mock('../../api/admin', () => ({
  fetchAdminUnresolvedPrintJobs: vi.fn(),
  reconcileAdminPrintJob: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it('requires a physical decision and reason, preserving the UUID and form after a lost reply', async () => {
  const job = {
    kind: 'defect_bag' as const,
    printJobId: 'print-1',
    objectCode: 'БРАК-1',
    createdAt: '2026-09-12T08:00:00Z',
  };
  vi.mocked(fetchAdminUnresolvedPrintJobs).mockResolvedValue([job]);
  vi.mocked(reconcileAdminPrintJob)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce({});
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AdminPrintRecoverySection />);
    });
    const button = (text: string) =>
      renderer.root.findAllByType('button').find((node) => node.children.includes(text))!;
    await act(async () => button('Сверить печать').props.onClick());
    expect(button('Подтвердить результат').props.disabled).toBe(true);
    await act(async () => {
      renderer.root
        .findByType('select')
        .props.onChange({ currentTarget: { value: 'not_printed' } });
      renderer.root
        .findByType('textarea')
        .props.onChange({ currentTarget: { value: 'Принтер проверен' } });
    });
    const submit = async () =>
      act(async () => renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
    await submit();
    expect(renderer.root.findByType('select').props.disabled).toBe(true);
    expect(renderer.root.findByType(PlenkiModal).props.closeDisabled).toBe(true);
    expect(button('Повторить сохранение').props.disabled).toBe(false);
    await submit();
    const calls = vi.mocked(reconcileAdminPrintJob).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0][1]).toMatchObject({
      operationKey: expect.any(String),
      outcome: 'not_printed',
      reason: 'Принтер проверен',
    });
    expect(renderer.root.findAllByType('form')).toHaveLength(0);
    expect(fetchAdminUnresolvedPrintJobs).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => renderer?.unmount());
  }
});

it('shows a load failure instead of claiming that no blocked jobs exist', async () => {
  vi.mocked(fetchAdminUnresolvedPrintJobs).mockRejectedValue(new Error('Ошибка загрузки'));
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(<AdminPrintRecoverySection />);
    });
    expect(renderer.root.findByProps({ role: 'alert' }).children).toEqual(['Ошибка загрузки']);
    expect(renderer.root.findAllByType('table')).toHaveLength(0);
  } finally {
    await act(async () => renderer?.unmount());
  }
});
