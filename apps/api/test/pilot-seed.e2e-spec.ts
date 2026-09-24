import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../src/common/auth/password';
import { MATERIAL_DEFINITIONS } from '../src/common/seed/material-catalog-seed';
import { PILOT_ACCOUNT_MANIFEST, PILOT_AGENT_TOKEN_KEYS } from '../src/common/seed/seed-profile';
import {
  assertCommandSucceeded,
  createE2eSchemaName,
  assertSchemaDestructionTarget,
} from './e2e-database';

const API_ROOT = resolve(__dirname, '..');
const PRISMA_SCHEMA = resolve(API_ROOT, 'prisma/schema.prisma');
const SEED_SCRIPT = resolve(API_ROOT, 'prisma/seed.ts');
const PILOT_MATERIAL_DEFINITION_COUNT = MATERIAL_DEFINITIONS.length + 2;

function databaseUrlForSchema(schema: string): string {
  if (!process.env.DATABASE_URL) throw new Error('E2E DATABASE_URL is not configured');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('schema', schema);
  return url.toString();
}

function runNode(label: string, entrypoint: string, args: string[], env = process.env): void {
  assertCommandSucceeded(
    label,
    spawnSync(process.execPath, [entrypoint, ...args], {
      cwd: API_ROOT,
      env,
      stdio: 'ignore',
    }),
  );
}

function runNodeFailure(
  label: string,
  entrypoint: string,
  args: string[],
  env = process.env,
): string {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: API_ROOT,
    encoding: 'utf8',
    env,
  });
  expect(result.status).not.toBe(0);
  if (result.error) throw new Error(`${label} failed to start`);
  return result.stderr;
}

function pilotEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'pilot',
    AUTH_DEV_XROLE: 'off',
    DATABASE_URL: databaseUrl,
    SEED_PROFILE: 'pilot',
  };
  delete env.SEED_PASSWORD;
  for (const [index, account] of PILOT_ACCOUNT_MANIFEST.entries()) {
    env[account.passwordKey] = `${randomBytes(18).toString('base64url')}-${index}`;
  }
  for (const key of PILOT_AGENT_TOKEN_KEYS) {
    env[key] = `ptk_${randomBytes(32).toString('base64url')}`;
  }
  return env;
}

