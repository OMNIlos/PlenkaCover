import { BadRequestException, ValidationPipe } from '@nestjs/common';
import {
  DirectorAnalyticsBigBagEvidenceQueryDto,
  DirectorAnalyticsEvidenceQueryDto,
  DirectorAnalyticsQueryDto,
  DirectorAnalyticsShiftEvidenceQueryDto,
  DirectorOperatorRollVarianceQueryDto,
} from './analytics-query.dto';
import {
  DirectorAccountingMaterialPointResponseDto,
  DirectorAccountingProductionCoverageResponseDto,
  DirectorAccountingProductionPointResponseDto,
  DirectorAccountingProductionResponseDto,
  DirectorAccountingProductionSourceResponseDto,
  DirectorAnalyticsBigBagEvidencePageResponseDto,
  DirectorAnalyticsBigBagEvidenceResponseDto,
  DirectorAnalyticsMaterialSpendPointResponseDto,
  DirectorAnalyticsOperatorOverPlanResponseDto,
  DirectorAnalyticsOverPlanSeriesPointResponseDto,
  DirectorAnalyticsOverPlanTotalResponseDto,
  DirectorAnalyticsBigBagResponseDto,
  DirectorAnalyticsBigBagSnapshotResponseDto,
  DirectorAnalyticsEvidenceBagLinkResponseDto,
  DirectorAnalyticsEvidenceSourceResponseDto,
  DirectorAnalyticsProductionQualityPointResponseDto,
  DirectorAnalyticsResponseDto,
  DirectorAnalyticsShiftBalanceResponseDto,
  DirectorAnalyticsShiftEvidencePageResponseDto,
  DirectorAnalyticsShiftEvidenceResponseDto,
  DirectorAnalyticsSpoolEvidenceResponseDto,
  DirectorAnalyticsTopOperatorResponseDto,
  DirectorCommercialApplicationPeriodResponseDto,
  DirectorCommercialApplicationsResponseDto,
  DirectorOperatorRollVariancePageResponseDto,
  DirectorOperatorRollVarianceResponseDto,
} from './analytics-response.dto';

const SWAGGER_MODEL_PROPERTIES = 'swagger/apiModelProperties';
const SWAGGER_MODEL_PROPERTIES_ARRAY = 'swagger/apiModelPropertiesArray';

const pipe = new ValidationPipe({
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
});

async function validateQuery(value: unknown) {
  return pipe.transform(value, { type: 'query', metatype: DirectorAnalyticsQueryDto });
}

async function validateRollVarianceQuery(value: unknown) {
  return pipe.transform(value, {
    type: 'query',
    metatype: DirectorOperatorRollVarianceQueryDto,
  });
}

async function validateEvidenceQuery(value: unknown) {
  return pipe.transform(value, {
    type: 'query',
    metatype: DirectorAnalyticsEvidenceQueryDto,
  });
}

type EvidenceQueryDto = new () => object;

async function validateEndpointEvidenceQuery(metatype: EvidenceQueryDto, value: unknown) {
  return pipe.transform(value, { type: 'query', metatype });
}

