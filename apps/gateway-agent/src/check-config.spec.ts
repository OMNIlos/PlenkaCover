import { runConfigCheck } from './check-config';
import { loadConfig } from './config';

describe('gateway config check command', () => {
  it('reports only the validated deployment mode', () => {
    const output = jest.fn();
    const error = jest.fn();

    expect(runConfigCheck(() => ({ deploymentMode: 'physical' }), output, error)).toBe(0);
    expect(output).toHaveBeenCalledWith('gateway configuration valid: physical\n');
    expect(error).not.toHaveBeenCalled();
  });

  it('fails without exposing the validation error or supplied secret', () => {
    const output = jest.fn();
    const error = jest.fn();

    expect(
      runConfigCheck(
        () => {
          throw new Error('invalid token ptk_private');
        },
        output,
        error,
      ),
    ).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('gateway configuration invalid\n');
  });

  it('rejects a physical deployment with a non-approved MASSA-K baud rate', () => {
    const output = jest.fn();
    const error = jest.fn();
    const env = {
      GATEWAY_DEPLOYMENT_MODE: 'physical',
      GATEWAY_API_URL: 'https://erp.plenka.ru/api',
      GATEWAY_AGENT_TOKEN: `ptk_${Buffer.from(
        Array.from({ length: 32 }, (_, index) => index),
      ).toString('base64url')}`,
      GATEWAY_POST_CODE: 'POST-1',
      GATEWAY_SCALE_DEVICE_ID: 'scale-post-1',
      GATEWAY_PRINTER_DEVICE_ID: 'printer-post-1',
      GATEWAY_SCANNER_DEVICE_ID: 'scanner-post-1',
      SCALE_MODE: 'massa-k-protocol-100',
      SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K_MK-15.2-1234',
      SCALE_SERIAL_BAUD: '38400',
      PRINTER_MODE: 'tcp9100',
      PRINTER_TCP_HOST: '192.168.10.25',
    };

    expect(runConfigCheck(() => loadConfig(env, '/__missing__'), output, error)).toBe(1);
    expect(output).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('gateway configuration invalid\n');
  });
});
