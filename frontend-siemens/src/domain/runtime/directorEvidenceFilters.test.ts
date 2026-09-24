import { describe, expect, it } from 'vitest';

import {
  buildBigBagEvidenceQuery,
  buildShiftEvidenceQuery,
  emptyBigBagEvidenceFilterDraft,
  emptyShiftEvidenceFilterDraft,
  parseDirectorEvidenceLocation,
  serializeDirectorEvidenceLocation,
  validateEvidenceFilterDraft,
} from './directorEvidenceFilters';

const queryContext = {
  from: '2026-07-01',
  to: '2026-07-27',
  bucket: 'day' as const,
  limit: 20,
};

describe('director evidence filter query builders', () => {
  it('preserves zero, signed deviations and trimmed text in a shift query', () => {
    const result = buildShiftEvidenceQuery(queryContext, {
      ...emptyShiftEvidenceFilterDraft,
      q: '  Анна  ',
      startKgMin: '0',
      rollCountMin: '0',
      deviationKgMin: '-5.25',
      deviationPercentMax: '+10.5',
      status: 'mismatch',
      freshness: 'stale',
    });

    expect(result).toEqual({
      ok: true,
      query: {
        ...queryContext,
        q: 'Анна',
        startKgMin: 0,
        rollCountMin: 0,
        deviationKgMin: -5.25,
        deviationPercentMax: 10.5,
        status: 'mismatch',
        freshness: 'stale',
      },
      errors: {},
    });
  });

  it('builds only valid BigBag filters and preserves endpoint enums', () => {
    const result = buildBigBagEvidenceQuery(queryContext, {
      ...emptyBigBagEvidenceFilterDraft,
      bigBagQuery: ' BB-42 ',
      materialQuery: ' ПВД ',
      bigBagStatus: 'in_use',
      usageState: 'open',
      currentKgMax: '0',
      deviationPercentMin: '-12.5',
    });

    expect(result).toEqual({
      ok: true,
      query: {
        ...queryContext,
        bigBagQuery: 'BB-42',
        materialQuery: 'ПВД',
        bigBagStatus: 'in_use',
        usageState: 'open',
        currentKgMax: 0,
        deviationPercentMin: -12.5,
      },
      errors: {},
    });
  });

  it('blocks a query when a minimum is greater than its maximum', () => {
    const draft = {
      ...emptyBigBagEvidenceFilterDraft,
      startKgMin: '100',
      startKgMax: '20',
    };

    expect(buildBigBagEvidenceQuery(queryContext, draft)).toMatchObject({
      ok: false,
      query: null,
      errors: {
        startKgMin: expect.any(String),
        startKgMax: expect.any(String),
      },
    });
    expect(validateEvidenceFilterDraft(draft)).toMatchObject({
      startKgMin: expect.any(String),
      startKgMax: expect.any(String),
    });
  });

  it(
    'rejects incomplete decimals, negative physical values, fractional counts and bad dates',
    () => {
      const result = buildShiftEvidenceQuery(queryContext, {
        ...emptyShiftEvidenceFilterDraft,
        shiftQuery: 'x'.repeat(101),
        startedFrom: '2026-02-30',
        startKgMin: '-1',
        rollCountMin: '1.5',
        deviationKgMin: '-',
      });

      expect(result).toMatchObject({
        ok: false,
        query: null,
        errors: {
          shiftQuery: expect.any(String),
          startedFrom: expect.any(String),
          startKgMin: expect.any(String),
          rollCountMin: expect.any(String),
          deviationKgMin: expect.any(String),
        },
      });
    },
  );

  it('validates date ranges jointly before a request can be built', () => {
    const result = buildBigBagEvidenceQuery(queryContext, {
      ...emptyBigBagEvidenceFilterDraft,
      openedFrom: '2026-07-20',
      openedTo: '2026-07-10',
      latestEvidenceFrom: '2026-07-22',
      latestEvidenceTo: '2026-07-21',
    });

    expect(result).toMatchObject({
      ok: false,
      query: null,
      errors: {
        openedFrom: expect.any(String),
        openedTo: expect.any(String),
        latestEvidenceFrom: expect.any(String),
        latestEvidenceTo: expect.any(String),
      },
    });
  });
});

