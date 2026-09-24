import { createHash } from 'node:crypto';
import type { PalletLabelSnapshot } from '@plenka/contracts';
import type { Actor } from '../auth/actor';
import { ConfigurablePalletLabelRenderer } from './configurable-pallet-label.renderer';
import { PalletLabelLayoutPublicationService } from './pallet-label-layout-publication.service';
import { PUBLISHED_PALLET_LABEL_LAYOUT } from '../../modules/admin/pallet-label-layout-editor.validator';
import { rightShiftedCompactPalletLabelLayout } from '../../../test/fixtures/pallet-label-layout.fixture';
import { LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT } from './pallet-label-layout.validator';

const ACTOR: Actor = {
  userId: 'admin-1',
  role: 'admin',
  capabilities: ['pallet_label_layout:manage'],
};

const OPERATION_KEY = '123e4567-e89b-42d3-a456-426614174000';
const ACTIVATED_AT = new Date('2026-08-11T18:30:00.000Z');
const CONTROL_SOURCE_ID = 'pllsrc_ctl_1e807e96d0c94b34a5df98cc0ecf4206';
const LABEL: PalletLabelSnapshot = {
  templateVersion: 'pallet-100x100-extended-v6',
  palletId: 'PAL-A-2-06',
  materialMark: 'PE-LD',
  productNames: ['Пленка полиэтиленовая рукав 29мкм'],
  article: null,
  rollCount: 1,
  rollCodes: ['A-2-roll-1'],
  packagingMaterial: null,
  packagingCount: null,
  netKg: 7.95,
  grossKg: 8.6,
  productionDate: '08.2026',
  shelfLifeMonths: 12,
  deliveryDate: null,
  storageConditions: 'Хранить в сухом помещении.',
  orderNumbers: ['A-2'],
  customerAliases: ['СТН-М АО'],
  createdAt: '2026-08-09T12:00:00.000Z',
};

function setup() {
  const version = {
    id: 'publication-1',
    profile: 'pallet-100x100-configurable-v7',
    version: 1,
    contentHash: createHash('sha256')
      .update(JSON.stringify(PUBLISHED_PALLET_LABEL_LAYOUT), 'utf8')
      .digest('hex'),
    definition: PUBLISHED_PALLET_LABEL_LAYOUT,
    activatedAt: ACTIVATED_AT,
  };
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    palletLabelLayoutVersion: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(version),
    },
    palletLabelLayoutPublishCommand: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'command-1' }),
    },
    palletListDocument: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'source-1',
        palletId: LABEL.palletId,
        voidedAt: null,
        payload: { templateVersion: LABEL.templateVersion, label: LABEL },
      }),
    },
  };
  const prisma = {
    palletLabelLayoutVersion: tx.palletLabelLayoutVersion,
    palletLabelLayoutPublishCommand: tx.palletLabelLayoutPublishCommand,
    $transaction: jest.fn((operation: (client: typeof tx) => unknown) => operation(tx)),
  };
  const audit = { record: jest.fn().mockResolvedValue({ id: 'event-1' }) };
  const renderer = new ConfigurablePalletLabelRenderer();
  const service = new PalletLabelLayoutPublicationService(
    prisma as never,
    audit as never,
    renderer,
  );
  return { service, prisma, tx, audit, version, renderer };
}