describe('pilot seed', () => {
  let schema: string;
  let databaseUrl: string;
  let prisma: PrismaClient;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    schema = createE2eSchemaName();
    databaseUrl = databaseUrlForSchema(schema);
    env = pilotEnvironment(databaseUrl);
    runNode(
      'Pilot seed migration',
      require.resolve('prisma/build/index.js'),
      ['migrate', 'deploy', '--schema', PRISMA_SCHEMA],
      { ...process.env, DATABASE_URL: databaseUrl },
    );
    prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  });

  afterEach(async () => {
    await prisma.$disconnect();
    assertSchemaDestructionTarget(schema, databaseUrl);
    const admin = new PrismaClient();
    try {
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.$disconnect();
    }
  });

  function seed(label = 'Pilot seed'): void {
    runNode(label, require.resolve('ts-node/dist/bin.js'), [SEED_SCRIPT], env);
  }

  function seedFailure(label: string): string {
    return runNodeFailure(label, require.resolve('ts-node/dist/bin.js'), [SEED_SCRIPT], env);
  }

  async function stageLegacySimulatorFixture(progressLine = false) {
    const retired = await prisma.user.create({
      data: {
        externalId: 'seed-operator-4',
        login: 'оператор4',
        passwordHash: hashPassword('legacy-operator-password-2026'),
        displayName: 'Анна Соколова',
        role: Role.operator,
        isActive: true,
      },
    });
    seed('Initial current pilot seed');
    const current = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-operator-3' },
    });
    const assignment = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
      where: { id: 'pilot-test-assignment-post-5' },
    });
    const dispatch = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { rollCode: 'PILOT-SIM-ROLL-001' },
    });
    const line = await prisma.operatorRollLine.findUniqueOrThrow({
      where: { rollDispatchItemId: dispatch.id },
    });
    const physicalAssignment = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
      where: { id: 'pilot-test-assignment-post-1' },
    });
    const physicalDispatch = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { rollCode: 'PILOT-PHYSICAL-ROLL-001' },
    });
    const shift = await prisma.shift.findUniqueOrThrow({
      where: { id: 'pilot-test-shift-001' },
    });
    const bag = await prisma.bigBagUnit.findUniqueOrThrow({
      where: { code: 'PILOT-BAG-SIM-001' },
    });

    await prisma.operatorShiftMachineAssignment.update({
      where: { id: assignment.id },
      data: { operatorId: retired.id },
    });
    await prisma.rollDispatchItem.update({
      where: { id: dispatch.id },
      data: { assignedOperatorId: retired.id },
    });
    if (progressLine) {
      await prisma.operatorRollLine.update({
        where: { id: line.id },
        data: { step: 'spool_weight' },
      });
    }
    await prisma.user.update({
      where: { id: retired.id },
      data: { isActive: true },
    });
    const session = await prisma.session.create({
      data: {
        userId: retired.id,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    return {
      assignment,
      bag,
      current,
      dispatch,
      line,
      physicalAssignment,
      physicalDispatch,
      retired,
      session,
      shift,
    };
  }

  it('creates the bounded pilot topology and fictional first-run fixtures', async () => {
    seed();

    await expect(prisma.user.count()).resolves.toBe(9);
    await expect(prisma.user.count({ where: { isActive: true } })).resolves.toBe(9);
    await expect(
      prisma.user.findMany({
        where: { isActive: true, role: Role.operator },
        select: { externalId: true, login: true, displayName: true },
        orderBy: { externalId: 'asc' },
      }),
    ).resolves.toEqual([
      {
        externalId: 'seed-operator',
        login: 'ахметов булат',
        displayName: 'Ахметов Булат',
      },
      {
        externalId: 'seed-operator-2',
        login: 'хабибулин руслан',
        displayName: 'Хабибулин Руслан',
      },
      {
        externalId: 'seed-operator-3',
        login: 'гайнулин ильназ',
        displayName: 'Гайнулин Ильназ',
      },
    ]);
    const catalogPosts = await prisma.post.findMany({
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        status: true,
        commissioningState: true,
        commissionedAt: true,
        agentStatus: true,
        lastSeenAt: true,
        agentProtocolVersion: true,
        agentPackageVersion: true,
        agentReleaseCommit: true,
        agentCapabilities: true,
        agentCompatibility: true,
        agentTokenHash: true,
        devices: {
          orderBy: { kind: 'asc' },
          select: {
            kind: true,
            isEnabled: true,
            status: true,
            lastSeenAt: true,
            lastProbeAt: true,
            lastTestAt: true,
          },
        },
      },
    });
    expect(catalogPosts.map(({ code, name }) => ({ code, name }))).toEqual([
      { code: 'POST-1', name: 'Китайка старая' },
      { code: 'POST-2', name: 'ABC новая' },
      { code: 'POST-3', name: 'ABC старая' },
      { code: 'POST-4', name: 'Бегемот' },
      { code: 'POST-5', name: 'Матиль' },
      { code: 'POST-6', name: 'Пнд новая' },
      { code: 'POST-7', name: 'Урп' },
    ]);
    const safeUncommissionedPost = {
      status: 'active',
      commissioningState: 'uncommissioned',
      commissionedAt: null,
      agentStatus: 'unknown',
      lastSeenAt: null,
      agentProtocolVersion: null,
      agentPackageVersion: null,
      agentReleaseCommit: null,
      agentCapabilities: null,
      agentCompatibility: 'unknown',
    };
    for (const post of catalogPosts.slice(0, 5)) {
      expect(post).toMatchObject({
        ...safeUncommissionedPost,
        agentTokenHash: expect.any(String),
      });
      expect(post.devices).toHaveLength(3);
      expect(post.devices.map((device) => device.kind).sort()).toEqual([
        'printer',
        'scale',
        'scanner',
      ]);
      for (const device of post.devices) {
        expect(device).toMatchObject({
          isEnabled: true,
          status: 'offline',
          lastSeenAt: null,
          lastProbeAt: null,
          lastTestAt: null,
        });
      }
    }
    for (const post of catalogPosts.slice(5)) {
      expect(post).toMatchObject({
        ...safeUncommissionedPost,
        agentTokenHash: null,
        devices: [],
      });
    }
    await expect(prisma.deviceRuntime.count()).resolves.toBe(15);
    await expect(prisma.operatorPostSession.count()).resolves.toBe(0);
    await expect(prisma.shift.count()).resolves.toBe(1);
    await expect(prisma.shiftBagUsage.count()).resolves.toBe(0);
    await expect(prisma.commercialOrder.count()).resolves.toBe(1);
    await expect(prisma.rawMaterialStock.count()).resolves.toBe(2);
    await expect(prisma.rawMaterialDefinition.count()).resolves.toBe(
      PILOT_MATERIAL_DEFINITION_COUNT,
    );
    await expect(prisma.sourceSnapshot.count()).resolves.toBe(0);

    const materialDefinitions = await prisma.rawMaterialDefinition.findMany({
      select: { id: true, name: true, normalizedName: true, kind: true, status: true },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
    });
    expect(new Set(materialDefinitions.map((definition) => definition.normalizedName)).size).toBe(
      PILOT_MATERIAL_DEFINITION_COUNT,
    );
    expect(materialDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'rmd-base-primary',
          name: 'ПВД Первичное',
          kind: 'base',
          status: 'active',
        }),
        expect.objectContaining({
          id: 'rmd-base-secondary',
          name: 'ПВД Вторичное',
          kind: 'base',
          status: 'active',
        }),
        expect.objectContaining({
          id: 'rmd-base-aika',
          name: 'ПВД Айка',
          kind: 'base',
          status: 'active',
        }),
      ]),
    );
    const stockLinks = await prisma.rawMaterialStock.findMany({
      select: {
        materialId: true,
        label: true,
        rawMaterialDefinitionId: true,
        rawMaterialDefinition: {
          select: { id: true, name: true, normalizedName: true, kind: true, status: true },
        },
      },
      orderBy: { materialId: 'asc' },
    });
    expect(stockLinks).toHaveLength(2);
    expect(stockLinks).toEqual([
      expect.objectContaining({
        materialId: 'pilot-rm-pvd-10803',
        label: 'Пилот · ПВД 10803-020',
        rawMaterialDefinitionId: expect.any(String),
        rawMaterialDefinition: expect.objectContaining({
          name: 'Пилот · ПВД 10803-020',
          kind: 'custom',
          status: 'active',
        }),
      }),
      expect.objectContaining({
        materialId: 'pilot-rm-pvd-15803',
        label: 'Пилот · ПВД 15803-020',
        rawMaterialDefinitionId: expect.any(String),
        rawMaterialDefinition: expect.objectContaining({
          name: 'Пилот · ПВД 15803-020',
          kind: 'custom',
          status: 'active',
        }),
      }),
    ]);
    for (const stock of stockLinks) {
      expect(stock.rawMaterialDefinition?.id).toBe(stock.rawMaterialDefinitionId);
    }

    await expect(
      prisma.commercialOrder.findUnique({ where: { orderNumber: 'PILOT-TEST-001' } }),
    ).resolves.toMatchObject({
      title: 'Первый аппаратный тест — фиктивные данные',
      productionIndicator: 'in_production',
      warehouseCoverStatus: 'not_checked',
      paymentStatus: 'partial',
      shipmentStatus: 'not_shipped',
    });
    await expect(
      prisma.rollDispatchItem.findUnique({ where: { rollCode: 'PILOT-PHYSICAL-ROLL-001' } }),
    ).resolves.toMatchObject({ machineId: 'POST-1', status: 'assigned' });
    await expect(
      prisma.rollDispatchItem.findUnique({ where: { rollCode: 'PILOT-SIM-ROLL-001' } }),
    ).resolves.toMatchObject({ machineId: 'POST-5', status: 'assigned' });
    await expect(
      prisma.shift.findUnique({ where: { id: 'pilot-test-shift-001' } }),
    ).resolves.toMatchObject({ status: 'planned', startedAt: null });
    await expect(
      prisma.operatorShiftMachineAssignment.findMany({
        where: { shiftId: 'pilot-test-shift-001' },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'planned', lockedAt: null, postId: expect.any(String) }),
      expect.objectContaining({ status: 'planned', lockedAt: null, postId: expect.any(String) }),
    ]);
    await expect(
      prisma.bigBagUnit.findMany({
        where: { id: { in: ['pilot-test-bag-physical-001', 'pilot-test-bag-sim-001'] } },
        orderBy: { id: 'asc' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'available' }),
      expect.objectContaining({ status: 'available' }),
    ]);

    const posts = await prisma.post.findMany({
      where: { code: { in: ['POST-1', 'POST-2', 'POST-3', 'POST-4', 'POST-5'] } },
      orderBy: { code: 'asc' },
      include: { devices: { orderBy: { id: 'asc' } } },
    });
    expect(posts.map((post) => post.code)).toEqual([
      'POST-1',
      'POST-2',
      'POST-3',
      'POST-4',
      'POST-5',
    ]);
    for (const post of posts) {
      const postNumber = Number(post.code.slice('POST-'.length));
      expect(post.devices).toHaveLength(3);
      expect(post.devices.map((device) => device.id)).toEqual(
        [
          `scale-post-${postNumber}`,
          `scanner-post-${postNumber}`,
          `printer-post-${postNumber}`,
        ].sort(),
      );
      expect(post.devices.some((device) => /^(?:dev|demo|test)[._:-]/u.test(device.id))).toBe(
        false,
      );
      expect(post.devices.every((device) => device.isEnabled)).toBe(true);
      expect(post.devices.map((device) => device.kind).sort()).toEqual([
        'printer',
        'scale',
        'scanner',
      ]);
      expect(post.devices.every((device) => device.postId === post.id)).toBe(true);
      expect(post.devices.every((device) => device.status === 'offline')).toBe(true);
      expect(post.devices.every((device) => device.rawPayload === null)).toBe(true);
      expect(post.devices.every((device) => device.parsedPayload === null)).toBe(true);
    }
  });

  it('upgrades pristine legacy simulator ownership idempotently without rewriting runtime facts', async () => {
    const staged = await stageLegacySimulatorFixture();
    const stableLine = await prisma.operatorRollLine.findUniqueOrThrow({
      where: { id: staged.line.id },
    });

    seed('Pilot seed with pristine legacy simulator');
    const firstAssignment = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
      where: { id: staged.assignment.id },
    });
    const firstDispatch = await prisma.rollDispatchItem.findUniqueOrThrow({
      where: { id: staged.dispatch.id },
    });
    seed('Repeated pilot seed after simulator upgrade');

    await expect(prisma.user.count()).resolves.toBe(10);
    await expect(prisma.user.count({ where: { isActive: true } })).resolves.toBe(9);
    await expect(
      prisma.user.count({ where: { isActive: true, role: Role.operator } }),
    ).resolves.toBe(3);
    await expect(
      prisma.user.findUnique({ where: { id: staged.retired.id } }),
    ).resolves.toMatchObject({
      externalId: 'seed-operator-4',
      isActive: false,
    });
    await expect(prisma.session.findUnique({ where: { id: staged.session.id } })).resolves.toEqual(
      expect.objectContaining({ userId: staged.retired.id, revokedAt: expect.any(Date) }),
    );
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: staged.assignment.id },
      }),
    ).resolves.toEqual(firstAssignment);
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: staged.dispatch.id } }),
    ).resolves.toEqual(firstDispatch);
    expect(firstAssignment).toMatchObject({
      id: 'pilot-test-assignment-post-5',
      operatorId: staged.current.id,
      postId: staged.assignment.postId,
      shiftId: 'pilot-test-shift-001',
      status: 'planned',
      lockedAt: null,
    });
    expect(firstDispatch).toMatchObject({
      id: 'pilot-test-dispatch-2',
      rollCode: 'PILOT-SIM-ROLL-001',
      assignedOperatorId: staged.current.id,
      postId: staged.dispatch.postId,
      machineId: 'POST-5',
      plannedShiftId: 'pilot-test-shift-001',
      status: 'assigned',
    });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: staged.line.id } }),
    ).resolves.toEqual(stableLine);
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: staged.physicalAssignment.id },
      }),
    ).resolves.toEqual(staged.physicalAssignment);
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({
        where: { id: staged.physicalDispatch.id },
      }),
    ).resolves.toEqual(staged.physicalDispatch);
    await expect(
      prisma.shift.findUniqueOrThrow({ where: { id: staged.shift.id } }),
    ).resolves.toEqual(staged.shift);
    await expect(
      prisma.bigBagUnit.findUniqueOrThrow({ where: { id: staged.bag.id } }),
    ).resolves.toEqual(staged.bag);
  });

  it('rolls back account retirement when legacy simulator runtime evidence has progressed', async () => {
    const staged = await stageLegacySimulatorFixture(true);

    const stderr = seedFailure('Progressed legacy simulator seed');

    expect(stderr).toContain('Pilot test data:');
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: staged.retired.id } }),
    ).resolves.toMatchObject({
      isActive: true,
    });
    await expect(
      prisma.session.findUniqueOrThrow({ where: { id: staged.session.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
        where: { id: staged.assignment.id },
      }),
    ).resolves.toMatchObject({ operatorId: staged.retired.id });
    await expect(
      prisma.rollDispatchItem.findUniqueOrThrow({ where: { id: staged.dispatch.id } }),
    ).resolves.toMatchObject({ assignedOperatorId: staged.retired.id });
    await expect(
      prisma.operatorRollLine.findUniqueOrThrow({ where: { id: staged.line.id } }),
    ).resolves.toMatchObject({ step: 'spool_weight' });
  });

  it('repairs account access and preserves runtime and active production state', async () => {
    seed();
    const definitionsBefore = await prisma.rawMaterialDefinition.findMany({
      select: { id: true, name: true, normalizedName: true, kind: true, status: true },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
    });
    const stockLinksBefore = await prisma.rawMaterialStock.findMany({
      select: { materialId: true, rawMaterialDefinitionId: true },
      orderBy: { materialId: 'asc' },
    });
    const user = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-commercial' },
    });
    const nullableUser = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-finance' },
    });
    const operator = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-operator-2' },
    });
    const post = await prisma.post.findUniqueOrThrow({ where: { code: 'POST-2' } });
    const nullablePost = await prisma.post.findUniqueOrThrow({ where: { code: 'POST-5' } });
    const device = await prisma.deviceRuntime.findUniqueOrThrow({
      where: { id: 'scale-post-2' },
    });
    const lastSeenAt = new Date('2026-07-17T10:00:00.000Z');
    const plannedStartAt = new Date(Date.now() - 60_000);
    const plannedEndAt = new Date(Date.now() + 60_000);

    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false, mustChangePassword: false },
    });
    const reactivationSession = await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await prisma.user.update({
      where: { id: nullableUser.id },
      data: { passwordHash: null, mustChangePassword: false },
    });
    await prisma.post.update({
      where: { id: post.id },
      data: { status: 'broken', agentStatus: 'offline', lastSeenAt },
    });
    await prisma.post.update({
      where: { id: nullablePost.id },
      data: { agentTokenHash: null },
    });
    await prisma.deviceRuntime.update({
      where: { id: device.id },
      data: {
        isEnabled: false,
        status: 'error',
        lastSeenAt,
        lastTestAt: lastSeenAt,
        parsedPayload: { retained: true },
        rawPayload: { retained: true },
        recovery: 'retained recovery',
      },
    });
    await prisma.accessTemplate.update({
      where: { id: 'tpl-operator' },
      data: { name: 'Retained operator template', capabilityDenials: ['roll:weigh'] },
    });
    const shift = await prisma.shift.create({
      data: {
        id: 'pilot-live-shift',
        label: 'Pilot live shift',
        plannedStartAt,
        plannedEndAt,
        startedAt: plannedStartAt,
        status: 'open',
      },
    });
    const assignment = await prisma.operatorShiftMachineAssignment.create({
      data: {
        shiftId: shift.id,
        operatorId: operator.id,
        postId: post.id,
        status: 'locked',
        lockedAt: plannedStartAt,
      },
    });
    const session = await prisma.operatorPostSession.create({
      data: {
        id: 'pilot-live-session',
        operatorId: operator.id,
        postId: post.id,
        shiftId: shift.id,
        status: 'active',
      },
    });

    seed('Repeated pilot seed');

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const reactivationSessionAfter = await prisma.session.findUniqueOrThrow({
      where: { id: reactivationSession.id },
    });
    const nullableUserAfter = await prisma.user.findUniqueOrThrow({
      where: { id: nullableUser.id },
    });
    const postAfter = await prisma.post.findUniqueOrThrow({ where: { id: post.id } });
    const nullablePostAfter = await prisma.post.findUniqueOrThrow({
      where: { id: nullablePost.id },
    });
    const deviceAfter = await prisma.deviceRuntime.findUniqueOrThrow({ where: { id: device.id } });
    const templateAfter = await prisma.accessTemplate.findUniqueOrThrow({
      where: { id: 'tpl-operator' },
    });
    const sessionAfter = await prisma.operatorPostSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    const shiftAfter = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    const assignmentAfter = await prisma.operatorShiftMachineAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });

    expect(userAfter.passwordHash === user.passwordHash).toBe(true);
    expect(userAfter).toMatchObject({ isActive: true, mustChangePassword: false });
    expect(reactivationSessionAfter).toMatchObject({
      userId: user.id,
      revokedAt: expect.any(Date),
    });
    expect(nullableUserAfter.passwordHash !== null).toBe(true);
    expect(nullableUserAfter.mustChangePassword).toBe(false);
    expect(postAfter.agentTokenHash === post.agentTokenHash).toBe(true);
    expect(postAfter).toMatchObject({ status: 'broken', agentStatus: 'offline', lastSeenAt });
    expect(nullablePostAfter.agentTokenHash !== null).toBe(true);
    expect(deviceAfter).toMatchObject({
      isEnabled: false,
      status: 'error',
      lastSeenAt,
      lastTestAt: lastSeenAt,
      parsedPayload: { retained: true },
      rawPayload: { retained: true },
      recovery: 'retained recovery',
      postId: post.id,
    });
    expect(templateAfter).toMatchObject({
      name: 'Retained operator template',
      capabilityDenials: ['roll:weigh'],
    });
    expect(sessionAfter).toMatchObject({ status: 'active', endedAt: null, shiftId: shift.id });
    expect(shiftAfter).toMatchObject({ status: 'open', startedAt: plannedStartAt, endedAt: null });
    expect(assignmentAfter).toMatchObject({
      status: 'locked',
      lockedAt: plannedStartAt,
      postId: post.id,
    });
    const definitionsAfter = await prisma.rawMaterialDefinition.findMany({
      select: { id: true, name: true, normalizedName: true, kind: true, status: true },
      orderBy: [{ normalizedName: 'asc' }, { id: 'asc' }],
    });
    const stockLinksAfter = await prisma.rawMaterialStock.findMany({
      select: { materialId: true, rawMaterialDefinitionId: true },
      orderBy: { materialId: 'asc' },
    });
    expect(definitionsAfter).toEqual(definitionsBefore);
    expect(definitionsAfter).toHaveLength(PILOT_MATERIAL_DEFINITION_COUNT);
    expect(new Set(definitionsAfter.map((definition) => definition.normalizedName)).size).toBe(
      PILOT_MATERIAL_DEFINITION_COUNT,
    );
    expect(stockLinksAfter).toEqual(stockLinksBefore);
    expect(stockLinksAfter.every((stock) => stock.rawMaterialDefinitionId !== null)).toBe(true);
  });

  it('upgrades the known legacy device id without losing its runtime state', async () => {
    const post = await prisma.post.findUniqueOrThrow({ where: { code: 'POST-1' } });
    const lastSeenAt = new Date('2026-07-17T10:00:00.000Z');
    await prisma.deviceRuntime.create({
      data: {
        id: 'dev-scale-1',
        code: 'SCALE-1',
        label: 'Весы станка 1',
        kind: 'scale',
        connectionKind: 'usb-rs232',
        isEnabled: false,
        status: 'error',
        ownerRole: 'admin',
        lastSeenAt,
        parsedPayload: { retained: true },
        rawPayload: { retained: true },
        recovery: 'retained recovery',
        postId: post.id,
      },
    });

    seed('Legacy pilot topology upgrade');

    await expect(
      prisma.deviceRuntime.findUnique({ where: { id: 'dev-scale-1' } }),
    ).resolves.toBeNull();
    await expect(
      prisma.deviceRuntime.findUniqueOrThrow({ where: { id: 'scale-post-1' } }),
    ).resolves.toMatchObject({
      code: 'SCALE-1',
      isEnabled: false,
      status: 'error',
      lastSeenAt,
      parsedPayload: { retained: true },
      rawPayload: { retained: true },
      recovery: 'retained recovery',
      postId: post.id,
    });
  });

  it('fails a role mismatch atomically without overwriting authorization', async () => {
    seed();
    const mismatched = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-commercial' },
    });
    const nullable = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-finance' },
    });
    await prisma.user.update({ where: { id: mismatched.id }, data: { role: 'director' } });
    await prisma.user.update({ where: { id: nullable.id }, data: { passwordHash: null } });

    expect(() => seed('Mismatched pilot seed')).toThrow('failed with exit code');
    await expect(prisma.user.findUnique({ where: { id: mismatched.id } })).resolves.toMatchObject({
      role: 'director',
    });
    const nullableAfter = await prisma.user.findUniqueOrThrow({ where: { id: nullable.id } });
    expect(nullableAfter.passwordHash === null).toBe(true);
  });

  it('fails a binding conflict atomically without filling an earlier null password', async () => {
    seed();
    const user = await prisma.user.findUniqueOrThrow({
      where: { externalId: 'seed-commercial' },
    });
    const conflictingPost = await prisma.post.findUniqueOrThrow({ where: { code: 'POST-2' } });
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });
    await prisma.deviceRuntime.update({
      where: { id: 'scale-post-2' },
      data: { isEnabled: false },
    });
    await prisma.deviceRuntime.update({
      where: { id: 'scale-post-1' },
      data: { postId: conflictingPost.id },
    });

    expect(() => seed('Conflicting pilot seed')).toThrow('failed with exit code');
    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(userAfter.passwordHash === null).toBe(true);
  });
});
