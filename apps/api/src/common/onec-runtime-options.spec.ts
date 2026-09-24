import { loadRuntimeConfig } from './runtime-config';
import { loadOneCRuntimeOptions } from './onec-runtime-options';

describe('loadOneCRuntimeOptions', () => {
  it('takes one frozen snapshot of every validated 1C option and secret', () => {
    const env = {
      APP_ENV: 'test',
      ONEC_BASE_URL: 'https://onec.example.test/odata',
      ONEC_GOODS_ACCOUNT_KEY: 'goods-key',
      ONEC_INVOICE_ORDER_REFERENCE_FIELD: 'КомментарийПлатформы',
      ONEC_LIVE: 'true',
      ONEC_ORG_KEY: 'org-key',
      ONEC_PASSWORD: 'password-sentinel',
      ONEC_STOCK_NOMENCLATURE: 'stock-name',
      ONEC_TIMEOUT_MS: '1234',
      ONEC_USERNAME: 'username-sentinel',
      ONEC_WAREHOUSE_KEY: 'warehouse-key',
      ONEC_WRITE: 'true',
    };
    const config = loadRuntimeConfig(env);

    const options = loadOneCRuntimeOptions(env, config);
    env.ONEC_BASE_URL = 'https://mutated.example.test';
    env.ONEC_PASSWORD = 'mutated-password';

    expect(options).toEqual({
      baseUrl: 'https://onec.example.test/odata',
      goodsAccountKey: 'goods-key',
      invoiceOrderReferenceField: 'КомментарийПлатформы',
      orgKey: 'org-key',
      password: 'password-sentinel',
      stockNomenclature: 'stock-name',
      timeoutMs: 1234,
      username: 'username-sentinel',
      warehouseKey: 'warehouse-key',
      writeEnabled: true,
    });
    expect(Object.isFrozen(options)).toBe(true);
  });
});
