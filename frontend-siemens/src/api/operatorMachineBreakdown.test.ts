import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MACHINE_BREAKDOWN_TYPE_LABELS,
  MACHINE_BREAKDOWN_TYPES,
  operatorMachineBreakdownAction,
  parseOperatorMachineBreakdownAction,
  reportOperatorMachineBreakdown,
} from './operator';

const EXPECTED_TYPES = [
  'screw_jam',
  'extruder_stopped',
  'drive_stopped',
  'belt_break',
  'other',
] as const;

const EXPECTED_LABELS = {
  screw_jam: 'Клин шнека',
  extruder_stopped: 'Экструдер остановился',
  drive_stopped: 'Остановка привода',
  belt_break: 'Обрыв ремня',
  other: 'Другая поломка',
} as const;

afterEach(() => vi.unstubAllGlobals());

describe('operator machine-breakdown API seam', () => {
  it('mirrors the backend vocabulary and Russian labels exactly once', () => {
    expect(MACHINE_BREAKDOWN_TYPES).toEqual(EXPECTED_TYPES);
    expect(MACHINE_BREAKDOWN_TYPE_LABELS).toEqual(EXPECTED_LABELS);
  });

  it.each(EXPECTED_TYPES)('round-trips structured action %s without changing its value', (type) => {
    const input = { type, details: 'Остановился под нагрузкой' };
    expect(parseOperatorMachineBreakdownAction(operatorMachineBreakdownAction(input))).toEqual(
      input,
    );
  });

  it('omits blank optional details from the encoded command', () => {
    const action = operatorMachineBreakdownAction({ type: 'belt_break', details: '   ' });
    expect(parseOperatorMachineBreakdownAction(action)).toEqual({ type: 'belt_break' });
  });

  it.each([
    'operator-machine-breakdown:not-json',
    `operator-machine-breakdown:${encodeURIComponent(JSON.stringify({ type: 'device_offline' }))}`,
    `operator-machine-breakdown:${encodeURIComponent(JSON.stringify({ type: 'screw_jam', details: '' }))}`,
    `operator-machine-breakdown:${encodeURIComponent(JSON.stringify({ type: 'screw_jam', extra: true }))}`,
    `operator-machine-breakdown:${encodeURIComponent(JSON.stringify(['screw_jam']))}`,
  ])('rejects malformed or out-of-contract action %s', (actionId) => {
    expect(parseOperatorMachineBreakdownAction(actionId)).toBeNull();
  });

  it('posts the exact structured request without a legacy description alias', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ id: 'problem-1', status: 'open' }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await reportOperatorMachineBreakdown({
      type: 'extruder_stopped',
      details: 'Не запускается после остановки',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/operator/machine-breakdown',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          type: 'extruder_stopped',
          details: 'Не запускается после остановки',
        }),
      }),
    );
  });
});