describe('director evidence namespaced URL state', () => {
  it('round-trips independent namespaced filters and open state deterministically', () => {
    const search = serializeDirectorEvidenceLocation('?role=director', {
      shiftOpen: true,
      bigBagOpen: false,
      shift: {
        ...emptyShiftEvidenceFilterDraft,
        q: 'Анна',
        startKgMin: '20',
      },
      bigBag: {
        ...emptyBigBagEvidenceFilterDraft,
        materialQuery: 'ПВД',
      },
    });

    expect(search).toBe(
      '?role=director&sb_open=1&sb_q=%D0%90%D0%BD%D0%BD%D0%B0&sb_startKgMin=20' +
        '&bb_materialQuery=%D0%9F%D0%92%D0%94',
    );
    expect(parseDirectorEvidenceLocation(search)).toMatchObject({
      shiftOpen: true,
      bigBagOpen: false,
      shift: { q: 'Анна', startKgMin: '20' },
      bigBag: { materialQuery: 'ПВД' },
      errors: { shift: {}, bigBag: {} },
    });
  });

  it(
    'omits empty and invalid values, removes evidence cursors and preserves unrelated params',
    () => {
      const search = serializeDirectorEvidenceLocation(
        '?role=director&section=control&sb_cursor=shift-secret&bb_cursor=bag-secret',
        {
          shiftOpen: false,
          bigBagOpen: false,
          shift: {
            ...emptyShiftEvidenceFilterDraft,
            q: '   ',
            startKgMin: 'not-a-number',
          },
          bigBag: {
            ...emptyBigBagEvidenceFilterDraft,
            materialQuery: '',
            rollCountMin: '1.5',
          },
        },
      );

      expect(search).toBe('?role=director&section=control');
      expect(search).not.toContain('cursor');
    },
  );

  it('ignores an invalid URL number and reports a local field error', () => {
    const state = parseDirectorEvidenceLocation(
      '?sb_startKgMin=nope&bb_rollCountMin=1.5&bb_deviationKgMin=-2',
    );

    expect(state.shift.startKgMin).toBe('');
    expect(state.bigBag.rollCountMin).toBe('');
    expect(state.bigBag.deviationKgMin).toBe('-2');
    expect(state.errors.shift.startKgMin).toEqual(expect.any(String));
    expect(state.errors.bigBag.rollCountMin).toEqual(expect.any(String));
  });

  it('preserves numeric zero and signed deviations through the URL codec', () => {
    const search = serializeDirectorEvidenceLocation('', {
      shiftOpen: false,
      bigBagOpen: true,
      shift: {
        ...emptyShiftEvidenceFilterDraft,
        remainingKgMin: '0',
        deviationKgMin: '-4.5',
      },
      bigBag: {
        ...emptyBigBagEvidenceFilterDraft,
        bagUsageKgMax: '0',
        deviationPercentMin: '-8',
      },
    });

    expect(search).toBe(
      '?sb_remainingKgMin=0&sb_deviationKgMin=-4.5&bb_open=1' +
        '&bb_bagUsageKgMax=0&bb_deviationPercentMin=-8',
    );
    expect(parseDirectorEvidenceLocation(search)).toMatchObject({
      shift: { remainingKgMin: '0', deviationKgMin: '-4.5' },
      bigBag: { bagUsageKgMax: '0', deviationPercentMin: '-8' },
    });
  });

  it('reads old shared evidence params once and rewrites only namespaced params', () => {
    const legacy =
      '?role=director&period=week&bucket=day&q=%D0%90%D0%BD%D0%BD%D0%B0' +
      '&operatorId=operator-1&postId=post-1&shiftId=shift-1&bigBagId=bag-1' +
      '&status=mismatch';
    const restored = parseDirectorEvidenceLocation(legacy);

    expect(restored).toMatchObject({
      shift: {
        q: 'Анна',
        operatorQuery: 'operator-1',
        postQuery: 'post-1',
        shiftQuery: 'shift-1',
        status: 'mismatch',
      },
      bigBag: {
        q: 'Анна',
        bigBagQuery: 'bag-1',
        operatorQuery: 'operator-1',
        postQuery: 'post-1',
        shiftQuery: 'shift-1',
        status: 'mismatch',
      },
    });

    const rewritten = serializeDirectorEvidenceLocation(legacy, restored);
    expect(rewritten).toContain('role=director');
    expect(rewritten).toContain('period=week');
    expect(rewritten).toContain('bucket=day');
    expect(rewritten).toContain('sb_q=');
    expect(rewritten).toContain('bb_q=');
    expect(rewritten).not.toMatch(/[?&](q|operatorId|postId|shiftId|bigBagId|status)=/u);
  });
});
