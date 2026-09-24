import { loadRuntimeConfig, type RuntimeConfig } from './runtime-config';
import publicHostPolicyVectors from '../../../../deploy/vps/public-host-policy.vectors.json';

function originForHost(host: string): string {
  return host.includes(':') ? `https://[${host}]` : `https://${host}`;
}

function environmentForProfile(
  appEnv: 'development' | 'test' | 'pilot' | 'production',
  overrides: Record<string, string | undefined> = {},
) {
  const secureValues =
    appEnv === 'pilot' || appEnv === 'production'
      ? {
          AUTH_DEV_XROLE: 'off',
          DATABASE_URL:
            'postgresql://pilot_user:correct-horse-battery-staple@db:5432/plenka?schema=public',
          GATEWAY_SIMULATOR: 'off',
          PUBLIC_ORIGIN: 'https://pilot.plenka-kontur.ru',
        }
      : {};
  return { APP_ENV: appEnv, ...secureValues, ...overrides };
}

describe('loadRuntimeConfig', () => {
  it('defaults pallet labels to immutable v1 and accepts each exact profile', () => {
    const defaultConfig = loadRuntimeConfig({ APP_ENV: 'test' }) as RuntimeConfig & {
      palletLabelProfile?: string;
    };
    expect(defaultConfig.palletLabelProfile).toBe('pallet-100x150-v1');
    for (const palletLabelProfile of [
      'pallet-100x150-v1',
      'pallet-100x150-compact-v2',
      'pallet-100x100-square-v4',
      'pallet-100x100-safe-v5',
      'pallet-100x100-extended-v6',
    ]) {
      const config = loadRuntimeConfig({
        APP_ENV: 'test',
        PALLET_LABEL_PROFILE: palletLabelProfile,
      });
      expect((config as typeof defaultConfig).palletLabelProfile).toBe(palletLabelProfile);
    }
  });

  it.each([
    '',
    'pallet-100x150-v1 ',
    'Pallet-100x150-v1',
    'pallet-100x150-landscape-v3',
    'pallet-100x100-configurable-v7',
    'unknown',
  ])('rejects a blank or unknown pallet label profile (%s)', (palletLabelProfile) => {
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'test', PALLET_LABEL_PROFILE: palletLabelProfile }),
    ).toThrow('PALLET_LABEL_PROFILE');
  });

  it.each([undefined, '', 'dev', 'staging', 'Production'])(
    'rejects an omitted or unknown APP_ENV (%s)',
    (appEnv) => {
      expect(() => loadRuntimeConfig({ APP_ENV: appEnv })).toThrow(/APP_ENV/);
    },
  );

  it.each(['development', 'test'] as const)('accepts the explicit %s profile', (appEnv) => {
    expect(loadRuntimeConfig({ APP_ENV: appEnv }).appEnv).toBe(appEnv);
  });

  it('keeps the pilot short-PIN exception off by default and enables only exact pilot true', () => {
    expect(loadRuntimeConfig(environmentForProfile('pilot')).pilotShortPasswordsEnabled).toBe(
      false,
    );
    expect(
      loadRuntimeConfig(environmentForProfile('pilot', { PILOT_SHORT_PASSWORDS_ENABLED: 'true' }))
        .pilotShortPasswordsEnabled,
    ).toBe(true);
  });

  it.each(['development', 'test', 'production'] as const)(
    'rejects the pilot short-PIN exception outside APP_ENV=pilot (%s)',
    (appEnv) => {
      expect(() =>
        loadRuntimeConfig(environmentForProfile(appEnv, { PILOT_SHORT_PASSWORDS_ENABLED: 'true' })),
      ).toThrow('PILOT_SHORT_PASSWORDS_ENABLED');
    },
  );

  it.each(['on', 'TRUE', '1', 'false '])(
    'rejects a non-canonical pilot short-PIN flag (%s)',
    (value) => {
      expect(() =>
        loadRuntimeConfig(environmentForProfile('pilot', { PILOT_SHORT_PASSWORDS_ENABLED: value })),
      ).toThrow('PILOT_SHORT_PASSWORDS_ENABLED');
    },
  );

  it('enables x-role only for the exact development/on pair', () => {
    expect(
      loadRuntimeConfig({ APP_ENV: 'development', AUTH_DEV_XROLE: 'on' }).devXRoleEnabled,
    ).toBe(true);
    expect(loadRuntimeConfig({ APP_ENV: 'development' }).devXRoleEnabled).toBe(false);
    expect(loadRuntimeConfig({ APP_ENV: 'test', AUTH_DEV_XROLE: 'on' }).devXRoleEnabled).toBe(
      false,
    );
  });

  it('keeps scheduled 1C sync disabled with bounded defaults', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'development' })).toMatchObject({
      onecFinanceSyncEnabled: false,
      onecFinanceSyncIntervalMs: 300_000,
      onecPaymentSyncEnabled: false,
      onecPaymentAutoApplyEnabled: false,
      onecSyncEnabled: false,
      onecSyncIntervalMs: 900_000,
      onecSyncPageSize: 250,
    });
  });

  it('validates the bounded non-physical production-cost reconciler settings', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'test' })).toMatchObject({
      productionCostReconcilerEnabled: false,
      productionCostReconcilerIntervalMs: 60_000,
      productionCostReconcilerBatchSize: 100,
    });
    expect(
      loadRuntimeConfig({
        APP_ENV: 'test',
        PRODUCTION_COST_RECONCILER_ENABLED: 'true',
        PRODUCTION_COST_RECONCILER_INTERVAL_MS: '120000',
        PRODUCTION_COST_RECONCILER_BATCH_SIZE: '250',
      }),
    ).toMatchObject({
      productionCostReconcilerEnabled: true,
      productionCostReconcilerIntervalMs: 120_000,
      productionCostReconcilerBatchSize: 250,
    });
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'test', PRODUCTION_COST_RECONCILER_ENABLED: 'yes' }),
    ).toThrow('PRODUCTION_COST_RECONCILER_ENABLED');
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'test', PRODUCTION_COST_RECONCILER_INTERVAL_MS: '59999' }),
    ).toThrow('PRODUCTION_COST_RECONCILER_INTERVAL_MS');
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'test', PRODUCTION_COST_RECONCILER_BATCH_SIZE: '1001' }),
    ).toThrow('PRODUCTION_COST_RECONCILER_BATCH_SIZE');
  });

  it('requires explicit exact booleans for guarded finance synchronization', () => {
    expect(
      loadRuntimeConfig({
        APP_ENV: 'development',
        ONEC_BASE_URL: 'https://onec.example.com/odata',
        ONEC_FINANCE_SYNC_ENABLED: 'true',
        ONEC_LIVE: 'true',
        ONEC_PASSWORD: 'service-password',
        ONEC_PAYMENT_SYNC_ENABLED: 'true',
        ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'true',
        ONEC_USERNAME: 'service-user',
      }),
    ).toMatchObject({
      onecFinanceSyncEnabled: true,
      onecPaymentSyncEnabled: true,
      onecPaymentAutoApplyEnabled: true,
    });
    expect(() =>
      loadRuntimeConfig({
        APP_ENV: 'development',
        ONEC_PAYMENT_SYNC_ENABLED: 'yes',
      }),
    ).toThrow('ONEC_PAYMENT_SYNC_ENABLED');
  });

  it('requires a live read-only 1C adapter before scheduled sync can start', () => {
    expect(() =>
      loadRuntimeConfig({
        APP_ENV: 'development',
        ONEC_LIVE: 'false',
        ONEC_SYNC_ENABLED: 'true',
      }),
    ).toThrow('ONEC_SYNC_ENABLED');
    expect(() =>
      loadRuntimeConfig({
        APP_ENV: 'development',
        ONEC_BASE_URL: 'https://onec.example.com/odata',
        ONEC_LIVE: 'true',
        ONEC_PASSWORD: 'service-password',
        ONEC_SYNC_ENABLED: 'true',
        ONEC_USERNAME: 'service-user',
        ONEC_WRITE: 'true',
      }),
    ).toThrow('ONEC_SYNC_ENABLED');
  });

  it.each([
    { ONEC_FINANCE_SYNC_ENABLED: 'true' },
    { ONEC_PAYMENT_SYNC_ENABLED: 'true' },
    { ONEC_PAYMENT_SYNC_ENABLED: 'true', ONEC_PAYMENT_AUTO_APPLY_ENABLED: 'true' },
  ])('rejects automatic 1C activity when the live adapter is disabled', (flags) => {
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'development', ONEC_LIVE: 'false', ...flags }),
    ).toThrow(/ONEC_.*requires ONEC_LIVE=true/);
  });

  it.each([
    ['ONEC_SYNC_INTERVAL_MS', '59999'],
    ['ONEC_SYNC_INTERVAL_MS', '86400001'],
    ['ONEC_SYNC_PAGE_SIZE', '49'],
    ['ONEC_SYNC_PAGE_SIZE', '501'],
  ])('rejects an out-of-range %s value', (key, value) => {
    expect(() => loadRuntimeConfig({ APP_ENV: 'development', [key]: value })).toThrow(key);
  });

  it.each(['development', 'test', 'pilot', 'production'] as const)(
    'rejects x-role under NODE_ENV=production even when APP_ENV=%s',
    (appEnv) => {
      expect(() =>
        loadRuntimeConfig({
          APP_ENV: appEnv,
          AUTH_DEV_XROLE: 'on',
          NODE_ENV: 'production',
        }),
      ).toThrow('AUTH_DEV_XROLE');
    },
  );

  it('uses same-origin by default and parses only exact configured CORS origins', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'development' }).corsOrigins).toEqual([]);
    expect(
      loadRuntimeConfig({
        APP_ENV: 'development',
        CORS_ORIGINS: 'http://localhost:5173,https://review.example.com',
      }).corsOrigins,
    ).toEqual(['http://localhost:5173', 'https://review.example.com']);
    expect(() => loadRuntimeConfig({ APP_ENV: 'development', CORS_ORIGINS: '*' })).toThrow(
      'CORS_ORIGINS',
    );
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'development', CORS_ORIGINS: 'https://example.com/path' }),
    ).toThrow('CORS_ORIGINS');
  });

  it('requires 1C secrets only when the live adapter is enabled', () => {
    expect(
      loadRuntimeConfig({ APP_ENV: 'development', ONEC_LIVE: 'false', ONEC_WRITE: 'false' })
        .onecLiveEnabled,
    ).toBe(false);
    expect(() => loadRuntimeConfig({ APP_ENV: 'development', ONEC_LIVE: 'true' })).toThrow(
      'ONEC_BASE_URL',
    );
    expect(() =>
      loadRuntimeConfig({ APP_ENV: 'development', ONEC_LIVE: 'false', ONEC_WRITE: 'true' }),
    ).toThrow('ONEC_WRITE');
    expect(
      loadRuntimeConfig({
        APP_ENV: 'development',
        ONEC_BASE_URL: 'http://localhost/odata',
        ONEC_LIVE: 'true',
        ONEC_PASSWORD: 'service-password',
        ONEC_USERNAME: 'service-user',
      }),
    ).toMatchObject({ onecLiveEnabled: true, onecTimeoutMs: 5_000 });
    expect(() => loadRuntimeConfig({ APP_ENV: 'development', ONEC_TIMEOUT_MS: 'NaN' })).toThrow(
      'ONEC_TIMEOUT_MS',
    );
  });

  it('rejects stale 1C connection material in a disabled secure runtime', () => {
    expect(() =>
      loadRuntimeConfig(
        environmentForProfile('pilot', {
          ONEC_BASE_URL: 'https://stale-onec.example.com/odata',
          ONEC_LIVE: 'false',
        }),
      ),
    ).toThrow(/ONEC_.*must be absent/);
  });

  it.each(['development', 'test', 'pilot', 'production'] as const)(
    'defaults warehouse coverage V2 off in the %s profile',
    (appEnv) => {
      expect(loadRuntimeConfig(environmentForProfile(appEnv)).warehouseCoverageV2Enabled).toBe(
        false,
      );
    },
  );

  it.each(['development', 'test', 'pilot', 'production'] as const)(
    'accepts the exact warehouse coverage V2 true value in the %s profile',
    (appEnv) => {
      expect(
        loadRuntimeConfig(
          environmentForProfile(appEnv, {
            WAREHOUSE_COVERAGE_V2_ENABLED: 'true',
          }),
        ).warehouseCoverageV2Enabled,
      ).toBe(true);
    },
  );

  it.each(['', '1', 'False', 'TRUE'])(
    'rejects the non-exact warehouse coverage V2 value %s',
    (value) => {
      expect(() =>
        loadRuntimeConfig({
          APP_ENV: 'test',
          WAREHOUSE_COVERAGE_V2_ENABLED: value,
        }),
      ).toThrow('WAREHOUSE_COVERAGE_V2_ENABLED must be exactly "true" or "false"');
    },
  );

  it('parses bounded auth and HTTP numeric settings once', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'test' })).toMatchObject({
      loginRateMax: 10,
      loginRateMaxKeys: 10_000,
      loginRateWindowMs: 60_000,
      passwordSetupTtlSeconds: 1_800,
      port: 3_000,
      sessionTtlSeconds: 43_200,
    });
    expect(
      loadRuntimeConfig({
        APP_ENV: 'test',
        LOGIN_RATE_MAX: '4',
        LOGIN_RATE_MAX_KEYS: '500',
        LOGIN_RATE_WINDOW_MS: '30000',
        PASSWORD_SETUP_TTL: '900',
        PORT: '3100',
        SESSION_TTL: '3600',
      }),
    ).toMatchObject({
      loginRateMax: 4,
      loginRateMaxKeys: 500,
      loginRateWindowMs: 30_000,
      passwordSetupTtlSeconds: 900,
      port: 3_100,
      sessionTtlSeconds: 3_600,
    });
  });

  it('parses gateway adapter switches, stale threshold and bounded command timeout once', () => {
    expect(loadRuntimeConfig({ APP_ENV: 'test' })).toMatchObject({
      deviceGatewayPrinterEnabled: false,
      deviceGatewayScaleEnabled: false,
      gatewayCommandTimeoutMs: 5_000,
      gatewayStaleAfterSec: 90,
    });
    expect(
      loadRuntimeConfig({
        APP_ENV: 'test',
        DEVICE_GATEWAY_PRINTER: 'on',
        DEVICE_GATEWAY_SCALE: 'on',
        GATEWAY_COMMAND_TIMEOUT_MS: '10000',
        GATEWAY_STALE_AFTER_SEC: '1',
      }),
    ).toMatchObject({
      deviceGatewayPrinterEnabled: true,
      deviceGatewayScaleEnabled: true,
      gatewayCommandTimeoutMs: 10_000,
      gatewayStaleAfterSec: 1,
    });
    expect(() => loadRuntimeConfig({ APP_ENV: 'test', DEVICE_GATEWAY_SCALE: 'true' })).toThrow(
      'DEVICE_GATEWAY_SCALE',
    );
    expect(() => loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_COMMAND_TIMEOUT_MS: '99' })).toThrow(
      'GATEWAY_COMMAND_TIMEOUT_MS',
    );
    expect(() => loadRuntimeConfig({ APP_ENV: 'test', GATEWAY_STALE_AFTER_SEC: '0' })).toThrow(
      'GATEWAY_STALE_AFTER_SEC',
    );
  });

  it.each([
    ['PORT', '0'],
    ['SESSION_TTL', 'NaN'],
    ['PASSWORD_SETUP_TTL', '30'],
    ['LOGIN_RATE_MAX', '-1'],
    ['LOGIN_RATE_MAX_KEYS', '99'],
    ['LOGIN_RATE_MAX_KEYS', '100001'],
    ['LOGIN_RATE_WINDOW_MS', '0'],
  ])('rejects an unsafe numeric %s=%s', (key, value) => {
    expect(() => loadRuntimeConfig({ APP_ENV: 'test', [key]: value })).toThrow(key);
  });

  describe.each(['pilot', 'production'] as const)('%s security profile', (appEnv) => {
    const valid = {
      APP_ENV: appEnv,
      AUTH_DEV_XROLE: 'off',
      DATABASE_URL:
        'postgresql://pilot_user:correct-horse-battery-staple@db:5432/plenka?schema=public',
      GATEWAY_SIMULATOR: 'off',
      PUBLIC_ORIGIN: 'https://pilot.plenka-kontur.ru',
    };

    it('accepts a production-shaped configuration', () => {
      expect(loadRuntimeConfig(valid)).toMatchObject({
        appEnv,
        isSecureProfile: true,
        publicOrigin: 'https://pilot.plenka-kontur.ru',
      });
    });

    it.each(publicHostPolicyVectors.accepted)(
      'accepts a canonical public deployment origin (%s)',
      (publicHost) => {
        expect(
          loadRuntimeConfig({ ...valid, PUBLIC_ORIGIN: originForHost(publicHost) }),
        ).toMatchObject({ publicOrigin: originForHost(publicHost) });
      },
    );

    it.each(publicHostPolicyVectors.rejected)(
      'rejects a non-public or non-canonical public origin (%s)',
      (publicHost) => {
        expect(() =>
          loadRuntimeConfig({ ...valid, PUBLIC_ORIGIN: originForHost(publicHost) }),
        ).toThrow('PUBLIC_ORIGIN');
      },
    );

    it.each([
      ['DATABASE_URL', undefined],
      ['DATABASE_URL', 'postgresql://plenka:plenka@localhost:5433/plenka?schema=public'],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@127.9.8.7:5432/plenka',
      ],
      ['DATABASE_URL', 'postgresql://pilot_user:correct-horse-battery-staple@127.1:5432/plenka'],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@2130706433:5432/plenka',
      ],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@0x7f000001:5432/plenka',
      ],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@017700000001:5432/plenka',
      ],
      ['DATABASE_URL', 'postgresql://pilot_user:correct-horse-battery-staple@[::1]:5432/plenka'],
      ['DATABASE_URL', 'postgresql://pilot_user:correct-horse-battery-staple@[::]:5432/plenka'],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@[::ffff:127.0.0.1]:5432/plenka',
      ],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@localhost.:5432/plenka',
      ],
      ['DATABASE_URL', 'postgresql://pilot_user:%70%6c%65%6e%6b%61@db:5432/plenka'],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@db:5432/postgres?schema=public',
      ],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@db:5432/template0?schema=public',
      ],
      [
        'DATABASE_URL',
        'postgresql://pilot_user:correct-horse-battery-staple@db:5432/template1?schema=public',
      ],
      ['PUBLIC_ORIGIN', undefined],
      ['PUBLIC_ORIGIN', 'http://pilot.example.com'],
      ['PUBLIC_ORIGIN', 'https://localhost'],
      ['PUBLIC_ORIGIN', 'https://localhost.'],
      ['PUBLIC_ORIGIN', 'https://127.0.0.1'],
      ['PUBLIC_ORIGIN', 'https://127.1'],
      ['PUBLIC_ORIGIN', 'https://0.0.0.0'],
      ['PUBLIC_ORIGIN', 'https://[::1]'],
      ['PUBLIC_ORIGIN', 'https://[::]'],
      ['PUBLIC_ORIGIN', 'https://[::ffff:127.0.0.1]'],
      ['PUBLIC_ORIGIN', 'https://[::ffff:7f00:1]'],
      ['PUBLIC_ORIGIN', 'https://[::ffff:0:0]'],
      ['SEED_PASSWORD', 'plenka-dev'],
      ['SEED_PASSWORD', 'plenka-demo-shared'],
      ['AUTH_DEV_XROLE', 'on'],
      ['GATEWAY_SIMULATOR', 'on'],
    ])('rejects unsafe %s=%s', (key, value) => {
      expect(() => loadRuntimeConfig({ ...valid, [key]: value })).toThrow(key);
    });

    it('does not reflect secret values in validation errors', () => {
      const secret = 'plenka-demo-SECRET-SENTINEL';
      let message = '';
      try {
        loadRuntimeConfig({ ...valid, SEED_PASSWORD: secret });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('SEED_PASSWORD');
      expect(message).not.toContain(secret);
    });

    it('does not require an unused shared seed password at API runtime', () => {
      expect(() => loadRuntimeConfig({ ...valid, SEED_PASSWORD: undefined })).not.toThrow();
    });

    it('accepts the live 1C adapter in a secure profile with HTTPS credentials', () => {
      expect(
        loadRuntimeConfig({
          ...valid,
          ONEC_BASE_URL: 'https://onec.example.com/odata',
          ONEC_LIVE: 'true',
          ONEC_PASSWORD: 'service-password',
          ONEC_USERNAME: 'service-user',
          ONEC_WRITE: 'false',
        }),
      ).toMatchObject({ onecLiveEnabled: true, onecWriteEnabled: false });
    });

    it('requires an explicit secure-profile confirmation before enabling 1C stock writes', () => {
      expect(() =>
        loadRuntimeConfig({
          ...valid,
          ONEC_BASE_URL: 'https://onec.example.com/odata',
          ONEC_LIVE: 'true',
          ONEC_PASSWORD: 'service-password',
          ONEC_USERNAME: 'service-user',
          ONEC_WRITE: 'true',
        }),
      ).toThrow('ONEC_WRITE_CONFIRM');

      expect(
        loadRuntimeConfig({
          ...valid,
          ONEC_BASE_URL: 'https://onec.example.com/odata',
          ONEC_LIVE: 'true',
          ONEC_PASSWORD: 'service-password',
          ONEC_USERNAME: 'service-user',
          ONEC_WRITE: 'true',
          ONEC_WRITE_CONFIRM: 'I_UNDERSTAND_DEMO_1C_STOCK_POSTING',
        }),
      ).toMatchObject({ onecLiveEnabled: true, onecWriteEnabled: true });
    });
  });
});
