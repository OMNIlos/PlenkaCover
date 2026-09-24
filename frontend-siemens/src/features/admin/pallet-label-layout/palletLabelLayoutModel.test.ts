import { describe, expect, it } from 'vitest';

import {
  analyzePalletLabelLayout,
  commitLayoutHistory,
  createLayoutHistory,
  moveLayoutElement,
  removeLayoutElement,
  parsePalletLabelLayoutPublication,
  parsePalletLabelEditorBootstrap,
  parsePalletLayoutDraft,
  redoLayoutHistory,
  restoreLayoutElement,
  resizeLayoutElement,
  serializePalletLayoutDraft,
  undoLayoutHistory,
  updateLayoutElement,
  type PalletLabelLayout,
} from './palletLabelLayoutModel';
import { bootstrapFixture, legacyLayoutFixture } from './palletLabelLayoutTestFixtures';

const layout = (): PalletLabelLayout => structuredClone(bootstrapFixture.editorLayout);

describe('pallet label layout geometry', () => {
  it('snaps movable blocks to the 1 mm grid and clamps them to the canvas', () => {
    const moved = moveLayoutElement(layout(), 'order', 3, 790, bootstrapFixture.canvas);
    const order = moved.elements.find((element) => element.id === 'order');

    expect(order).toMatchObject({ xDots: 0, yDots: 738 });
  });

  it('keeps the QR envelope immutable across move, resize and numeric edits', () => {
    const original = layout();
    const moved = moveLayoutElement(original, 'qr', 20, 20, bootstrapFixture.canvas);
    const resized = resizeLayoutElement(moved, 'qr', 128, 128, bootstrapFixture.canvas);
    const edited = updateLayoutElement(
      resized,
      'qr',
      { xDots: 40, yDots: 40, maxFontSize: 99 },
      bootstrapFixture.canvas,
    );

    expect(edited).toEqual(original);
  });

  it('resizes a text block on-grid without leaving the canvas', () => {
    const resized = resizeLayoutElement(layout(), 'order', 1_000, 67, bootstrapFixture.canvas);
    const order = resized.elements.find((element) => element.id === 'order');

    expect(order).toMatchObject({ widthDots: 764, heightDots: 64 });
  });

  it('clamps editable font sizes to the server-supported upper bound', () => {
    const updated = updateLayoutElement(
      layout(),
      'order',
      { maxFontSize: 1_000 },
      bootstrapFixture.canvas,
    );

    expect(updated.elements.find((element) => element.id === 'order')?.maxFontSize).toBe(96);
  });
});

describe('pallet label layout editor sources', () => {
  it('accepts the control source first and preserves its safe server label', () => {
    const bootstrap = parsePalletLabelEditorBootstrap({
      ...bootstrapFixture,
      sources: [
        {
          ...bootstrapFixture.sources[0],
          documentId: 'control-pallet-label-layout-v1',
          kind: 'control',
          label: 'Контрольный синтетический источник',
        },
        {
          ...bootstrapFixture.sources[0],
          documentId: 'document-1',
          kind: 'document',
          palletId: 'PAL-A-2-05',
          createdAt: '2026-08-09T19:00:00.000Z',
          rollCount: 1,
          label: 'Палетный лист PAL-A-2-05',
        },
      ],
    });

    expect(bootstrap.sources).toEqual([
      {
        documentId: 'control-pallet-label-layout-v1',
        kind: 'control',
        label: 'Контрольный синтетический источник',
        palletId: 'CONTROL-VALIDATION-01',
        createdAt: '2026-01-01T00:00:00.000Z',
        rollCount: 24,
      },
      {
        documentId: 'document-1',
        kind: 'document',
        label: 'Палетный лист PAL-A-2-05',
        palletId: 'PAL-A-2-05',
        createdAt: '2026-08-09T19:00:00.000Z',
        rollCount: 1,
      },
    ]);
  });

  it('rejects an empty, reordered, unknown-kind, or unsafe source response', () => {
    const controlSource = {
      ...bootstrapFixture.sources[0],
      documentId: 'control-pallet-label-layout-v1',
      kind: 'control',
      label: 'Контрольный синтетический источник',
    };
    const documentSource = {
      ...bootstrapFixture.sources[0],
      documentId: 'document-1',
      kind: 'document',
      label: 'Палетный лист PAL-A-2-05',
    };

    for (const sources of [
      [],
      [documentSource, controlSource],
      [{ ...controlSource, kind: 'device' }],
      [{ ...controlSource, label: 'Палетный лист PAL-A-2-05' }],
      [{ ...documentSource, label: 'Контрольный синтетический источник' }],
      [{ ...documentSource, label: '' }],
    ]) {
      expect(() =>
        parsePalletLabelEditorBootstrap({ ...bootstrapFixture, sources }),
      ).toThrow();
    }
  });
});

