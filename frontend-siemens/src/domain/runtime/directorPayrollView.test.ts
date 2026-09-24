import { describe, expect, it } from 'vitest';

import { demoDirectorPayrollPreview } from '../fixtures/directorPayroll';
import { createDirectorPayrollRange } from './directorPayrollView';

describe('createDirectorPayrollRange', () => {
  it('uses the Moscow date at the midnight boundary for built-in presets', () => {
    const now = new Date('2026-07-31T21:30:00.000Z');

    expect(createDirectorPayrollRange('current_month', now)).toEqual({
      preset: 'current_month',
      from: '2026-08-01',
      to: '2026-08-01',
    });
    expect(createDirectorPayrollRange('previous_month', now)).toEqual({
      preset: 'previous_month',
      from: '2026-07-01',
      to: '2026-07-31',
    });
    expect(createDirectorPayrollRange('current_week', now)).toEqual({
      preset: 'current_week',
      from: '2026-07-27',
      to: '2026-08-01',
    });
  });

  it('uses UTC calendar arithmetic for a leap-year February', () => {
    expect(
      createDirectorPayrollRange('previous_month', new Date('2024-03-15T12:00:00.000Z')),
    ).toEqual({ preset: 'previous_month', from: '2024-02-01', to: '2024-02-29' });
  });

  it('moves to December when the previous-month preset crosses a calendar year', () => {
    expect(
      createDirectorPayrollRange('previous_month', new Date('2026-01-01T12:00:00.000Z')),
    ).toEqual({ preset: 'previous_month', from: '2025-12-01', to: '2025-12-31' });
  });

  it('rejects impossible, reversed, and oversized custom date ranges explicitly', () => {
    expect(() =>
      createDirectorPayrollRange('custom', new Date('2026-08-01T12:00:00.000Z'), {
        from: '2026-02-30',
        to: '2026-03-01',
      }),
    ).toThrow('real YYYY-MM-DD');
    expect(() =>
      createDirectorPayrollRange('custom', new Date('2026-08-01T12:00:00.000Z'), {
        from: '2026-08-02',
        to: '2026-08-01',
      }),
    ).toThrow('must not be after');
    expect(() =>
      createDirectorPayrollRange('custom', new Date('2026-08-01T12:00:00.000Z'), {
        from: '2025-07-31',
        to: '2026-08-01',
      }),
    ).toThrow('366 days');
  });

  it('keeps a custom range at the inclusive 366-day maximum', () => {
    expect(
      createDirectorPayrollRange('custom', new Date('2026-08-01T12:00:00.000Z'), {
        from: '2025-08-02',
        to: '2026-08-02',
      }),
    ).toEqual({
      preset: 'custom',
      from: '2025-08-02',
      to: '2026-08-02',
    });
  });

  it.each(['0000-01-01', '9999-12-31'])('rejects out-of-range canonical year %s', (from) => {
    expect(() =>
      createDirectorPayrollRange('custom', new Date('2026-08-01T12:00:00.000Z'), {
        from,
        to: '2026-08-01',
      }),
    ).toThrow('year must be between 0001 and 9998');
  });
});

describe('demoDirectorPayrollPreview', () => {
  it('uses canonical machine aliases and keeps the unresolved fact outside resolved thresholds', () => {
    const { breakdown, operators, summary, unresolved } = demoDirectorPayrollPreview;
    const [unresolvedFact] = unresolved;

    expect(breakdown.map((row) => row.postName)).toEqual(['УРП', 'АВС новая']);
    expect(unresolvedFact).toMatchObject({
      reasons: ['material_class_unresolved'],
      postCode: 'DEMO-URP-UNRESOLVED',
      postName: 'УРП',
    });
    expect(unresolvedFact.postCode).toMatch(/^DEMO-(URP|MATIL|KITAYKA)-/u);
    expect(
      breakdown.every(
        (row) => row.shiftId !== unresolvedFact.shiftId && row.postId !== unresolvedFact.postId,
      ),
    ).toBe(true);
    expect(summary.payableAmountKopecks).toBe(
      breakdown.reduce((total, row) => total + row.amountKopecks, 0),
    );
    expect(summary.payableKg).toBe(breakdown.reduce((total, row) => total + row.payableKg, 0));
    expect(summary.machineShiftCount).toBe(breakdown.length);
    expect(summary.operatorCount).toBe(operators.length);
    expect(
      operators.every(
        (operator) =>
          operator.amountKopecks ===
            breakdown
              .filter((row) => row.operatorId === operator.operatorId)
              .reduce((total, row) => total + row.amountKopecks, 0) &&
          operator.payableKg ===
            breakdown
              .filter((row) => row.operatorId === operator.operatorId)
              .reduce((total, row) => total + row.payableKg, 0) &&
          operator.unresolvedFactCount ===
            unresolved.filter((fact) => fact.operatorId === operator.operatorId).length,
      ),
    ).toBe(true);
  });
});
