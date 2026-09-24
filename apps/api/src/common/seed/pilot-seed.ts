import { createHash } from 'node:crypto';
import { Role, type Prisma } from '@prisma/client';
import { seedSystemAccessTemplates } from './admin-access-seed';
import { reconcileSeedAccounts } from './seed-account-reconciliation';
import {
  PILOT_ACCOUNT_MANIFEST,
  PILOT_AGENT_TOKEN_KEYS,
  RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
  type PilotSeedProfile,
} from './seed-profile';

interface PilotPost {
  code: string;
  name: string;
  tokenKey: (typeof PILOT_AGENT_TOKEN_KEYS)[number];
}

interface PilotDevice {
  code: string;
  connectionKind: string;
  id: string;
  kind: string;
  label: string;
  legacyId: string;
}

export type PilotTopologyClient = Pick<Prisma.TransactionClient, 'post' | 'deviceRuntime'>;

const PILOT_POSTS: readonly PilotPost[] = PILOT_AGENT_TOKEN_KEYS.map((tokenKey, index) => ({
  code: `POST-${index + 1}`,
  name: `Станок ${index + 1}`,
  tokenKey,
}));

export class PilotSeedConflictError extends Error {
  constructor(message: string) {
    super(`Pilot seed conflict: ${message}`);
    this.name = 'PilotSeedConflictError';
  }
}

function pilotDevices(postIndex: number): PilotDevice[] {
  const number = postIndex + 1;
  return [
    {
      id: `scale-post-${number}`,
      legacyId: `dev-scale-${number}`,
      code: `SCALE-${number}`,
      label: `Весы станка ${number}`,
      kind: 'scale',
      connectionKind: 'usb-rs232',
    },
    {
      id: `scanner-post-${number}`,
      legacyId: `dev-scanner-${number}`,
      code: `SCANNER-${number}`,
      label: `Сканер станка ${number}`,
      kind: 'scanner',
      connectionKind: 'usb-hid',
    },
    {
      id: `printer-post-${number}`,
      legacyId: `dev-printer-${number}`,
      code: `PRINTER-${number}`,
      label: `Принтер станка ${number}`,
      kind: 'printer',
      connectionKind: 'usb-or-tcp',
    },
  ];
}

async function reconcileDevice(
  prisma: PilotTopologyClient,
  device: PilotDevice,
  postId: string,
): Promise<void> {
  const [byId, byCode, byLegacyId] = await Promise.all([
    prisma.deviceRuntime.findUnique({ where: { id: device.id } }),
    prisma.deviceRuntime.findUnique({ where: { code: device.code } }),
    prisma.deviceRuntime.findUnique({ where: { id: device.legacyId } }),
  ]);
  const matchedIds = new Set(
    [byId?.id, byCode?.id, byLegacyId?.id].filter((id): id is string => id !== undefined),
  );
  if (matchedIds.size > 1) {
    throw new PilotSeedConflictError(`device identity mismatch for ${device.code}`);
  }
  const existing = byId ?? byCode ?? byLegacyId;
  if (!existing) {
    await prisma.deviceRuntime.create({
      data: {
        id: device.id,
        code: device.code,
        label: device.label,
        kind: device.kind,
        connectionKind: device.connectionKind,
        isEnabled: true,
        ownerRole: Role.admin,
        postId,
        status: 'offline',
      },
    });
    return;
  }
  const hasKnownLegacyId = existing.id === device.legacyId;
  if (
    (existing.id !== device.id && !hasKnownLegacyId) ||
    (existing.code !== null && existing.code !== device.code) ||
    existing.kind !== device.kind
  ) {
    throw new PilotSeedConflictError(`device metadata mismatch for ${device.code}`);
  }
  if (existing.postId !== null && existing.postId !== postId) {
    throw new PilotSeedConflictError(`device ${device.code} is bound to another post`);
  }

  const update: Prisma.DeviceRuntimeUpdateInput = {};
  if (hasKnownLegacyId) update.id = device.id;
  if (existing.code === null) update.code = device.code;
  if (existing.postId === null) update.post = { connect: { id: postId } };
  if (Object.keys(update).length > 0) {
    await prisma.deviceRuntime.update({ where: { id: existing.id }, data: update });
  }
}

export async function reconcilePilotTopology(
  prisma: PilotTopologyClient,
  config: PilotSeedProfile,
): Promise<void> {
  for (const [index, postManifest] of PILOT_POSTS.entries()) {
    const tokenHash = createHash('sha256')
      .update(config.agentTokens[postManifest.tokenKey])
      .digest('hex');
    const existing = await prisma.post.findUnique({ where: { code: postManifest.code } });
    const post = existing
      ? existing.agentTokenHash === null
        ? await prisma.post.update({
            where: { id: existing.id },
            data: { agentTokenHash: tokenHash },
          })
        : existing
      : await prisma.post.create({
          data: {
            code: postManifest.code,
            name: postManifest.name,
            status: 'active',
            commissioningState: 'uncommissioned',
            commissionedAt: null,
            agentStatus: 'unknown',
            agentCompatibility: 'unknown',
            lastSeenAt: null,
            agentTokenHash: tokenHash,
          },
        });

    for (const device of pilotDevices(index)) {
      await reconcileDevice(prisma, device, post.id);
    }
  }
}

export async function seedPilot(
  prisma: Prisma.TransactionClient,
  config: PilotSeedProfile,
): Promise<void> {
  await reconcileSeedAccounts(prisma, {
    accounts: PILOT_ACCOUNT_MANIFEST,
    retiredExternalIds: RETIRED_PILOT_ACCOUNT_EXTERNAL_IDS,
    passwordFor: (passwordKey) => config.passwords[passwordKey],
    conflict: (message) => new PilotSeedConflictError(message),
  });
  await reconcilePilotTopology(prisma, config);
  await seedSystemAccessTemplates(prisma, { createOnly: true });
}
