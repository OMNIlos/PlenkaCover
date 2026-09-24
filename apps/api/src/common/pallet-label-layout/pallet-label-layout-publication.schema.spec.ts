import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PALLET_LABEL_CONFIGURABLE_PROFILE,
  PALLET_LABEL_SNAPSHOT_PROFILES,
} from '@plenka/contracts';
import { isBrowserOnlyPalletLabelProfile } from '../../modules/warehouse/pallet-label-snapshot';

const apiRoot = join(__dirname, '../../..');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  join(apiRoot, 'prisma/migrations/20260811213000_pallet_label_layout_publication/migration.sql'),
  'utf8',
);

describe('pallet-label layout publication schema', () => {
  it('registers configurable-v7 as an immutable browser-only snapshot profile', () => {
    expect(PALLET_LABEL_CONFIGURABLE_PROFILE).toBe('pallet-100x100-configurable-v7');
    expect(PALLET_LABEL_SNAPSHOT_PROFILES).toContain(PALLET_LABEL_CONFIGURABLE_PROFILE);
    expect(isBrowserOnlyPalletLabelProfile(PALLET_LABEL_CONFIGURABLE_PROFILE)).toBe(true);
  });

  it('persists append-only versions, idempotent commands and restrictive document provenance', () => {
    expect(schema).toMatch(/model PalletLabelLayoutVersion \{/);
    expect(schema).toMatch(/@@unique\(\[profile, version\]/);
    expect(schema).toMatch(/model PalletLabelLayoutPublishCommand \{/);
    expect(schema).toMatch(/operationKey\s+String\s+@unique\s+@db\.Uuid/);
    expect(schema).toMatch(/layoutPublicationId\s+String\?/);
    expect(schema).toMatch(
      /layoutPublication\s+PalletLabelLayoutVersion\?\s+@relation\([^\n]*onDelete: Restrict[^\n]*onUpdate: Restrict/,
    );

    expect(migration).toContain('CREATE TABLE "pallet_label_layout_versions"');
    expect(migration).toContain('CREATE TABLE "pallet_label_layout_publish_commands"');
    expect(migration).toContain('pallet_label_layout_versions_immutable');
    expect(migration).toContain('pallet_label_layout_publish_commands_immutable');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT');
    expect(migration).toContain('BEFORE UPDATE ON "pallet_list_documents"');
    expect(migration).not.toContain('BEFORE UPDATE OR DELETE ON "pallet_list_documents"');
  });

  it('keeps source ids as indexed scalar provenance so source documents can be purged', () => {
    const versionModel = schema.match(
      /model PalletLabelLayoutVersion \{[\s\S]*?@@map\("pallet_label_layout_versions"\)\n\}/u,
    )?.[0];
    const commandModel = schema.match(
      /model PalletLabelLayoutPublishCommand \{[\s\S]*?@@map\("pallet_label_layout_publish_commands"\)\n\}/u,
    )?.[0];

    expect(versionModel).toMatch(/sourceDocumentId\s+String\s+@db\.VarChar\(200\)/u);
    expect(commandModel).toMatch(/sourceDocumentId\s+String\s+@db\.VarChar\(200\)/u);
    expect(versionModel).toContain('@@index([sourceDocumentId]');
    expect(commandModel).toContain('@@index([sourceDocumentId]');
    expect(versionModel).not.toContain('sourceDocument  PalletListDocument');
    expect(commandModel).not.toContain('sourceDocument    PalletListDocument');
    expect(migration).toContain('pallet_label_layout_versions_source_idx');
    expect(migration).toContain('pallet_label_layout_publish_commands_source_idx');
    expect(migration.match(/"sourceDocumentId" VARCHAR\(200\) NOT NULL/gu)).toHaveLength(2);
    expect(migration).not.toContain('pallet_label_layout_versions_sourceDocumentId_fkey');
    expect(migration).not.toContain('pallet_label_layout_publish_commands_sourceDocumentId_fkey');
    expect(migration).not.toMatch(
      /FOREIGN KEY \("sourceDocumentId"\)\s+REFERENCES "pallet_list_documents"/u,
    );
  });
});