describe('pallet label layout diagnostics', () => {
  it('keeps the enlarged six-block baseline inside the proven print height', () => {
    expect(analyzePalletLabelLayout(layout(), bootstrapFixture.canvas)).toEqual({
      beyondProvenCut: [],
      outsideSafeArea: [],
      overlaps: [],
    });
  });

  it('permits in-canvas placement outside the safe inset and diagnoses it', () => {
    const moved = moveLayoutElement(layout(), 'order', 0, 32, bootstrapFixture.canvas);

    expect(moved.elements.find((element) => element.id === 'order')?.xDots).toBe(0);
    expect(analyzePalletLabelLayout(moved, bootstrapFixture.canvas).outsideSafeArea).toContain(
      'order',
    );
  });

  it('reports every intersecting block pair', () => {
    const withOverlap = moveLayoutElement(layout(), 'storage', 500, 300, bootstrapFixture.canvas);

    expect(analyzePalletLabelLayout(withOverlap, bootstrapFixture.canvas).overlaps).toContainEqual([
      'qr',
      'storage',
    ]);
  });
});

describe('pallet label layout history', () => {
  it('undoes and redoes one committed pointer gesture as one state', () => {
    const initial = layout();
    const moved = moveLayoutElement(initial, 'order', 80, 96, bootstrapFixture.canvas);
    const history = commitLayoutHistory(createLayoutHistory(initial), moved);

    expect(undoLayoutHistory(history).present).toEqual(initial);
    expect(redoLayoutHistory(undoLayoutHistory(history)).present).toEqual(moved);
  });
});

describe('pallet label system-block catalog', () => {
  it('removes any optional block but never the pallet-list QR', () => {
    const initial = layout();
    const withoutCustomer = removeLayoutElement(initial, 'customer');

    expect(withoutCustomer.elements.map((element) => element.id)).toEqual([
      'order',
      'formedAt',
      'rollCount',
      'qr',
      'storage',
    ]);
    expect(removeLayoutElement(initial, 'qr')).toBe(initial);
  });

  it('restores a missing block once with its canonical readable geometry', () => {
    const withoutCustomer = removeLayoutElement(layout(), 'customer');
    const restored = restoreLayoutElement(withoutCustomer, 'customer');
    const restoredTwice = restoreLayoutElement(restored, 'customer');

    expect(restored.elements).toEqual(layout().elements);
    expect(restoredTwice).toBe(restored);
  });

  it('tracks remove and restore as ordinary undoable editor states', () => {
    const initial = layout();
    const removed = removeLayoutElement(initial, 'storage');
    const restored = restoreLayoutElement(removed, 'storage');
    const afterRemove = commitLayoutHistory(createLayoutHistory(initial), removed);
    const afterRestore = commitLayoutHistory(afterRemove, restored);

    expect(undoLayoutHistory(afterRestore).present).toEqual(removed);
    expect(redoLayoutHistory(undoLayoutHistory(afterRestore)).present).toEqual(restored);
  });
});

