import type { RuntimeConfig } from './runtime-config';

type Environment = Record<string, string | undefined>;

const DEMO_ORG_KEY = '8a276db6-ce58-11e5-982d-14dae9b19a48';
const DEMO_WAREHOUSE_KEY = 'c23de3dc-cc0d-11e5-9653-3085a93ddca2';
const DEMO_GOODS_ACCOUNT_KEY = '9781b3c0-cc0d-11e5-9653-3085a93ddca2';
const DEFAULT_STOCK_NOMENCLATURE = 'PLENKA-TEST-Сырьё';

/** Secret-bearing 1C options, kept separate from the broadly injected non-secret RuntimeConfig. */
export interface OneCRuntimeOptions {
  baseUrl: string;
  goodsAccountKey: string;
  invoiceOrderReferenceField?: string | null;
  orgKey: string;
  password: string;
  stockNomenclature: string;
  timeoutMs: number;
  username: string;
  warehouseKey: string;
  writeEnabled: boolean;
}

export function loadOneCRuntimeOptions(
  env: Environment,
  config: RuntimeConfig,
): Readonly<OneCRuntimeOptions> {
  return Object.freeze({
    baseUrl: env.ONEC_BASE_URL ?? '',
    goodsAccountKey: env.ONEC_GOODS_ACCOUNT_KEY ?? DEMO_GOODS_ACCOUNT_KEY,
    invoiceOrderReferenceField: env.ONEC_INVOICE_ORDER_REFERENCE_FIELD?.trim() || null,
    orgKey: env.ONEC_ORG_KEY ?? DEMO_ORG_KEY,
    password: env.ONEC_PASSWORD ?? '',
    stockNomenclature: env.ONEC_STOCK_NOMENCLATURE ?? DEFAULT_STOCK_NOMENCLATURE,
    timeoutMs: config.onecTimeoutMs,
    username: env.ONEC_USERNAME ?? '',
    warehouseKey: env.ONEC_WAREHOUSE_KEY ?? DEMO_WAREHOUSE_KEY,
    writeEnabled: config.onecWriteEnabled,
  });
}
