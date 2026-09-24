import { loadConfig } from '../config';
import { MassaKProtocol100Scale } from './massa-k/massa-k-scale';
import { buildScale } from './scale-factory';

describe('buildScale', () => {
  it('selects Protocol 100 only for its explicit mode', () => {
    const config = loadConfig(
      {
        GATEWAY_AGENT_TOKEN: 'token',
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
      },
      '/__missing__',
    );
    expect(buildScale(config)).toBeInstanceOf(MassaKProtocol100Scale);
  });
});
