import { describe, expect, it, vi } from 'vitest';

import { ApiError, ApiResponseParseError } from '../../api/client';
import {
  LEGACY_PALLET_LABEL_LAYOUT_PROFILE,
  PALLET_LABEL_LAYOUT_PROFILE,
  PALLET_LIST_PROFILE_REGISTRY,
  isLivePalletListTemplateVersion,
  usesPalletBrowserSystemPrint,
  type PalletListTemplateVersion,
} from '../../domain/palletListProfiles';
import {
  warehouseBigBagPreviewMatchesProfile,
  warehouseBigBagPrintMarkup,
  warehousePalletPageSize,
  warehousePalletPrintLayout,
  warehousePalletPreviewMatchesProfile,
  warehousePalletPrintMarkup,
  WarehouseSystemPrintContinuationError,
  WarehouseSystemPrintIntentGate,
} from './warehouseBrowserPrint';

describe('pallet list profile registry', () => {
  it('derives every live guard, browser route and print dimension from one registry', () => {
    for (const [templateVersion, profile] of Object.entries(PALLET_LIST_PROFILE_REGISTRY)) {
      const version = templateVersion as PalletListTemplateVersion;
      expect(isLivePalletListTemplateVersion(version)).toBe(profile.live);
      expect(usesPalletBrowserSystemPrint(version)).toBe(profile.printTransport === 'browser');
      expect(warehousePalletPageSize(version)).toEqual({
        widthMm: profile.widthMm,
        heightMm: profile.heightMm,
      });
      expect(
        warehousePalletPreviewMatchesProfile(
          version,
          profile.previewWidthPx,
          profile.previewHeightPx,
        ),
      ).toBe(true);
    }
  });

  it('keeps v7 as the browser-only current editor profile and v6 as its legacy alias', () => {
    expect(PALLET_LABEL_LAYOUT_PROFILE).toBe('pallet-100x100-configurable-v7');
    expect(LEGACY_PALLET_LABEL_LAYOUT_PROFILE).toBe('pallet-100x100-extended-v6');
    expect(PALLET_LIST_PROFILE_REGISTRY[PALLET_LABEL_LAYOUT_PROFILE].printTransport).toBe(
      'browser',
    );
    expect(usesPalletBrowserSystemPrint(PALLET_LABEL_LAYOUT_PROFILE)).toBe(true);
    expect(PALLET_LIST_PROFILE_REGISTRY['pallet-100x150-v1'].printTransport).toBe('gateway');
    expect(PALLET_LIST_PROFILE_REGISTRY['pallet-100x150-compact-v2'].printTransport).toBe(
      'gateway',
    );
  });
});

describe('warehouseBigBagPrintMarkup', () => {
  it('prints the immutable Big-Bag QR preview on the exact 58 × 50 mm profile', () => {
    const markup = warehouseBigBagPrintMarkup('blob:bigbag-preview');

    expect(markup).toContain('@page { size: 58mm 50mm; margin: 0; }');
    expect(markup).toContain('html, body { width: 58mm; height: 50mm');
    expect(markup).toContain('id="bigbag-preview"');
    expect(markup).toContain('src="blob:bigbag-preview"');
    expect(markup.match(/<img /g)).toHaveLength(1);
    expect(warehouseBigBagPreviewMatchesProfile(464, 400)).toBe(true);
    expect(warehouseBigBagPreviewMatchesProfile(400, 464)).toBe(false);
  });

  it('escapes the Big-Bag preview URL before placing it in the print document', () => {
    const markup = warehouseBigBagPrintMarkup('blob:value" onload="bad');

    expect(markup).toContain('blob:value&quot; onload=&quot;bad');
    expect(markup).not.toContain('src="blob:value" onload=');
  });
});

