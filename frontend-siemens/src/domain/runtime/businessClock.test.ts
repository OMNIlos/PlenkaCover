import { describe, expect, it } from 'vitest';

import { businessClockAt } from './businessClock';

describe('business clock', () => {
  it('uses the Moscow business date independently of the runtime host timezone', () => {
    expect(businessClockAt(new Date('2026-07-31T20:59:59.000Z'))).toEqual({
      timeZone: 'Europe/Moscow',
      dateIso: '2026-07-31',
      monthKey: '2026-07',
      dateLabel: '31.07.2026',
    });
  });

  it('crosses the month exactly at Moscow midnight', () => {
    expect(businessClockAt(new Date('2026-07-31T21:00:00.000Z'))).toEqual({
      timeZone: 'Europe/Moscow',
      dateIso: '2026-08-01',
      monthKey: '2026-08',
      dateLabel: '01.08.2026',
    });
  });
});