describe('versioned pallet label layout JSON', () => {
  it('round-trips a local draft with its selected source', () => {
    const json = serializePalletLayoutDraft({ sourceDocumentId: 'doc-1', layout: layout() });

    expect(parsePalletLayoutDraft(json, bootstrapFixture.canvas)).toEqual({
      kind: 'plenka-pallet-label-layout-draft',
      schemaVersion: 2,
      sourceDocumentId: 'doc-1',
      layout: layout(),
    });
  });

  it('canonicalizes imported block order before canvas and server preview use it', () => {
    const reversed = { ...layout(), elements: [...layout().elements].reverse() };
    const parsed = parsePalletLayoutDraft(
      serializePalletLayoutDraft({ sourceDocumentId: 'doc-1', layout: reversed }),
      bootstrapFixture.canvas,
    );

    expect(parsed.layout.elements.map((element) => element.id)).toEqual([
      'order',
      'customer',
      'formedAt',
      'rollCount',
      'qr',
      'storage',
    ]);
  });

  it.each([
    '{"schemaVersion":1}',
    JSON.stringify({
      kind: 'plenka-pallet-label-layout-draft',
      schemaVersion: 2,
      sourceDocumentId: 'doc-1',
      layout: {
        ...layout(),
        elements: layout().elements.map((element) =>
          element.id === 'qr' ? { ...element, locked: false } : element,
        ),
      },
    }),
  ])('rejects incompatible or unlocked-QR imports', (json) => {
    expect(() => parsePalletLayoutDraft(json, bootstrapFixture.canvas)).toThrow();
  });

  it('round-trips a draft without a preview source', () => {
    const json = serializePalletLayoutDraft({ sourceDocumentId: '', layout: layout() });

    expect(parsePalletLayoutDraft(json, bootstrapFixture.canvas).sourceDocumentId).toBe('');
  });

  it('rejects old schema drafts and legacy fields instead of importing them into V2', () => {
    expect(() =>
      parsePalletLayoutDraft(
        JSON.stringify({
          kind: 'plenka-pallet-label-layout-draft',
          schemaVersion: 1,
          sourceDocumentId: 'doc-1',
          layout: legacyLayoutFixture,
        }),
        bootstrapFixture.canvas,
      ),
    ).toThrow(/версия/i);
  });

  it.each([
    ['envelope', { extra: true }],
    ['layout', { layout: { ...layout(), extra: true } }],
    [
      'element',
      {
        layout: {
          ...layout(),
          elements: layout().elements.map((element) =>
            element.id === 'order' ? { ...element, extra: true } : element,
          ),
        },
      },
    ],
  ])('rejects unknown fields in the %s', (_label, patch) => {
    const envelope = {
      kind: 'plenka-pallet-label-layout-draft',
      schemaVersion: 2,
      sourceDocumentId: 'doc-1',
      layout: layout(),
      ...patch,
    };

    expect(() => parsePalletLayoutDraft(JSON.stringify(envelope), bootstrapFixture.canvas)).toThrow(
      /неизвестное поле/i,
    );
  });

  it('rejects non-finite numeric JSON values', () => {
    const json = serializePalletLayoutDraft({ sourceDocumentId: '', layout: layout() }).replace(
      '"xDots": 36',
      '"xDots": 1e309',
    );

    expect(() => parsePalletLayoutDraft(json, bootstrapFixture.canvas)).toThrow();
  });

  it.each([
    ['minimum below 6 px', { minFontSize: 5 }],
    ['maximum above 96 px', { maxFontSize: 97 }],
  ])('rejects an imported font range with %s', (_label, fontPatch) => {
    const invalidLayout = {
      ...layout(),
      elements: layout().elements.map((element) =>
        element.id === 'order' ? { ...element, ...fontPatch } : element,
      ),
    };
    const json = serializePalletLayoutDraft({
      sourceDocumentId: 'doc-1',
      layout: invalidLayout,
    });

    expect(() => parsePalletLayoutDraft(json, bootstrapFixture.canvas)).toThrow(/шрифт/i);
  });

  it('accepts an imported in-canvas block outside the safe inset', () => {
    const outsideSafe = {
      ...layout(),
      elements: layout().elements.map((element) =>
        element.id === 'order' ? { ...element, xDots: 0 } : element,
      ),
    };
    const json = serializePalletLayoutDraft({ sourceDocumentId: 'doc-1', layout: outsideSafe });

    expect(
      parsePalletLayoutDraft(json, bootstrapFixture.canvas).layout.elements.find(
        (element) => element.id === 'order',
      )?.xDots,
    ).toBe(0);
  });
});

