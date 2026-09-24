import { Test } from '@nestjs/testing';
import { ONEC_RUNTIME_OPTIONS, RUNTIME_CONFIG, RuntimeConfigModule } from './runtime-config.module';
import type { RuntimeConfig } from './runtime-config';
import type { OneCRuntimeOptions } from './onec-runtime-options';

const ORIGINAL_APP_ENV = process.env.APP_ENV;
const ORIGINAL_WAREHOUSE_COVERAGE_V2_ENABLED = process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
const ORIGINAL_PALLET_LABEL_PROFILE = process.env.PALLET_LABEL_PROFILE;
const ONEC_KEYS = [
  'ONEC_BASE_URL',
  'ONEC_GOODS_ACCOUNT_KEY',
  'ONEC_INVOICE_ORDER_REFERENCE_FIELD',
  'ONEC_LIVE',
  'ONEC_ORG_KEY',
  'ONEC_PASSWORD',
  'ONEC_STOCK_NOMENCLATURE',
  'ONEC_TIMEOUT_MS',
  'ONEC_USERNAME',
  'ONEC_WAREHOUSE_KEY',
  'ONEC_WRITE',
] as const;
const ORIGINAL_ONEC_ENV = Object.fromEntries(
  ONEC_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ONEC_KEYS)[number], string | undefined>;

afterEach(() => {
  if (ORIGINAL_APP_ENV === undefined) delete process.env.APP_ENV;
  else process.env.APP_ENV = ORIGINAL_APP_ENV;
  if (ORIGINAL_WAREHOUSE_COVERAGE_V2_ENABLED === undefined) {
    delete process.env.WAREHOUSE_COVERAGE_V2_ENABLED;
  } else {
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = ORIGINAL_WAREHOUSE_COVERAGE_V2_ENABLED;
  }
  if (ORIGINAL_PALLET_LABEL_PROFILE === undefined) delete process.env.PALLET_LABEL_PROFILE;
  else process.env.PALLET_LABEL_PROFILE = ORIGINAL_PALLET_LABEL_PROFILE;
  for (const key of ONEC_KEYS) {
    const value = ORIGINAL_ONEC_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('RuntimeConfigModule startup validation', () => {
  it('publishes one validated runtime configuration object', async () => {
    process.env.APP_ENV = 'test';
    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'true';
    process.env.PALLET_LABEL_PROFILE = 'pallet-100x150-compact-v2';
    const moduleRef = await Test.createTestingModule({ imports: [RuntimeConfigModule] }).compile();
    const config = moduleRef.get<RuntimeConfig>(RUNTIME_CONFIG);

    process.env.WAREHOUSE_COVERAGE_V2_ENABLED = 'false';

    expect(config).toMatchObject({
      appEnv: 'test',
      devXRoleEnabled: false,
      port: 3_000,
      palletLabelProfile: 'pallet-100x150-compact-v2',
      warehouseCoverageV2Enabled: true,
    });
    expect(Object.isFrozen(config)).toBe(true);
    await moduleRef.close();
  });

  it('fails module startup for an unknown profile', async () => {
    process.env.APP_ENV = 'staging';
    await expect(
      Test.createTestingModule({ imports: [RuntimeConfigModule] }).compile(),
    ).rejects.toThrow('APP_ENV');
  });

  it('publishes frozen 1C options from the same immutable startup snapshot', async () => {
    Object.assign(process.env, {
      APP_ENV: 'test',
      ONEC_BASE_URL: 'https://snapshot.example.test/odata',
      ONEC_LIVE: 'true',
      ONEC_INVOICE_ORDER_REFERENCE_FIELD: 'КомментарийПлатформы',
      ONEC_PASSWORD: 'snapshot-password',
      ONEC_TIMEOUT_MS: '1300',
      ONEC_USERNAME: 'snapshot-user',
      ONEC_WRITE: 'false',
    });
    const moduleRef = await Test.createTestingModule({ imports: [RuntimeConfigModule] }).compile();
    const options = moduleRef.get<OneCRuntimeOptions>(ONEC_RUNTIME_OPTIONS);

    process.env.ONEC_BASE_URL = 'https://drift.example.test/odata';
    process.env.ONEC_PASSWORD = 'drift-password';

    expect(options).toMatchObject({
      baseUrl: 'https://snapshot.example.test/odata',
      invoiceOrderReferenceField: 'КомментарийПлатформы',
      password: 'snapshot-password',
      timeoutMs: 1_300,
      username: 'snapshot-user',
      writeEnabled: false,
    });
    expect(Object.isFrozen(options)).toBe(true);
    await moduleRef.close();
  });
});