describe('warehousePalletPrintMarkup', () => {
  it.each([
    [
      'pallet-100x150-v1',
      {
        pageWidthMm: 100,
        pageHeightMm: 150,
        imageWidthMm: 100,
        imageHeightMm: 150,
        imageOffsetLeftMm: 0,
        imageOffsetTopMm: 0,
        rotationDegrees: 0,
        layoutMarker: null,
      },
    ],
    [
      'pallet-100x100-square-v4',
      {
        pageWidthMm: 100,
        pageHeightMm: 100,
        imageWidthMm: 71.5,
        imageHeightMm: 71.5,
        imageOffsetLeftMm: 2,
        imageOffsetTopMm: 2,
        rotationDegrees: 0,
        layoutMarker: 'square-v4-safe-71_5',
      },
    ],
    [
      'pallet-100x100-configurable-v7',
      {
        pageWidthMm: 100,
        pageHeightMm: 100,
        imageWidthMm: 96,
        imageHeightMm: 96,
        imageOffsetLeftMm: 2,
        imageOffsetTopMm: 2,
        rotationDegrees: 0,
        layoutMarker: 'configurable-v7-immutable',
      },
    ],
  ] as const)(
    'derives the visible and printed geometry for %s from one profile',
    (version, expected) => {
      expect(warehousePalletPrintLayout(version)).toEqual(expected);
    },
  );

  it.each(['pallet-100x150-v1', 'pallet-100x150-compact-v2'] as const)(
    'prints %s on an exact 100 × 150 mm page',
    (templateVersion) => {
      const markup = warehousePalletPrintMarkup('blob:pallet-preview', templateVersion);

      expect(markup).toContain('@page { size: 100mm 150mm; margin: 0; }');
      expect(markup).toContain('width: 100mm; height: 150mm');
      expect(markup).not.toContain('transform: rotate(90deg)');
      expect(markup).not.toContain('data-print-layout=');
      expect(markup).not.toContain('margin: 2mm');
      expect(markup.match(/<img /g)).toHaveLength(1);
      expect(markup).toContain('src="blob:pallet-preview"');
    },
  );

  it('keeps the immutable square-v4 preview inside the proven Windows safe box', () => {
    const markup = warehousePalletPrintMarkup('blob:pallet-preview', 'pallet-100x100-square-v4');

    expect(markup).toContain('@page { size: 100mm 100mm; margin: 0; }');
    expect(markup).toContain('html, body { width: 100mm; height: 100mm');
    expect(markup).toContain('width: 71.5mm; height: 71.5mm; margin: 2mm');
    expect(markup).toContain('data-print-layout="square-v4-safe-71_5"');
    expect(markup).not.toContain('transform: rotate(');
    expect(markup).not.toContain('transform-origin:');
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it('prints the immutable safe-v5 preview unrotated on an exact 100 × 100 mm page', () => {
    const markup = warehousePalletPrintMarkup('blob:pallet-preview', 'pallet-100x100-safe-v5');

    expect(markup).toContain('@page { size: 100mm 100mm; margin: 0; }');
    expect(markup).toContain('width: 100mm; height: 100mm');
    expect(markup).toContain('data-print-layout="safe-v5-immutable"');
    expect(markup).not.toContain('transform: rotate(');
    expect(markup).not.toContain('margin: 2mm');
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it('prints the immutable extended-v6 preview unscaled and unrotated on 100 × 100 mm', () => {
    const markup = warehousePalletPrintMarkup('blob:pallet-preview', 'pallet-100x100-extended-v6');

    expect(markup).toContain('@page { size: 100mm 100mm; margin: 0; }');
    expect(markup).toContain('html, body { width: 100mm; height: 100mm');
    expect(markup).toContain('img { display: block; width: 100mm; height: 100mm;');
    expect(markup).toContain('data-print-layout="extended-v6-immutable"');
    expect(markup).not.toContain('transform: rotate(');
    expect(markup).not.toContain('margin: 2mm');
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it('keeps configurable-v7 inside the physical printer safe margin without crop', () => {
    const markup = warehousePalletPrintMarkup(
      'blob:document-pinned-preview',
      'pallet-100x100-configurable-v7',
    );

    expect(markup).toContain('@page { size: 100mm 100mm; margin: 0; }');
    expect(markup).toContain('img { display: block; width: 96mm; height: 96mm; margin: 2mm;');
    expect(markup).toContain('src="blob:document-pinned-preview"');
    expect(markup).toContain('data-print-layout="configurable-v7-immutable"');
    expect(markup).not.toContain('transform: rotate(');
    expect(markup).not.toContain('object-fit: cover');
    expect(markup.match(/<img /g)).toHaveLength(1);
  });

  it('rejects an unknown runtime profile instead of guessing page dimensions', () => {
    expect(() => warehousePalletPageSize('pallet-landscape-v3' as never)).toThrow(
      'Неизвестный формат палетного листа.',
    );
  });

  it('fails closed when immutable preview pixels do not match its profile', () => {
    expect(warehousePalletPreviewMatchesProfile('pallet-100x150-compact-v2', 800, 1200)).toBe(true);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-square-v4', 800, 800)).toBe(true);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-square-v4', 800, 1200)).toBe(false);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-safe-v5', 800, 800)).toBe(true);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-safe-v5', 1200, 800)).toBe(false);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-extended-v6', 800, 800)).toBe(true);
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-extended-v6', 800, 1200)).toBe(
      false,
    );
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-configurable-v7', 800, 800)).toBe(
      true,
    );
    expect(warehousePalletPreviewMatchesProfile('pallet-100x100-configurable-v7', 799, 800)).toBe(
      false,
    );
  });

  it('escapes the generated blob URL before placing it in the print document', () => {
    const markup = warehousePalletPrintMarkup(
      'blob:value" onload="bad',
      'pallet-100x100-square-v4',
    );

    expect(markup).toContain('blob:value&quot; onload=&quot;bad');
    expect(markup).not.toContain('src="blob:value" onload=');
  });
});

