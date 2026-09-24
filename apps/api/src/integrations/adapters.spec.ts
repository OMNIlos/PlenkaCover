import { MockScaleAdapter } from './scale/mock-scale.adapter';
import { MockScannerAdapter } from './scanner/mock-scanner.adapter';
import { MockPrinterAdapter } from './printer/mock-printer.adapter';
import { MockOneCAdapter } from './onec/mock-onec.adapter';

/**
 * Integration adapters are mock-first (ТЗ §11.8): deterministic test doubles behind
 * interfaces, with explicit failure paths so blocking rules can be exercised. These
 * assert the contracts call sites depend on — production adapters swap in later.
 */
describe('mock integration adapters', () => {
  it('scale: ready reading vs offline path', async () => {
    const scale = new MockScaleAdapter();
    const scaleBinding = { deviceId: 's1', expectedPostId: 'post-1', expectedKind: 'scale' as const };
    expect(await scale.read(scaleBinding, 'spool')).toMatchObject({
      status: 'ready',
      stable: true,
      grossKg: 2.0,
    });
    expect(await scale.read(scaleBinding, 'roll')).toMatchObject({ grossKg: 43.4 });
    expect(
      await scale.read({ ...scaleBinding, deviceId: 'offline-scale' }, 'roll'),
    ).toMatchObject({
      status: 'offline',
      stable: false,
    });
  });

  it('scanner: accepts only an exact opaque label token', () => {
    const scanner = new MockScannerAdapter();
    const token = `prt_${'a'.repeat(64)}`;
    expect(scanner.parse(token)).toEqual({ token, valid: true });
    expect(scanner.parse('QR-A-1')).toEqual({ token: null, valid: false });
    expect(scanner.parse('garbage')).toEqual({ token: null, valid: false });
  });

  it('printer: prints, but offline-printer fails', async () => {
    const printer = new MockPrinterAdapter();
    const printerBinding = {
      deviceId: 'p1',
      expectedPostId: 'post-1',
      expectedKind: 'printer' as const,
    };
    expect(
      await printer.print(printerBinding, {
        kind: 'roll_label',
        rollCode: 'A-1',
        qrCode: `prt_${'a'.repeat(64)}`,
      }),
    ).toMatchObject({ status: 'printed' });
    expect(
      await printer.print({ ...printerBinding, deviceId: 'offline-printer' }, {
        kind: 'roll_label',
        rollCode: 'A-1',
        qrCode: `prt_${'a'.repeat(64)}`,
      }),
    ).toMatchObject({
      status: 'failed',
      failureReason: 'offline',
    });
  });

  it('1С: returns a mock_1C snapshot with parsed + rawPayload', async () => {
    const onec = new MockOneCAdapter();
    const snap = await onec.pullInvoice('A-1024');
    expect(snap.sourceKind).toBe('mock_1C');
    expect(snap.parsed.invoiceNo).toBe('СЧ-A-1024');
    expect(snap.rawPayload).toBeDefined();
  });
});