describe('pallet label layout bootstrap parsing', () => {
  it('treats an absent activePublication as no publication during frontend-first rollout', () => {
    const { activePublication: _activePublication, ...legacyBootstrap } = bootstrapFixture;

    expect(parsePalletLabelEditorBootstrap(legacyBootstrap).activePublication).toBeNull();
  });

  it('strictly parses canonical active V2 publication metadata and its layout', () => {
    const activePublication = {
      id: 'layout-publication-1',
      version: 2,
      contentHash: 'a'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: layout(),
    };

    expect(
      parsePalletLabelEditorBootstrap({ ...bootstrapFixture, activePublication }).activePublication,
    ).toEqual(activePublication);
  });

  it('rejects a bootstrap whose editorLayout differs from an active V2 publication', () => {
    const activeLayout = layout();
    activeLayout.elements = activeLayout.elements.map((element) =>
      element.id === 'order' ? { ...element, xDots: 40 } : element,
    );

    expect(() =>
      parsePalletLabelEditorBootstrap({
        ...bootstrapFixture,
        activePublication: {
          id: 'publication-1',
          version: 1,
          contentHash: 'a'.repeat(64),
          activatedAt: '2026-08-11T21:30:00.000Z',
          layout: activeLayout,
        },
      }),
    ).toThrow();
  });

  it('accepts an immutable active V1 publication while exposing only the V2 editor layout', () => {
    const activePublication = {
      id: 'legacy-layout-publication-1',
      version: 1,
      contentHash: 'b'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: legacyLayoutFixture,
    };

    expect(
      parsePalletLabelEditorBootstrap({ ...bootstrapFixture, activePublication }),
    ).toMatchObject({
      schemaVersion: 2,
      editorLayout: bootstrapFixture.editorLayout,
      activePublication,
    });
  });

  it('allows optional V2 blocks to be absent, but requires one canonical QR', () => {
    const withoutCustomer = {
      ...layout(),
      elements: layout().elements.filter((element) => element.id !== 'customer'),
    };
    const withoutQr = {
      ...layout(),
      elements: layout().elements.filter((element) => element.id !== 'qr'),
    };
    const duplicate = { ...layout(), elements: [...layout().elements, layout().elements[0]] };

    expect(parsePalletLabelEditorBootstrap({
      ...bootstrapFixture,
      editorLayout: withoutCustomer,
    }).editorLayout).toEqual(withoutCustomer);
    expect(() =>
      parsePalletLabelEditorBootstrap({ ...bootstrapFixture, editorLayout: withoutQr }),
    ).toThrow(/QR/i);
    expect(() =>
      parsePalletLabelEditorBootstrap({ ...bootstrapFixture, editorLayout: duplicate }),
    ).toThrow(/один|повтор/i);
  });

  it.each([
    ['id', { id: '' }],
    ['version', { version: 0 }],
    ['hash', { contentHash: 'A'.repeat(64) }],
    ['date', { activatedAt: '2026-08-11T21:30:00Z' }],
    ['layout', { layout: { ...layout(), profile: 'pallet-100x100-extended-v6' } }],
  ])('rejects malformed active publication %s', (_label, patch) => {
    const publication = {
      id: 'layout-publication-1',
      version: 2,
      contentHash: 'a'.repeat(64),
      activatedAt: '2026-08-11T21:30:00.000Z',
      layout: layout(),
      ...patch,
    };

    expect(() => parsePalletLabelLayoutPublication(publication, bootstrapFixture.canvas)).toThrow();
  });

  it.each([
    ['bootstrap', { ...bootstrapFixture, extra: true }],
    ['canvas', { ...bootstrapFixture, canvas: { ...bootstrapFixture.canvas, extra: true } }],
    [
      'source',
      {
        ...bootstrapFixture,
        sources: bootstrapFixture.sources.map((source) => ({ ...source, extra: true })),
      },
    ],
  ])('rejects unknown fields in the %s', (_label, value) => {
    expect(() => parsePalletLabelEditorBootstrap(value)).toThrow(/неизвестное поле/i);
  });

  it('rejects unknown fields in an active publication envelope', () => {
    expect(() =>
      parsePalletLabelEditorBootstrap({
        ...bootstrapFixture,
        activePublication: {
          id: 'layout-publication-1',
          version: 1,
          contentHash: 'a'.repeat(64),
          activatedAt: '2026-08-11T21:30:00.000Z',
          layout: layout(),
          rawPayload: 'forbidden',
        },
      }),
    ).toThrow(/неизвестное поле/i);
  });
});