async function endpointEvidenceValidationMessages(metatype: EvidenceQueryDto, value: unknown) {
  try {
    await validateEndpointEvidenceQuery(metatype, value);
    return [];
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
}

async function validationMessages(
  value: unknown,
  validator: (candidate: unknown) => Promise<unknown> = validateQuery,
) {
  try {
    await validator(value);
    return [];
  } catch (error) {
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
}

describe('DirectorAnalyticsQueryDto', () => {
  it.each([
    '2023-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-7-01',
    '2026-07-1',
    '2026-07-01T00:00:00Z',
    ' 2026-07-01',
  ])('rejects impossible or non-strict date %s', async (invalidDate) => {
    await expect(
      validationMessages({ from: invalidDate, to: '2026-07-31', bucket: 'day' }),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects the unsupported year-9999 edge before next-boundary calculation', async () => {
    await expect(
      validationMessages({ from: '9999-12-31', to: '9999-12-31', bucket: 'day' }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts the final public date while keeping year 9999 private', async () => {
    await expect(
      validateQuery({ from: '9998-12-31', to: '9998-12-31', bucket: 'day' }),
    ).resolves.toEqual({
      from: '9998-12-31',
      to: '9998-12-31',
      bucket: 'day',
    });
  });

  it.each(['0001-01-01', '0001-03-31', '0001-06-30'])(
    'rejects as-of date %s when its six-month window would underflow',
    async (to) => {
      await expect(validationMessages({ from: to, to, bucket: 'day' })).resolves.toContain(
        'to must be on or after 0001-07-01 to support six-month analytics windows',
      );
    },
  );

  it('accepts the earliest as-of date with a representable six-month window', async () => {
    await expect(
      validateQuery({ from: '0001-01-01', to: '0001-07-01', bucket: 'month' }),
    ).resolves.toEqual(
      expect.objectContaining({ from: '0001-01-01', to: '0001-07-01', bucket: 'month' }),
    );
  });

  it('documents the minimum supported as-of date', () => {
    const metadata = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsQueryDto.prototype,
      'to',
    ) as { description: string };

    expect(metadata.description).toContain('0001-07-01');
  });

  it('rejects a reversed local date range', async () => {
    await expect(
      validationMessages({ from: '2026-07-22', to: '2026-07-21', bucket: 'day' }),
    ).resolves.toContain('to must be on or after from and span no more than 366 days');
  });

  it('rejects a range longer than 366 inclusive Moscow days', async () => {
    await expect(
      validationMessages({ from: '2024-01-01', to: '2025-01-01', bucket: 'week' }),
    ).resolves.toContain('to must be on or after from and span no more than 366 days');
  });

  it('accepts exactly 366 inclusive Moscow days across a leap day', async () => {
    await expect(
      validateQuery({ from: '2024-01-01', to: '2024-12-31', bucket: 'month' }),
    ).resolves.toEqual(
      expect.objectContaining({ from: '2024-01-01', to: '2024-12-31', bucket: 'month' }),
    );
  });

  it.each(['hour', 'quarter', '', undefined])('rejects unsupported bucket %p', async (bucket) => {
    await expect(
      validationMessages({ from: '2026-07-01', to: '2026-07-31', bucket }),
    ).resolves.not.toHaveLength(0);
  });

  it.each(['from', 'to'] as const)('requires the %s date', async (missing) => {
    const value: Record<string, unknown> = {
      from: '2026-07-01',
      to: '2026-07-31',
      bucket: 'day',
    };
    delete value[missing];

    await expect(validationMessages(value)).resolves.not.toHaveLength(0);
  });

  it('rejects unknown query fields at the HTTP boundary', async () => {
    await expect(
      validationMessages({
        from: '2026-07-01',
        to: '2026-07-31',
        bucket: 'day',
        rawPayload: 'must-not-pass',
      }),
    ).resolves.toContain('property rawPayload should not exist');
  });
});

describe('DirectorOperatorRollVarianceQueryDto', () => {
  const range = { from: '2026-07-01', to: '2026-07-31' };

  it('defaults the page limit to 20', async () => {
    await expect(validateRollVarianceQuery(range)).resolves.toEqual({
      ...range,
      limit: 20,
    });
  });

  it.each([1, 100, '1', '100'])('accepts page limit boundary %p', async (limit) => {
    await expect(validateRollVarianceQuery({ ...range, limit })).resolves.toEqual({
      ...range,
      limit: Number(limit),
    });
  });

  it.each([0, 101, -1, 1.5, 'not-a-number'])('rejects invalid page limit %p', async (limit) => {
    await expect(
      validationMessages({ ...range, limit }, validateRollVarianceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts a 500-character opaque cursor and rejects 501 characters', async () => {
    await expect(validateRollVarianceQuery({ ...range, cursor: 'a'.repeat(500) })).resolves.toEqual(
      {
        ...range,
        cursor: 'a'.repeat(500),
        limit: 20,
      },
    );
    await expect(
      validationMessages({ ...range, cursor: 'a'.repeat(501) }, validateRollVarianceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects a provided empty cursor', async () => {
    await expect(
      validationMessages({ ...range, cursor: '' }, validateRollVarianceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('applies strict Moscow date and range validation without an aggregate-only window floor', async () => {
    await expect(
      validationMessages({ from: '2026-07-31', to: '2026-07-01' }, validateRollVarianceQuery),
    ).resolves.toContain('to must be on or after from and span no more than 366 days');
    await expect(
      validateRollVarianceQuery({ from: '0001-01-01', to: '0001-01-01' }),
    ).resolves.toEqual({
      from: '0001-01-01',
      to: '0001-01-01',
      limit: 20,
    });
  });

  it('accepts the final public date and still rejects year 9999', async () => {
    await expect(
      validateRollVarianceQuery({ from: '9998-12-31', to: '9998-12-31' }),
    ).resolves.toEqual({
      from: '9998-12-31',
      to: '9998-12-31',
      limit: 20,
    });
    await expect(
      validationMessages({ from: '9999-01-01', to: '9999-01-01' }, validateRollVarianceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('rejects unknown page query fields', async () => {
    await expect(
      validationMessages({ ...range, rawPayload: 'must-not-pass' }, validateRollVarianceQuery),
    ).resolves.toContain('property rawPayload should not exist');
  });
});

describe('DirectorAnalyticsEvidenceQueryDto', () => {
  const range = {
    from: '2026-07-01',
    to: '2026-07-31',
    bucket: 'day',
  };

  it.each([
    ['operatorId', 'operator-1'],
    ['postId', 'post-1'],
    ['shiftId', 'shift-1'],
    ['bigBagId', 'bag-1'],
    ['status', 'mismatch'],
    ['q', 'Machine One'],
  ] as const)('accepts the %s server evidence filter', async (field, value) => {
    await expect(validateEvidenceQuery({ ...range, [field]: value })).resolves.toEqual({
      ...range,
      [field]: value,
      limit: 20,
    });
  });

  it('accepts filter combinations without dropping the stable page controls', async () => {
    await expect(
      validateEvidenceQuery({
        ...range,
        operatorId: 'operator-1',
        postId: 'post-1',
        shiftId: 'shift-1',
        bigBagId: 'bag-1',
        status: 'ok',
        q: '  BB-001  ',
        cursor: 'a'.repeat(500),
        limit: '100',
      }),
    ).resolves.toEqual({
      ...range,
      operatorId: 'operator-1',
      postId: 'post-1',
      shiftId: 'shift-1',
      bigBagId: 'bag-1',
      status: 'ok',
      q: 'BB-001',
      cursor: 'a'.repeat(500),
      limit: 100,
    });
  });

  it.each(['operatorId', 'postId', 'shiftId', 'bigBagId'] as const)(
    'rejects a blank %s predicate',
    async (field) => {
      await expect(
        validationMessages({ ...range, [field]: '   ' }, validateEvidenceQuery),
      ).resolves.not.toHaveLength(0);
    },
  );

  it.each(['', 'resolved', 'available', 'MISMATCH'])(
    'rejects unsupported evidence status %p',
    async (status) => {
      await expect(
        validationMessages({ ...range, status }, validateEvidenceQuery),
      ).resolves.not.toHaveLength(0);
    },
  );

  it('rejects an empty normalized search and overlong identifiers', async () => {
    await expect(
      validationMessages({ ...range, q: '   ' }, validateEvidenceQuery),
    ).resolves.not.toHaveLength(0);
    await expect(
      validationMessages({ ...range, operatorId: 'a'.repeat(101) }, validateEvidenceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it.each([1, 100, '1', '100'])('accepts page limit boundary %p', async (limit) => {
    await expect(validateEvidenceQuery({ ...range, limit })).resolves.toEqual({
      ...range,
      limit: Number(limit),
    });
  });

  it.each([0, 101, -1, 1.5, 'not-a-number'])('rejects invalid page limit %p', async (limit) => {
    await expect(
      validationMessages({ ...range, limit }, validateEvidenceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts a 500-character cursor and rejects empty or 501-character cursors', async () => {
    await expect(validateEvidenceQuery({ ...range, cursor: 'a'.repeat(500) })).resolves.toEqual({
      ...range,
      cursor: 'a'.repeat(500),
      limit: 20,
    });
    await expect(
      validationMessages({ ...range, cursor: '' }, validateEvidenceQuery),
    ).resolves.not.toHaveLength(0);
    await expect(
      validationMessages({ ...range, cursor: 'a'.repeat(501) }, validateEvidenceQuery),
    ).resolves.not.toHaveLength(0);
  });

  it('keeps strict dates and rejects unknown evidence fields', async () => {
    await expect(
      validationMessages(
        { ...range, from: '2026-07-32', rawPayload: 'forbidden' },
        validateEvidenceQuery,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        'from must be a supported calendar date in YYYY-MM-DD format',
        'property rawPayload should not exist',
      ]),
    );
  });
});

describe('endpoint-specific director evidence query DTOs', () => {
  const validRange = {
    from: '2026-07-01',
    to: '2026-07-31',
    bucket: 'day',
  };
  const shiftDecimalRanges = [
    ['startKgMin', 'startKgMax'],
    ['remainingKgMin', 'remainingKgMax'],
    ['actualUsageKgMin', 'actualUsageKgMax'],
    ['expectedUsageKgMin', 'expectedUsageKgMax'],
    ['producedKgMin', 'producedKgMax'],
    ['defectKgMin', 'defectKgMax'],
  ] as const;
  const bigBagDecimalRanges = [
    ['startKgMin', 'startKgMax'],
    ['endKgMin', 'endKgMax'],
    ['currentKgMin', 'currentKgMax'],
    ['bagUsageKgMin', 'bagUsageKgMax'],
    ['actualUsageKgMin', 'actualUsageKgMax'],
    ['expectedUsageKgMin', 'expectedUsageKgMax'],
    ['producedKgMin', 'producedKgMax'],
    ['defectKgMin', 'defectKgMax'],
  ] as const;
  const countRanges = [
    ['rollCountMin', 'rollCountMax'],
    ['defectCountMin', 'defectCountMax'],
    ['unverifiedDefectCountMin', 'unverifiedDefectCountMax'],
  ] as const;
  const signedRanges = [
    ['deviationKgMin', 'deviationKgMax'],
    ['deviationPercentMin', 'deviationPercentMax'],
  ] as const;

  it.each([
    ['operatorId', ' operator-1 ', 'operator-1'],
    ['postId', ' post-1 ', 'post-1'],
    ['shiftId', ' shift-1 ', 'shift-1'],
    ['bigBagId', ' bag-1 ', 'bag-1'],
    ['q', ' search phrase ', 'search phrase'],
    ['operatorQuery', ' Ирина ', 'Ирина'],
    ['postQuery', ' POST-1 ', 'POST-1'],
    ['shiftQuery', ' Смена 1 ', 'Смена 1'],
  ])('trims shared text filter %s', async (field, value, expected) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        [field]: value,
      }),
    ).resolves.toMatchObject({ [field]: expected });
  });

  it.each([
    ['bigBagQuery', ' BB-001 ', 'BB-001'],
    ['materialQuery', ' ПВД ', 'ПВД'],
  ])('trims BigBag text filter %s', async (field, value, expected) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        [field]: value,
      }),
    ).resolves.toMatchObject({ [field]: expected });
  });

  it.each(['pending', 'ok', 'mismatch'])('accepts evidence status %s', async (status) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        status,
      }),
    ).resolves.toMatchObject({ status });
  });

  it.each(['fresh', 'stale', 'unknown'])('accepts evidence freshness %s', async (freshness) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        freshness,
      }),
    ).resolves.toMatchObject({ freshness });
  });

  it.each(['available', 'in_use', 'consumed'])('accepts BigBag status %s', async (bigBagStatus) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        bigBagStatus,
      }),
    ).resolves.toMatchObject({ bigBagStatus });
  });

  it.each(['open', 'closed'])('accepts BigBag usage state %s', async (usageState) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        usageState,
      }),
    ).resolves.toMatchObject({ usageState });
  });

  it.each([
    'latestEvidenceFrom',
    'latestEvidenceTo',
    'startedFrom',
    'startedTo',
    'endedFrom',
    'endedTo',
  ])('validates shift date filter %s', async (field) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        [field]: '2026-07-15',
      }),
    ).resolves.toMatchObject({ [field]: '2026-07-15' });
    await expect(
      endpointEvidenceValidationMessages(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        [field]: '2026-02-30',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it.each([
    'latestEvidenceFrom',
    'latestEvidenceTo',
    'openedFrom',
    'openedTo',
    'closedFrom',
    'closedTo',
  ])('validates BigBag date filter %s', async (field) => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        [field]: '2026-07-15',
      }),
    ).resolves.toMatchObject({ [field]: '2026-07-15' });
    await expect(
      endpointEvidenceValidationMessages(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        [field]: '2026-02-30',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it.each([...shiftDecimalRanges.flat(), ...countRanges.flat(), ...signedRanges.flat()])(
    'coerces shift numeric filter %s',
    async (field) => {
      const value = field.includes('Count') ? '2' : '1.25';
      await expect(
        validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
          ...validRange,
          [field]: value,
        }),
      ).resolves.toMatchObject({ [field]: Number(value) });
    },
  );

  it.each([...bigBagDecimalRanges.flat(), ...countRanges.flat(), ...signedRanges.flat()])(
    'coerces BigBag numeric filter %s',
    async (field) => {
      const value = field.includes('Count') ? '2' : '1.25';
      await expect(
        validateEndpointEvidenceQuery(DirectorAnalyticsBigBagEvidenceQueryDto, {
          ...validRange,
          [field]: value,
        }),
      ).resolves.toMatchObject({ [field]: Number(value) });
    },
  );

  it.each([...shiftDecimalRanges.flat(), ...countRanges.flatMap(([min]) => [min])])(
    'rejects negative non-deviation shift filter %s',
    async (field) => {
      await expect(
        endpointEvidenceValidationMessages(DirectorAnalyticsShiftEvidenceQueryDto, {
          ...validRange,
          [field]: '-0.1',
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it.each([...bigBagDecimalRanges.flat(), ...countRanges.flatMap(([min]) => [min])])(
    'rejects negative BigBag weight/count filter %s',
    async (field) => {
      await expect(
        endpointEvidenceValidationMessages(DirectorAnalyticsBigBagEvidenceQueryDto, {
          ...validRange,
          [field]: '-0.1',
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it.each(countRanges.flat())('rejects fractional shift count %s', async (field) => {
    await expect(
      endpointEvidenceValidationMessages(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        [field]: '1.5',
      }),
    ).resolves.not.toHaveLength(0);
  });

  it('accepts a negative deviation range', async () => {
    await expect(
      validateEndpointEvidenceQuery(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        deviationKgMin: '-5',
        deviationKgMax: '2',
        deviationPercentMin: '-10.5',
        deviationPercentMax: '3.25',
      }),
    ).resolves.toMatchObject({
      deviationKgMin: -5,
      deviationKgMax: 2,
      deviationPercentMin: -10.5,
      deviationPercentMax: 3.25,
    });
  });

  it.each([...shiftDecimalRanges, ...countRanges, ...signedRanges])(
    'rejects reversed shift range %s/%s',
    async (minField, maxField) => {
      await expect(
        endpointEvidenceValidationMessages(DirectorAnalyticsShiftEvidenceQueryDto, {
          ...validRange,
          [minField]: '20',
          [maxField]: '10',
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it.each([...bigBagDecimalRanges, ...countRanges, ...signedRanges])(
    'rejects reversed BigBag range %s/%s',
    async (minField, maxField) => {
      await expect(
        endpointEvidenceValidationMessages(DirectorAnalyticsBigBagEvidenceQueryDto, {
          ...validRange,
          [minField]: '20',
          [maxField]: '10',
        }),
      ).resolves.not.toHaveLength(0);
    },
  );

  it('keeps endpoint-specific fields separate', async () => {
    await expect(
      endpointEvidenceValidationMessages(DirectorAnalyticsShiftEvidenceQueryDto, {
        ...validRange,
        materialQuery: 'ПВД',
      }),
    ).resolves.toContain('property materialQuery should not exist');
    await expect(
      endpointEvidenceValidationMessages(DirectorAnalyticsBigBagEvidenceQueryDto, {
        ...validRange,
        remainingKgMin: '1',
      }),
    ).resolves.toContain('property remainingKgMin should not exist');
  });
});

describe('director analytics response Swagger contract', () => {
  it('documents backend-owned payroll on every Control balance', () => {
    const properties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      DirectorAnalyticsShiftBalanceResponseDto.prototype,
    ) as string[];

    expect(properties.map((property) => property.replace(/^:/, ''))).toContain('payroll');
  });

  it('documents every safe top-level projection explicitly', () => {
    const properties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      DirectorAnalyticsResponseDto.prototype,
    ) as string[];

    expect(properties.map((property) => property.replace(/^:/, ''))).toEqual([
      'range',
      'productionSeries',
      'materialSeries',
      'shiftBalances',
      'bigBags',
      'operatorOverPlan',
      'productionQualitySeries',
      'materialSpendSeries',
      'spoolEvidence',
      'commercialApplications',
      'accountingProduction',
    ]);
  });

  it.each([
    [
      DirectorAccountingProductionSourceResponseDto,
      ['sourceKind', 'label', 'latestImportedAt', 'latestDocumentDate', 'stale'],
    ],
    [
      DirectorAccountingProductionCoverageResponseDto,
      ['documentCount', 'excludedOutputLineCount', 'excludedMaterialLineCount'],
    ],
    [
      DirectorAccountingProductionPointResponseDto,
      ['bucketStartDate', 'documentCount', 'producedKg'],
    ],
    [DirectorAccountingMaterialPointResponseDto, ['bucketStartDate', 'consumedKg']],
    [
      DirectorAccountingProductionResponseDto,
      ['source', 'coverage', 'productionSeries', 'materialSeries'],
    ],
    [
      DirectorAnalyticsOverPlanSeriesPointResponseDto,
      ['bucketStartDate', 'affectedRollCount', 'affectedOperatorCount', 'overPlanKg'],
    ],
    [
      DirectorAnalyticsOverPlanTotalResponseDto,
      ['period', 'fromDate', 'toDate', 'affectedRollCount', 'affectedOperatorCount', 'overPlanKg'],
    ],
    [
      DirectorAnalyticsTopOperatorResponseDto,
      ['operatorId', 'operatorName', 'affectedRollCount', 'overPlanKg'],
    ],
    [
      DirectorAnalyticsOperatorOverPlanResponseDto,
      ['series', 'totals', 'topOperators', 'missingPlanCount', 'missingActorCount'],
    ],
    [
      DirectorAnalyticsProductionQualityPointResponseDto,
      [
        'id',
        'bucketStartDate',
        'producedRollCount',
        'producedKg',
        'defectRecordCount',
        'defectiveRollCount',
        'verifiedDefectKg',
        'unverifiedDefectCount',
        'returnedSpoolCount',
      ],
    ],
    [
      DirectorAnalyticsMaterialSpendPointResponseDto,
      [
        'bucketStartDate',
        'consumedGranulesKg',
        'recordedSpoolCount',
        'recordedSpoolTareKg',
        'missingSpoolEvidenceCount',
      ],
    ],
    [DirectorAnalyticsSpoolEvidenceResponseDto, ['availability', 'explanation']],
    [
      DirectorCommercialApplicationPeriodResponseDto,
      ['period', 'fromDate', 'toDate', 'totalCount', 'clientOrderCount', 'stockReserveCount'],
    ],
    [DirectorCommercialApplicationsResponseDto, ['definition', 'asOfDate', 'periods']],
    [
      DirectorAnalyticsEvidenceSourceResponseDto,
      ['usage', 'production', 'defects', 'latestEvidenceAt', 'freshness'],
    ],
    [
      DirectorAnalyticsEvidenceBagLinkResponseDto,
      [
        'usageId',
        'bigBagId',
        'bigBagCode',
        'materialId',
        'material',
        'bigBagStatus',
        'startKg',
        'endKg',
        'currentKg',
        'currentMeasuredAt',
        'currentFreshness',
        'openedAt',
        'closedAt',
      ],
    ],
    [
      DirectorAnalyticsShiftEvidenceResponseDto,
      [
        'sessionId',
        'shiftId',
        'shiftLabel',
        'operatorId',
        'operatorName',
        'postId',
        'postCode',
        'postName',
        'startedAt',
        'endedAt',
        'bigBags',
        'startKg',
        'endKg',
        'currentKg',
        'actualUsageKg',
        'expectedUsageKg',
        'producedKg',
        'rollCount',
        'defectKg',
        'defectCount',
        'unverifiedDefectCount',
        'deviationKg',
        'deviationPercent',
        'status',
        'source',
      ],
    ],
    [
      DirectorAnalyticsBigBagEvidenceResponseDto,
      [
        'id',
        'bigBagId',
        'bigBagCode',
        'materialId',
        'material',
        'bigBagStatus',
        'sessionId',
        'shiftId',
        'shiftLabel',
        'operatorId',
        'operatorName',
        'postId',
        'postCode',
        'postName',
        'openedAt',
        'closedAt',
        'startKg',
        'endKg',
        'currentKg',
        'currentMeasuredAt',
        'priceKopecksPerKg',
        'totalKopecks',
        'priceEffectiveAt',
        'bagUsageKg',
        'actualUsageKg',
        'expectedUsageKg',
        'calculatedRemainderKg',
        'producedKg',
        'rollCount',
        'defectKg',
        'defectCount',
        'unverifiedDefectCount',
        'deviationKg',
        'deviationPercent',
        'balanceScope',
        'status',
        'source',
      ],
    ],
    [DirectorAnalyticsShiftEvidencePageResponseDto, ['items', 'nextCursor']],
    [DirectorAnalyticsBigBagEvidencePageResponseDto, ['items', 'nextCursor']],
  ])('documents every field on %s', (dto, expected) => {
    const properties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      dto.prototype,
    ) as string[];

    expect(properties.map((property) => property.replace(/^:/, ''))).toEqual(expected);
  });

  it('documents evidence source freshness as an explicit non-boolean state', () => {
    const freshness = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsEvidenceSourceResponseDto.prototype,
      'freshness',
    ) as { enum: string[] };

    expect(freshness.enum).toEqual(['fresh', 'stale', 'unknown']);
  });

  it('documents pending closed-session balances without inventing actual usage', () => {
    const status = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsShiftBalanceResponseDto.prototype,
      'status',
    ) as { enum: string[] };
    const actual = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsShiftBalanceResponseDto.prototype,
      'actualUsageKg',
    ) as { nullable: boolean };

    expect(status.enum).toEqual(['pending', 'ok', 'mismatch']);
    expect(actual.nullable).toBe(true);
  });

  it('does not imply an unprovable per-session defect attribution', () => {
    const properties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      DirectorAnalyticsShiftBalanceResponseDto.prototype,
    ) as string[];

    expect(properties.map((property) => property.replace(/^:/, ''))).not.toContain('defectKg');
  });

  it('keeps a distinct snapshot object while allowing legacy measurement gaps', () => {
    const snapshot = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsBigBagResponseDto.prototype,
      'currentSnapshot',
    ) as { nullable?: boolean };
    const measuredKg = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsBigBagSnapshotResponseDto.prototype,
      'measuredKg',
    ) as { nullable?: boolean };
    const measuredAt = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES,
      DirectorAnalyticsBigBagSnapshotResponseDto.prototype,
      'measuredAt',
    ) as { nullable?: boolean };

    expect(snapshot.nullable).not.toBe(true);
    expect(measuredKg.nullable).toBe(true);
    expect(measuredAt.nullable).toBe(true);
  });

  it('documents every safe operator-roll variance field and page envelope', () => {
    const itemProperties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      DirectorOperatorRollVarianceResponseDto.prototype,
    ) as string[];
    const pageProperties = Reflect.getMetadata(
      SWAGGER_MODEL_PROPERTIES_ARRAY,
      DirectorOperatorRollVariancePageResponseDto.prototype,
    ) as string[];

    expect(itemProperties.map((property) => property.replace(/^:/, ''))).toEqual([
      'operatorId',
      'operatorName',
      'orderId',
      'orderNumber',
      'rollId',
      'rollCode',
      'producedAt',
      'actualCapturedAt',
      'plannedKg',
      'actualKg',
      'varianceKg',
      'overPlanKg',
      'provenance',
    ]);
    expect(pageProperties.map((property) => property.replace(/^:/, ''))).toEqual([
      'items',
      'nextCursor',
    ]);
  });
});
