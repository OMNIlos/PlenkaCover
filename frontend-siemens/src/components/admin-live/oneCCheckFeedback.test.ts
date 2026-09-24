import { describe, expect, it } from 'vitest';

import { oneCCheckFeedback } from './oneCCheckFeedback';

describe('oneCCheckFeedback', () => {
  it('reports a real HTTP ready result as success', () => {
    expect(
      oneCCheckFeedback({
        mode: 'http',
        status: 'ready',
        checkedAt: '2026-07-17T19:00:00.000Z',
        latencyMs: 42,
      }),
    ).toEqual({ kind: 'notice', message: 'Демо-1С доступна: HTTP-проверка прошла.' });
  });

  it('never presents unavailable or mock health as a live connection success', () => {
    expect(
      oneCCheckFeedback({
        mode: 'http',
        status: 'unavailable',
        checkedAt: '2026-07-17T19:00:00.000Z',
        latencyMs: 42,
        errorCategory: 'http',
        message: '1С returned HTTP 420.',
      }),
    ).toEqual({ kind: 'error', message: '1С returned HTTP 420.' });
    expect(
      oneCCheckFeedback({
        mode: 'mock',
        status: 'ready',
        checkedAt: '2026-07-17T19:00:00.000Z',
        latencyMs: 1,
      }),
    ).toEqual({
      kind: 'error',
      message: 'Проверка вернула mock-адаптер; live-обмен с 1С не подтверждён.',
    });
  });
});
