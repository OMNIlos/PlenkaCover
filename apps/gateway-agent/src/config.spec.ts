import { randomBytes } from 'node:crypto';
import { loadConfig } from './config';

const CWD_WITHOUT_ENV = '/__plenka_gateway_agent_missing_env__';

describe('gateway printer profile config', () => {
  it('defaults to the MERTECH TLP4 203 dpi profile with enough width for 100 mm', () => {
    const config = loadConfig({ GATEWAY_AGENT_TOKEN: 'token' }, CWD_WITHOUT_ENV);

    expect(config.printerDpi).toBe(203);
    expect(config.printerMaxWidthDots).toBe(864);
  });

  it('rejects a 300 dpi profile because the approved bitmap is rendered for 203 dpi', () => {
    expect(() =>
      loadConfig({ GATEWAY_AGENT_TOKEN: 'token', PRINTER_DPI: '300' }, CWD_WITHOUT_ENV),
    ).toThrow(/PRINTER_DPI/);
  });

  it('rejects a printer width below the fixed 800-dot pallet label', () => {
    expect(() =>
      loadConfig({ GATEWAY_AGENT_TOKEN: 'token', PRINTER_MAX_WIDTH_DOTS: '799' }, CWD_WITHOUT_ENV),
    ).toThrow(/PRINTER_MAX_WIDTH_DOTS/);
  });
});

describe('MASSA-K Protocol 100 config', () => {
  it('defaults Protocol 100 physical mode to 57600 baud', () => {
    const config = loadConfig(
      {
        GATEWAY_AGENT_TOKEN: 'token',
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
      },
      CWD_WITHOUT_ENV,
    );

    expect(config.scaleSerialBaud).toBe(57_600);
  });

  it('keeps the legacy serial adapter default at 9600 baud', () => {
    const config = loadConfig(
      {
        GATEWAY_AGENT_TOKEN: 'token',
        SCALE_MODE: 'serial',
        SCALE_SERIAL_PORT: '/dev/ttyUSB0',
      },
      CWD_WITHOUT_ENV,
    );

    expect(config.scaleSerialBaud).toBe(9_600);
  });

  it('accepts the explicit physical mode and stable Ubuntu serial path', () => {
    const config = loadConfig(
      {
        GATEWAY_AGENT_TOKEN: 'token',
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        SCALE_SERIAL_BAUD: '57600',
      },
      CWD_WITHOUT_ENV,
    );
    expect(config).toMatchObject({
      scaleMode: 'massa-k-protocol-100',
      scaleSerialPort: '/dev/serial/by-id/usb-MASSA-K-test',
      scaleSerialBaud: 57_600,
    });
  });

  it('lets an explicit baud rate override the mode-specific default', () => {
    const config = loadConfig(
      {
        GATEWAY_AGENT_TOKEN: 'token',
        SCALE_MODE: 'massa-k-protocol-100',
        SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        SCALE_SERIAL_BAUD: '38400',
      },
      CWD_WITHOUT_ENV,
    );

    expect(config.scaleSerialBaud).toBe(38_400);
  });

  it('requires a serial path in physical mode', () => {
    expect(() =>
      loadConfig(
        { GATEWAY_AGENT_TOKEN: 'token', SCALE_MODE: 'massa-k-protocol-100' },
        CWD_WITHOUT_ENV,
      ),
    ).toThrow(/SCALE_SERIAL_PORT/);
  });

  it('allows the local scale probe to run without a platform token', () => {
    expect(() =>
      loadConfig(
        {
          SCALE_MODE: 'massa-k-protocol-100',
          SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-test',
        },
        CWD_WITHOUT_ENV,
        { requireAgentToken: false },
      ),
    ).not.toThrow();
  });
});

