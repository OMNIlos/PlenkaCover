import { describe, expect, it } from 'vitest';

import { operatorPayrollHeadlineRanges } from './operatorPayrollView';

describe('operatorPayrollHeadlineRanges', () => {
  it('uses the Moscow business date and an inclusive 14-day window', () => {
    expect(operatorPayrollHeadlineRanges(new Date('2026-07-31T21:30:00.000Z'))).toEqual({
      today: { from: '2026-08-01', to: '2026-08-01' },
      fortnight: { from: '2026-07-19', to: '2026-08-01' },
    });
  });
});