describe('PalletLabelLayoutPublicationService', () => {
  const command = {
    operationKey: OPERATION_KEY,
    expectedActivePublicationId: null,
    sourceDocumentId: 'source-1',
    reason: 'Утверждён макет для будущих палет',
    layout: PUBLISHED_PALLET_LABEL_LAYOUT,
  } as const;

  it('keeps an active schema V1 layout available for future documents', async () => {
    const { service, tx } = setup();
    const layout = rightShiftedCompactPalletLabelLayout();
    tx.palletLabelLayoutVersion.findFirst.mockResolvedValue({
      id: 'historical-active',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      definition: layout,
      activatedAt: ACTIVATED_AT,
    });

    await expect(service.active()).resolves.toMatchObject({ id: 'historical-active', layout });
    await expect(service.activeForNewDocument()).resolves.toMatchObject({
      id: 'historical-active',
      layout,
    });
  });

  it('rejects an active layout that cannot render production content', async () => {
    const { service, tx } = setup();
    const layout = structuredClone(LEGACY_PUBLISHED_PALLET_LABEL_LAYOUT);
    layout.elements.find((element) => element.id === 'header')!.widthDots = 1;
    tx.palletLabelLayoutVersion.findFirst.mockResolvedValue({
      id: 'unrenderable-active',
      version: 1,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      definition: layout,
      activatedAt: ACTIVATED_AT,
    });

    await expect(service.active()).resolves.toMatchObject({ id: 'unrenderable-active', layout });
    await expect(service.activeForNewDocument()).rejects.toMatchObject({
      status: 409,
      response: { code: 'PALLET_LABEL_LAYOUT_ACTIVE_CAPACITY_REDUCED' },
    });
  });

  it('publishes from the synthetic control source without loading a purged document', async () => {
    const { service, tx, audit } = setup();
    const controlCommand = { ...command, sourceDocumentId: CONTROL_SOURCE_ID };

    await expect(service.publish(ACTOR, controlCommand)).resolves.toMatchObject({
      replayed: false,
      publication: { version: 1 },
    });

    expect(tx.palletListDocument.findUnique).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceDocumentId: CONTROL_SOURCE_ID }),
      }),
    );
    expect(tx.palletLabelLayoutPublishCommand.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sourceDocumentId: CONTROL_SOURCE_ID }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ sourceDocumentId: CONTROL_SOURCE_ID }),
      }),
      tx,
    );
  });

  it('rejects a layout that cannot render production content before publication writes', async () => {
    const { service, tx, audit } = setup();
    const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    layout.elements.find((element) => element.id === 'order')!.widthDots = 1;

    await expect(
      service.publish(ACTOR, {
        ...command,
        operationKey: '123e4567-e89b-42d3-a456-426614174001',
        layout,
      }),
    ).rejects.toMatchObject({ response: { code: 'PALLET_LABEL_LAYOUT_CONTENT_OVERFLOW' } });

    expect(tx.palletLabelLayoutVersion.create).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutPublishCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('publishes safe moves, enlargements and lower minimum fonts', async () => {
    const { service, tx } = setup();
    const layout = structuredClone(PUBLISHED_PALLET_LABEL_LAYOUT);
    layout.elements.find((element) => element.id === 'order')!.xDots = 40;
    layout.elements.find((element) => element.id === 'customer')!.widthDots = 400;
    layout.elements.find((element) => element.id === 'storage')!.heightDots = 172;
    layout.elements.find((element) => element.id === 'formedAt')!.minFontSize = 10;

    await expect(
      service.publish(ACTOR, {
        ...command,
        operationKey: '123e4567-e89b-42d3-a456-426614174004',
        layout,
      }),
    ).resolves.toMatchObject({ replayed: false });
    expect(tx.palletLabelLayoutVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ definition: layout }) }),
    );
  });

  it('rejects a fresh schema V1 publication before any append-only write', async () => {
    const { service, prisma, tx, audit } = setup();
    const layout = rightShiftedCompactPalletLabelLayout();

    await expect(
      service.publish(ACTOR, {
        ...command,
        operationKey: '123e4567-e89b-42d3-a456-426614174008',
        layout,
      } as never),
    ).rejects.toMatchObject({ response: { code: 'PALLET_LABEL_LAYOUT_INVALID' } });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutVersion.create).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutPublishCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('publishes one serialized immutable version, command journal row and safe audit fact', async () => {
    const { service, prisma, tx, audit } = setup();

    await expect(service.publish(ACTOR, command)).resolves.toMatchObject({
      replayed: false,
      publication: {
        id: 'publication-1',
        version: 1,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        activatedAt: ACTIVATED_AT.toISOString(),
        layout: PUBLISHED_PALLET_LABEL_LAYOUT,
      },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.palletLabelLayoutVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          profile: 'pallet-100x100-configurable-v7',
          version: 1,
          sourceDocumentId: 'source-1',
          publishedById: 'admin-1',
          reason: 'Утверждён макет для будущих палет',
        }),
      }),
    );
    expect(tx.palletLabelLayoutPublishCommand.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'audit:pallet_label_layout_published',
        detail: expect.not.objectContaining({
          layout: expect.anything(),
          qrToken: expect.anything(),
        }),
      }),
      tx,
    );
  });

  it('replays the immutable result for the same operation key and request fingerprint', async () => {
    const { service, tx, audit, version } = setup();
    const first = await service.publish(ACTOR, command);
    const journalWrite = tx.palletLabelLayoutPublishCommand.create.mock.calls[0][0];
    tx.palletLabelLayoutPublishCommand.findUnique.mockResolvedValue({
      requestFingerprint: journalWrite.data.requestFingerprint,
      resultSnapshot: { publication: first.publication },
      profile: 'pallet-100x100-configurable-v7',
      resultPublicationId: version.id,
      resultPublication: version,
    });

    await expect(service.publish(ACTOR, command)).resolves.toEqual({
      publication: first.publication,
      replayed: true,
    });
    expect(tx.palletLabelLayoutVersion.create).toHaveBeenCalledTimes(1);
    expect(tx.palletLabelLayoutPublishCommand.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('replays a journaled safe pre-policy command without applying new admission rules', async () => {
    const { service, prisma, tx, audit, version } = setup();
    const layout = rightShiftedCompactPalletLabelLayout();
    const historicalCommand = {
      ...command,
      operationKey: '123e4567-e89b-42d3-a456-426614174006',
      layout,
    };
    const historicalVersion = {
      ...version,
      contentHash: createHash('sha256').update(JSON.stringify(layout), 'utf8').digest('hex'),
      definition: layout,
    };
    const publication = {
      id: historicalVersion.id,
      version: historicalVersion.version,
      contentHash: historicalVersion.contentHash,
      activatedAt: historicalVersion.activatedAt.toISOString(),
      layout,
    };
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          expectedActivePublicationId: historicalCommand.expectedActivePublicationId,
          layout,
          operationKey: historicalCommand.operationKey,
          reason: historicalCommand.reason,
          sourceDocumentId: historicalCommand.sourceDocumentId,
        }),
        'utf8',
      )
      .digest('hex');
    tx.palletLabelLayoutPublishCommand.findUnique.mockResolvedValue({
      requestFingerprint,
      resultSnapshot: { publication },
      profile: 'pallet-100x100-configurable-v7',
      resultPublicationId: historicalVersion.id,
      resultPublication: historicalVersion,
    });

    await expect(service.publish(ACTOR, historicalCommand as never)).resolves.toEqual({
      publication,
      replayed: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.palletLabelLayoutVersion.create).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutPublishCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects replay when the journal snapshot diverges from its FK-linked immutable version', async () => {
    const { service, tx, version } = setup();
    const first = await service.publish(ACTOR, command);
    const journalWrite = tx.palletLabelLayoutPublishCommand.create.mock.calls[0][0];
    tx.palletLabelLayoutPublishCommand.findUnique.mockResolvedValue({
      requestFingerprint: journalWrite.data.requestFingerprint,
      resultSnapshot: { publication: first.publication },
      profile: 'pallet-100x100-configurable-v7',
      resultPublicationId: version.id,
      resultPublication: { ...version, version: version.version + 1 },
    });

    await expect(service.publish(ACTOR, command)).rejects.toMatchObject({
      response: { code: 'PALLET_LABEL_LAYOUT_COMMAND_CORRUPTED' },
    });
  });

  it('rejects replay when journal profile or FK result identity metadata diverges', async () => {
    const { service, tx, version } = setup();
    const first = await service.publish(ACTOR, command);
    const journalWrite = tx.palletLabelLayoutPublishCommand.create.mock.calls[0][0];
    const replay = {
      requestFingerprint: journalWrite.data.requestFingerprint,
      resultSnapshot: { publication: first.publication },
      profile: 'pallet-100x100-configurable-v7',
      resultPublicationId: version.id,
      resultPublication: version,
    };
    const corruptedRows = [
      { ...replay, profile: 'pallet-100x100-extended-v6' },
      { ...replay, resultPublicationId: 'publication-other' },
      {
        ...replay,
        resultPublication: { ...version, profile: 'pallet-100x100-extended-v6' },
      },
      { ...replay, resultPublication: null },
    ];

    for (const corrupted of corruptedRows) {
      tx.palletLabelLayoutPublishCommand.findUnique.mockResolvedValue(corrupted);
      await expect(service.publish(ACTOR, command)).rejects.toMatchObject({
        response: { code: 'PALLET_LABEL_LAYOUT_COMMAND_CORRUPTED' },
      });
    }
  });

  it('rejects a stale active-publication CAS before any append-only write', async () => {
    const { service, tx, audit } = setup();
    tx.palletLabelLayoutVersion.findFirst.mockResolvedValue({
      id: 'publication-current',
      version: 3,
      profile: 'pallet-100x100-configurable-v7',
      contentHash: createHash('sha256')
        .update(JSON.stringify(PUBLISHED_PALLET_LABEL_LAYOUT), 'utf8')
        .digest('hex'),
      definition: PUBLISHED_PALLET_LABEL_LAYOUT,
      activatedAt: ACTIVATED_AT,
    });

    await expect(
      service.publish(ACTOR, {
        operationKey: OPERATION_KEY,
        expectedActivePublicationId: null,
        sourceDocumentId: 'source-1',
        reason: 'Новая версия макета',
        layout: PUBLISHED_PALLET_LABEL_LAYOUT,
      }),
    ).rejects.toMatchObject({
      response: { code: 'PALLET_LABEL_LAYOUT_ACTIVE_CONFLICT' },
    });

    expect(tx.palletLabelLayoutVersion.create).not.toHaveBeenCalled();
    expect(tx.palletLabelLayoutPublishCommand.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
