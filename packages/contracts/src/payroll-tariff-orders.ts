export const PAYROLL_TARIFF_TIMEZONE = 'Europe/Moscow' as const;
export const PAYROLL_TARIFF_CURRENCY = 'RUB' as const;
export const PAYROLL_TARIFF_MATRIX_SCHEMA_VERSION = 1 as const;

export const PAYROLL_TARIFF_LADDER_KEYS = [
  'urp12h',
  'urp24h',
  'abc12h',
  'abc24h',
] as const;
export type PayrollTariffLadderKey = (typeof PAYROLL_TARIFF_LADDER_KEYS)[number];

export const PAYROLL_TARIFF_ORDER_STATUSES = ['draft', 'published'] as const;
export type PayrollTariffOrderStatus = (typeof PAYROLL_TARIFF_ORDER_STATUSES)[number];

export const PAYROLL_TARIFF_ORDER_COMMAND_ACTIONS = ['create', 'update', 'publish'] as const;
export type PayrollTariffOrderCommandAction =
  (typeof PAYROLL_TARIFF_ORDER_COMMAND_ACTIONS)[number];

export const PAYROLL_TARIFF_ORDER_ERROR_CODES = [
  'PAYROLL_TARIFF_ORDER_NOT_FOUND',
  'PAYROLL_TARIFF_ORDER_DRAFT_STALE',
  'PAYROLL_TARIFF_ORDER_PUBLISHED_IMMUTABLE',
  'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_PAST_OR_TODAY',
  'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_NOT_AFTER_LATEST',
  'PAYROLL_TARIFF_ORDER_EFFECTIVE_DATE_DUPLICATE',
  'PAYROLL_TARIFF_ORDER_INVALID_MATRIX',
  'PAYROLL_TARIFF_ORDER_OPERATION_KEY_REUSED',
  'PAYROLL_TARIFF_ORDER_ALREADY_PUBLISHED',
  'PAYROLL_TARIFF_ORDER_CORRUPT',
] as const;
export type PayrollTariffOrderErrorCode = (typeof PAYROLL_TARIFF_ORDER_ERROR_CODES)[number];

export type PayrollTariffUrpBandV1 = {
  maxInclusiveGrams: number | null;
  primaryRateKopecksPerKg: number;
  secondaryRateKopecksPerKg: number;
};

export type PayrollTariffAbcBandV1 = {
  maxInclusiveGrams: number | null;
  standardRateKopecksPerKg: number;
  blackWhiteRateKopecksPerKg: number;
};

export type PayrollTariffMatrixV1 = {
  schemaVersion: typeof PAYROLL_TARIFF_MATRIX_SCHEMA_VERSION;
  ladders: {
    urp12h: PayrollTariffUrpBandV1[];
    urp24h: PayrollTariffUrpBandV1[];
    abc12h: PayrollTariffAbcBandV1[];
    abc24h: PayrollTariffAbcBandV1[];
  };
  specialRules: {
    thinRoll: {
      enabled: boolean;
      maxExclusiveGrams: number;
      rateKopecksPerKg: number;
    };
    alabuga: {
      enabled: boolean;
      machineFamily: 'abc_new';
      normalizedLegalName: string;
      rateKopecksPerKg: number;
    };
  };
};

export type PayrollTariffOrderReference = {
  id: string;
  name: string;
  effectiveFrom: string;
  currency: typeof PAYROLL_TARIFF_CURRENCY;
};

export type AppliedPayrollTariffOrder = PayrollTariffOrderReference & {
  matrix: PayrollTariffMatrixV1;
};

export type PayrollTariffOrderListItem = PayrollTariffOrderReference & {
  status: PayrollTariffOrderStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export type PayrollTariffOrderView = PayrollTariffOrderListItem & {
  matrix: PayrollTariffMatrixV1;
  createdById: string | null;
  updatedById: string | null;
  publishedById: string | null;
};

export type PayrollTariffOrderList = {
  items: PayrollTariffOrderListItem[];
  activeOrderId: string | null;
  latestPublishedOrderId: string | null;
  minimumPublishEffectiveFrom: string;
  timezone: typeof PAYROLL_TARIFF_TIMEZONE;
  generatedAt: string;
};

export type PayrollTariffOrderFieldError = {
  path: string;
  code: string;
  message: string;
};

export type PayrollTariffOrderError = {
  code: PayrollTariffOrderErrorCode;
  message: string;
  fieldErrors?: PayrollTariffOrderFieldError[];
};

export type CreatePayrollTariffOrderInput = {
  operationKey: string;
  name: string;
  effectiveFrom: string;
  matrix: PayrollTariffMatrixV1;
};

export type UpdatePayrollTariffOrderInput = CreatePayrollTariffOrderInput & {
  expectedRevision: number;
};

export type ReviewPayrollTariffOrderInput = {
  expectedRevision: number;
};

export type PublishPayrollTariffOrderInput = {
  operationKey: string;
  expectedRevision: number;
  reviewedMatrixHash: string;
};

export type PayrollTariffOrderReview = {
  orderId: string;
  revision: number;
  matrixHash: string;
  minimumPublishEffectiveFrom: string;
  publishable: boolean;
  fieldErrors: PayrollTariffOrderFieldError[];
};

export type PayrollTariffOrderResult = {
  order: PayrollTariffOrderView;
  replayed: boolean;
};
