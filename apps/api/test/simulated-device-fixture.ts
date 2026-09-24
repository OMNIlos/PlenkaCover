import { Prisma } from '@prisma/client';
import { GATEWAY_CAPABILITIES, GATEWAY_PROTOCOL_VERSION } from '@plenka/contracts';
import type { PrismaService } from '../src/common/prisma/prisma.service';

type SimulatedTopologyClient = Pick<PrismaService, '$transaction'>;

const REQUIRED_DEVICE_KINDS = ['scale', 'printer', 'scanner'] as const;
const E2E_RELEASE_COMMIT = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/**
 * Test-only commissioning fixture for simulator-backed flows. The requested IDs identify posts;
 * every enabled scale, printer and scanner on those posts is made fresh and ready together.
 *
 * A ready database projection is not evidence of physical hardware readiness, so callers must
 * keep these suites labelled as simulated/e2e. Production seed must remain fail-closed.
 */
export async function enableSimulatedDevices(
  prisma: SimulatedTopologyClient,
  ids: readonly string[],
) {
  const requestedIds = [...new Set(ids)];
  if (requestedIds.length === 0 || requestedIds.length !== ids.length) {
    throw new Error('Simulated device fixture requires unique device IDs.');
  }

  const snapshot = await prisma.$transaction(async (tx) => {
    const requestedDevices = await tx.deviceRuntime.findMany({
      where: { id: { in: requestedIds } },
      select: { id: true, postId: true },
      orderBy: { id: 'asc' },
    });
    if (
      requestedDevices.length !== requestedIds.length ||
      requestedDevices.some((device) => !device.postId)
    ) {
      throw new Error('Simulated device fixture is incomplete or unbound.');
    }

    const postIds = [...new Set(requestedDevices.map((device) => device.postId as string))];
    const [posts, devices] = await Promise.all([
      tx.post.findMany({
        where: { id: { in: postIds } },
        select: {
          id: true,
          commissioningState: true,
          commissionedAt: true,
          agentStatus: true,
          lastSeenAt: true,
          agentProtocolVersion: true,
          agentPackageVersion: true,
          agentReleaseCommit: true,
          agentCapabilities: true,
          agentCompatibility: true,
        },
        orderBy: { id: 'asc' },
      }),
      tx.deviceRuntime.findMany({
        where: { postId: { in: postIds }, isEnabled: true },
        select: {
          id: true,
          postId: true,
          kind: true,
          status: true,
          lastSeenAt: true,
          lastProbeAt: true,
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    if (posts.length !== postIds.length) {
      throw new Error('Simulated post fixture is incomplete.');
    }
    for (const postId of postIds) {
      for (const kind of REQUIRED_DEVICE_KINDS) {
        if (
          devices.filter((device) => device.postId === postId && device.kind === kind).length !== 1
        ) {
          throw new Error(`Simulated post fixture requires exactly one enabled ${kind}.`);
        }
      }
    }

    const now = new Date();
    await tx.post.updateMany({
      where: { id: { in: postIds } },
      data: {
        commissioningState: 'commissioned',
        commissionedAt: now,
        agentStatus: 'online',
        lastSeenAt: now,
        agentProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        agentPackageVersion: 'e2e-simulated',
        agentReleaseCommit: E2E_RELEASE_COMMIT,
        agentCapabilities: [...GATEWAY_CAPABILITIES],
        agentCompatibility: 'compatible',
      },
    });
    await tx.deviceRuntime.updateMany({
      where: { id: { in: devices.map((device) => device.id) } },
      data: { status: 'ready', lastSeenAt: now, lastProbeAt: now },
    });

    return { posts, devices };
  });

  return async () => {
    await prisma.$transaction(async (tx) => {
      for (const device of snapshot.devices) {
        await tx.deviceRuntime.update({
          where: { id: device.id },
          data: {
            status: device.status,
            lastSeenAt: device.lastSeenAt,
            lastProbeAt: device.lastProbeAt,
          },
        });
      }
      for (const post of snapshot.posts) {
        await tx.post.update({
          where: { id: post.id },
          data: {
            commissioningState: post.commissioningState,
            commissionedAt: post.commissionedAt,
            agentStatus: post.agentStatus,
            lastSeenAt: post.lastSeenAt,
            agentProtocolVersion: post.agentProtocolVersion,
            agentPackageVersion: post.agentPackageVersion,
            agentReleaseCommit: post.agentReleaseCommit,
            agentCapabilities:
              post.agentCapabilities === null
                ? Prisma.DbNull
                : (post.agentCapabilities as Prisma.InputJsonValue),
            agentCompatibility: post.agentCompatibility,
          },
        });
      }
    });
  };
}
