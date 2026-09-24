import { loadRuntimeConfig } from '../common/runtime-config';
import { loadOneCRuntimeOptions } from '../common/onec-runtime-options';
import { GatewayPrinterAdapter } from './gateway/gateway-printer.adapter';
import { GatewayScaleAdapter } from './gateway/gateway-scale.adapter';
import { MockOneCAdapter } from './onec/mock-onec.adapter';
import { HttpOneCAdapter } from './onec/http-onec.adapter';
import { MockPrinterAdapter } from './printer/mock-printer.adapter';
import { MockScaleAdapter } from './scale/mock-scale.adapter';
import { createOneCAdapter, createPrinterAdapter, createScaleAdapter } from './adapter-selection';

describe('validated integration adapter selection', () => {
  const dependencies = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gateway: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: {} as any,
  };

  it('keeps mock adapters as the default', () => {
    const config = loadRuntimeConfig({ APP_ENV: 'test' });
    const onecOptions = loadOneCRuntimeOptions({}, config);
    expect(createScaleAdapter(config, dependencies.prisma, dependencies.gateway)).toBeInstanceOf(
      MockScaleAdapter,
    );
    expect(createPrinterAdapter(config, dependencies.prisma, dependencies.gateway)).toBeInstanceOf(
      MockPrinterAdapter,
    );
    expect(createOneCAdapter(config, onecOptions)).toBeInstanceOf(MockOneCAdapter);
  });

  it('selects gateway and live 1C adapters only from validated switches', () => {
    const env = {
      APP_ENV: 'test',
      DEVICE_GATEWAY_PRINTER: 'on',
      DEVICE_GATEWAY_SCALE: 'on',
      ONEC_BASE_URL: 'http://localhost/odata',
      ONEC_LIVE: 'true',
      ONEC_PASSWORD: 'service-password',
      ONEC_TIMEOUT_MS: '1234',
      ONEC_USERNAME: 'service-user',
    };
    const config = loadRuntimeConfig(env);
    const onecOptions = loadOneCRuntimeOptions(env, config);
    expect(createScaleAdapter(config, dependencies.prisma, dependencies.gateway)).toBeInstanceOf(
      GatewayScaleAdapter,
    );
    expect(createPrinterAdapter(config, dependencies.prisma, dependencies.gateway)).toBeInstanceOf(
      GatewayPrinterAdapter,
    );
    const adapter = createOneCAdapter(config, onecOptions);
    expect(adapter).toBeInstanceOf(HttpOneCAdapter);
    expect(adapter).toMatchObject({
      base: 'http://localhost/odata',
      timeoutMs: 1_234,
      writeEnabled: false,
    });
  });
});