describe('physical deployment guard', () => {
  const physical = {
    GATEWAY_DEPLOYMENT_MODE: 'physical',
    GATEWAY_API_URL: 'https://erp.plenka.ru/api',
    GATEWAY_AGENT_TOKEN: `ptk_${randomBytes(32).toString('base64url')}`,
    GATEWAY_POST_CODE: 'POST-1',
    GATEWAY_SCALE_DEVICE_ID: 'scale-post-1',
    GATEWAY_PRINTER_DEVICE_ID: 'printer-post-1',
    GATEWAY_SCANNER_DEVICE_ID: 'scanner-post-1',
    SCANNER_HID_PATH: '/dev/input/by-id/usb-0581_011a-event-kbd',
    SCALE_MODE: 'massa-k-protocol-100',
    SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K_MK-15.2-1234',
    SCALE_SERIAL_BAUD: '57600',
    PRINTER_MODE: 'tcp9100',
    PRINTER_TCP_HOST: '192.168.10.25',
  };

  it('accepts only the explicit approved Ubuntu physical topology', () => {
    expect(loadConfig(physical, CWD_WITHOUT_ENV)).toMatchObject({
      deploymentMode: 'physical',
      apiUrl: 'https://erp.plenka.ru/api',
      scaleMode: 'massa-k-protocol-100',
      printerMode: 'tcp9100',
      scaleSerialPort: '/dev/serial/by-id/usb-MASSA-K_MK-15.2-1234',
      scannerHidPath: '/dev/input/by-id/usb-0581_011a-event-kbd',
    });
  });

  it('accepts the verified MASSA-K RS-232 Protocol 100 serial profile', () => {
    expect(
      loadConfig(
        {
          ...physical,
          SCALE_SERIAL_BAUD: '4800',
          SCALE_SERIAL_PARITY: 'even',
        },
        CWD_WITHOUT_ENV,
      ),
    ).toMatchObject({
      scaleSerialBaud: 4_800,
      scaleSerialParity: 'even',
    });
  });

  it('rejects the operator queue as the warehouse destination in physical mode', () => {
    expect(() =>
      loadConfig(
        {
          ...physical,
          PRINTER_MODE: 'cups-zpl',
          PRINTER_TCP_HOST: undefined,
          PRINTER_CUPS_QUEUE: 'TLP4',
          PRINTER_WAREHOUSE_CUPS_QUEUE: 'TLP4',
        },
        CWD_WITHOUT_ENV,
      ),
    ).toThrow(/separate from PRINTER_CUPS_QUEUE/u);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a %s warehouse queue in physical CUPS mode', (_case, warehouseQueue) => {
    expect(() =>
      loadConfig(
        {
          ...physical,
          PRINTER_MODE: 'cups-zpl',
          PRINTER_TCP_HOST: undefined,
          PRINTER_CUPS_QUEUE: 'TLP4',
          PRINTER_WAREHOUSE_CUPS_QUEUE: warehouseQueue,
        },
        CWD_WITHOUT_ENV,
      ),
    ).toThrow(/PRINTER_WAREHOUSE_CUPS_QUEUE/u);
  });

  it('accepts a separate named CUPS queue for warehouse Big-Bag and pallet labels', () => {
    expect(
      loadConfig(
        {
          ...physical,
          PRINTER_MODE: 'cups-zpl',
          PRINTER_TCP_HOST: undefined,
          PRINTER_CUPS_QUEUE: 'TLP4',
          PRINTER_WAREHOUSE_CUPS_QUEUE: 'TLP4_WH',
        },
        CWD_WITHOUT_ENV,
      ),
    ).toMatchObject({
      printerCupsQueue: 'TLP4',
      printerWarehouseCupsQueue: 'TLP4_WH',
    });
  });

  it.each(['replace-printer', 'TLP4;shutdown'])(
    'rejects an unsafe warehouse CUPS queue %s',
    (warehouseQueue) => {
      expect(() =>
        loadConfig(
          {
            ...physical,
            PRINTER_MODE: 'cups-zpl',
            PRINTER_TCP_HOST: undefined,
            PRINTER_CUPS_QUEUE: 'TLP4',
            PRINTER_WAREHOUSE_CUPS_QUEUE: warehouseQueue,
          },
          CWD_WITHOUT_ENV,
        ),
      ).toThrow(/PRINTER_WAREHOUSE_CUPS_QUEUE/u);
    },
  );

  it('keeps a physical post alive with the scanner offline when an older env has no HID path', () => {
    expect(
      loadConfig(
        {
          ...physical,
          SCANNER_HID_PATH: undefined,
        },
        CWD_WITHOUT_ENV,
      ),
    ).toMatchObject({
      deploymentMode: 'physical',
      scannerDeviceId: 'scanner-post-1',
      scannerHidPath: null,
    });
  });

  it.each([
    ['missing queue', undefined],
    ['placeholder queue', 'replace-printer'],
    ['unsafe queue', 'TLP4;shutdown'],
  ])('rejects a %s in physical CUPS mode', (_case, queue) => {
    expect(() =>
      loadConfig(
        {
          ...physical,
          PRINTER_MODE: 'cups-zpl',
          PRINTER_TCP_HOST: undefined,
          PRINTER_CUPS_QUEUE: queue,
        },
        CWD_WITHOUT_ENV,
      ),
    ).toThrow(/PRINTER_CUPS_QUEUE/u);
  });

  it.each([
    ['HTTP API', { GATEWAY_API_URL: 'http://plenka.example/api' }, /trusted HTTPS/u],
    ['localhost API', { GATEWAY_API_URL: 'https://localhost/api' }, /trusted HTTPS/u],
    ['loopback API', { GATEWAY_API_URL: 'https://127.0.0.1/api' }, /trusted HTTPS/u],
    ['documentation API', { GATEWAY_API_URL: 'https://erp.example/api' }, /trusted HTTPS/u],
    ['placeholder API', { GATEWAY_API_URL: 'https://replace-host/api' }, /trusted HTTPS/u],
    ['wrong API path', { GATEWAY_API_URL: 'https://erp.plenka.ru/' }, /trusted HTTPS/u],
    ['trailing API slash', { GATEWAY_API_URL: 'https://erp.plenka.ru/api/' }, /trusted HTTPS/u],
    ['API query', { GATEWAY_API_URL: 'https://erp.plenka.ru/api?token=x' }, /trusted HTTPS/u],
    ['weak agent token', { GATEWAY_AGENT_TOKEN: 'physical-agent-token' }, /GATEWAY_AGENT_TOKEN/u],
    ['simulated scale', { SCALE_MODE: 'simulated' }, /SCALE_MODE/u],
    ['legacy scale', { SCALE_MODE: 'serial' }, /SCALE_MODE/u],
    ['unsupported scale baud', { SCALE_SERIAL_BAUD: '38400' }, /SCALE_SERIAL_BAUD/u],
    ['simulated printer', { PRINTER_MODE: 'simulated' }, /PRINTER_MODE/u],
    [
      'Windows printer',
      { PRINTER_MODE: 'windows-command', PRINTER_WINDOWS_COMMAND: 'print {file}' },
      /PRINTER_MODE/u,
    ],
    ['unstable tty path', { SCALE_SERIAL_PORT: '/dev/ttyUSB0' }, /\/dev\/serial\/by-id/u],
    [
      'traversing by-id path',
      { SCALE_SERIAL_PORT: '/dev/serial/by-id/../ttyUSB0' },
      /\/dev\/serial\/by-id/u,
    ],
    [
      'placeholder by-id path',
      { SCALE_SERIAL_PORT: '/dev/serial/by-id/usb-MASSA-K-example' },
      /\/dev\/serial\/by-id/u,
    ],
    ['documentation printer IP', { PRINTER_TCP_HOST: '192.0.2.10' }, /PRINTER_TCP_HOST/u],
    ['placeholder printer host', { PRINTER_TCP_HOST: '<printer-ip>' }, /PRINTER_TCP_HOST/u],
    ['placeholder post id', { GATEWAY_POST_CODE: 'replace-post' }, /GATEWAY_POST_CODE/u],
    ['implicit post id', { GATEWAY_POST_CODE: undefined }, /GATEWAY_POST_CODE/u],
    [
      'placeholder scale id',
      { GATEWAY_SCALE_DEVICE_ID: 'replace-with-scale-id' },
      /GATEWAY_SCALE_DEVICE_ID/u,
    ],
    ['implicit scale id', { GATEWAY_SCALE_DEVICE_ID: undefined }, /GATEWAY_SCALE_DEVICE_ID/u],
    [
      'development scale id',
      { GATEWAY_SCALE_DEVICE_ID: 'dev-scale-1' },
      /GATEWAY_SCALE_DEVICE_ID/u,
    ],
    [
      'placeholder printer id',
      { GATEWAY_PRINTER_DEVICE_ID: 'example-printer' },
      /GATEWAY_PRINTER_DEVICE_ID/u,
    ],
    ['implicit printer id', { GATEWAY_PRINTER_DEVICE_ID: undefined }, /GATEWAY_PRINTER_DEVICE_ID/u],
    ['implicit scanner id', { GATEWAY_SCANNER_DEVICE_ID: undefined }, /GATEWAY_SCANNER_DEVICE_ID/u],
    ['unstable scanner path', { SCANNER_HID_PATH: '/dev/input/event21' }, /SCANNER_HID_PATH/u],
    [
      'development scanner id',
      { GATEWAY_SCANNER_DEVICE_ID: 'dev-scanner-1' },
      /GATEWAY_SCANNER_DEVICE_ID/u,
    ],
  ])('rejects %s in physical deployment', (_case, override, message) => {
    expect(() => loadConfig({ ...physical, ...override }, CWD_WITHOUT_ENV)).toThrow(message);
  });

  it('keeps development defaults available without claiming physical readiness', () => {
    expect(loadConfig({ GATEWAY_AGENT_TOKEN: 'token' }, CWD_WITHOUT_ENV)).toMatchObject({
      deploymentMode: 'development',
      scaleMode: 'simulated',
      printerMode: 'simulated',
    });
  });
});