describe('WarehouseSystemPrintIntentGate', () => {
  it.each([
    new TypeError('network'),
    new ApiError(408, 'timeout'),
    new ApiError(503, 'unavailable'),
    new ApiResponseParseError(200, new SyntaxError('invalid json')),
  ])('reuses requestId after an ambiguous mutation failure', async (failure) => {
    const gate = new WarehouseSystemPrintIntentGate();
    const submit = vi
      .fn<(requestId: string) => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce((requestId) => Promise.resolve(requestId));

    await expect(gate.run(submit)).rejects.toBe(failure);
    expect(gate.hasPendingRetry()).toBe(true);
    await gate.run(submit);

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]?.[0]).toBe(submit.mock.calls[0]?.[0]);
    expect(gate.hasPendingRetry()).toBe(false);
  });

  it('retires requestId after a confirmed response and after a definitive rejection', async () => {
    const gate = new WarehouseSystemPrintIntentGate();
    const success = vi.fn((requestId: string) => Promise.resolve(requestId));
    const definiteFailure = vi
      .fn<(requestId: string) => Promise<void>>()
      .mockRejectedValueOnce(new ApiError(409, 'conflict'))
      .mockResolvedValueOnce();

    await gate.run(success);
    await gate.run(success);
    await expect(gate.run(definiteFailure)).rejects.toBeInstanceOf(ApiError);
    await gate.run(definiteFailure);

    expect(success.mock.calls[1]?.[0]).not.toBe(success.mock.calls[0]?.[0]);
    expect(definiteFailure.mock.calls[1]?.[0]).not.toBe(definiteFailure.mock.calls[0]?.[0]);
  });

  it('reuses requestId when the intent was recorded but the local print window failed', async () => {
    const gate = new WarehouseSystemPrintIntentGate();
    const submit = vi
      .fn<(requestId: string) => Promise<string>>()
      .mockRejectedValueOnce(
        new WarehouseSystemPrintContinuationError(new Error('Окно печати не открылось')),
      )
      .mockImplementationOnce((requestId) => Promise.resolve(requestId));

    await expect(gate.run(submit)).rejects.toThrow('Окно печати не открылось');
    await gate.run(submit);

    expect(submit.mock.calls[1]?.[0]).toBe(submit.mock.calls[0]?.[0]);
  });

  it('executes one submission for concurrent calls of the same intent', async () => {
    const gate = new WarehouseSystemPrintIntentGate();
    let resolveSubmission!: (value: string) => void;
    const submission = new Promise<string>((resolve) => {
      resolveSubmission = resolve;
    });
    const submit = vi.fn<(requestId: string) => Promise<string>>().mockReturnValue(submission);

    const first = gate.run(submit);
    const second = gate.run(submit);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    resolveSubmission('done');
    await expect(first).resolves.toBe('done');
  });

  it('keeps a continuation retry bound to its immutable business intent', async () => {
    const gate = new WarehouseSystemPrintIntentGate();
    const first = vi
      .fn<(requestId: string) => Promise<void>>()
      .mockRejectedValue(
        new WarehouseSystemPrintContinuationError(new Error('Окно печати не открылось')),
      );
    const changed = vi.fn<(requestId: string) => Promise<void>>().mockResolvedValue();

    await expect(
      (gate.run as unknown as (submit: typeof first, intentKey: string) => Promise<void>)(
        first,
        'bag-1:Этикетка повреждена',
      ),
    ).rejects.toThrow('Окно печати не открылось');
    await expect(
      (gate.run as unknown as (submit: typeof changed, intentKey: string) => Promise<void>)(
        changed,
        'bag-1:Другая причина',
      ),
    ).rejects.toThrow('Незавершённую системную печать нельзя изменить');

    expect(changed).not.toHaveBeenCalled();
  });
});
