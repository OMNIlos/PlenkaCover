import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  assertCommandSucceeded,
  assertDisposableDatabaseTarget,
  assertSchemaDestructionTarget,
  cleanupE2eDatabase,
  createE2eSchemaName,
  prepareE2eDatabase,
  runE2eWithCleanup,
  type E2eDatabaseClient,
  type E2eDatabaseIdentityClient,
} from '../../test/e2e-database';
import { initializeE2eApp } from '../../test/e2e-app';

const SCHEMA_ENV = 'PLENKA_E2E_SCHEMA';
const PREVIOUS_SEED_PROFILE_ENV = 'PLENKA_E2E_PREVIOUS_SEED_PROFILE';
const DATABASE_NAME_ENV = 'PLENKA_E2E_DATABASE_NAME';
const DATABASE_MARKER_ENV = 'PLENKA_E2E_DATABASE_MARKER';

type E2eGlobal = typeof globalThis & { __PLENKA_E2E_SCHEMA__?: string };

@Controller('e2e-listener-probe')
class E2eListenerProbeController {
  @Get()
  probe() {
    return { ready: true };
  }
}

function errorText(error: unknown): string {
  if (error instanceof AggregateError) {
    return [error.name, error.message, error.stack, ...error.errors.map(errorText)].join('\n');
  }
  if (error instanceof Error) return [error.name, error.message, error.stack].join('\n');
  return String(error);
}

function captureError(work: () => void): Error {
  try {
    work();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected work to fail');
}

describe('isolated e2e database infrastructure', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalSchema = process.env[SCHEMA_ENV];
  const originalSeedProfile = process.env.SEED_PROFILE;
  const originalPreviousSeedProfile = process.env[PREVIOUS_SEED_PROFILE_ENV];
  const originalSeedPassword = process.env.SEED_PASSWORD;
  const originalDatabaseName = process.env[DATABASE_NAME_ENV];
  const originalDatabaseMarker = process.env[DATABASE_MARKER_ENV];
  const originalGlobalSchema = (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__;

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalSchema === undefined) delete process.env[SCHEMA_ENV];
    else process.env[SCHEMA_ENV] = originalSchema;
    if (originalSeedProfile === undefined) delete process.env.SEED_PROFILE;
    else process.env.SEED_PROFILE = originalSeedProfile;
    if (originalPreviousSeedProfile === undefined) delete process.env[PREVIOUS_SEED_PROFILE_ENV];
    else process.env[PREVIOUS_SEED_PROFILE_ENV] = originalPreviousSeedProfile;
    if (originalSeedPassword === undefined) delete process.env.SEED_PASSWORD;
    else process.env.SEED_PASSWORD = originalSeedPassword;
    if (originalDatabaseName === undefined) delete process.env[DATABASE_NAME_ENV];
    else process.env[DATABASE_NAME_ENV] = originalDatabaseName;
    if (originalDatabaseMarker === undefined) delete process.env[DATABASE_MARKER_ENV];
    else process.env[DATABASE_MARKER_ENV] = originalDatabaseMarker;
    if (originalGlobalSchema === undefined) {
      delete (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__;
    } else {
      (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ = originalGlobalSchema;
    }
  });

  it('requires an exact database name and server-side disposable marker before e2e mutation', async () => {
    const databaseName = 'plenka_e2e_infra';
    const marker = '00112233-4455-4677-8899-aabbccddeeff';
    process.env[DATABASE_NAME_ENV] = databaseName;
    process.env[DATABASE_MARKER_ENV] = marker;
    const query = jest.fn().mockResolvedValue([
      {
        databaseName,
        databaseComment: `plenka:e2e-disposable:v1:${marker}`,
      },
    ]);
    const client: E2eDatabaseIdentityClient = {
      $queryRawUnsafe: query,
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };

    await expect(
      assertDisposableDatabaseTarget(
        `postgresql://ci-user@127.0.0.1/${databaseName}?schema=public`,
        () => client,
      ),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('shobj_description'));

    process.env[DATABASE_MARKER_ENV] = '11112233-4455-4677-8899-aabbccddeeff';
    await expect(
      assertDisposableDatabaseTarget(
        `postgresql://ci-user@127.0.0.1/${databaseName}?schema=public`,
        () => client,
      ),
    ).rejects.toThrow('E2E database disposable identity is not verified');
  });

  it('rejects a missing or non-e2e database identity before constructing a probe client', async () => {
    delete process.env[DATABASE_NAME_ENV];
    delete process.env[DATABASE_MARKER_ENV];
    const createClient = jest.fn<ReturnType<() => E2eDatabaseIdentityClient>, []>();

    await expect(
      assertDisposableDatabaseTarget(
        'postgresql://ci-user@127.0.0.1/plenka?schema=public',
        createClient,
      ),
    ).rejects.toThrow('E2E database disposable identity is not configured');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps one loopback listener for every Supertest request in an app suite', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [E2eListenerProbeController],
    }).compile();
    const app: INestApplication = moduleRef.createNestApplication();

    try {
      await initializeE2eApp(app);
      const server = app.getHttpServer();
      expect(server.listening).toBe(true);

      await request(server).get('/e2e-listener-probe').expect(200, { ready: true });
      expect(server.listening).toBe(true);
      await request(server).get('/e2e-listener-probe').expect(200, { ready: true });
      expect(server.listening).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('sets an explicit demo seed profile before running the e2e seed', async () => {
    const observedProfiles: Array<string | undefined> = [];
    process.env.DATABASE_URL = 'postgresql://ci-user@127.0.0.1/test?schema=public';

    await prepareE2eDatabase({
      createSchemaName: () => 'e2e_42_001122334455',
      runCommand: (label) => {
        if (label === 'E2E seed') observedProfiles.push(process.env.SEED_PROFILE);
      },
      dropSchema: jest.fn(),
      verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
    });

    expect(observedProfiles).toEqual(['demo']);
  });

  it.each([
    'postgresql://ci-user@localhost/test?schema=public',
    'postgres://ci-user@127.9.8.7/test?schema=public',
    'postgresql://ci-user@[::1]/test?schema=public',
  ])('keeps the isolated-schema flow available on a canonical loopback host: %s', async (url) => {
    const runCommand = jest.fn();
    process.env.DATABASE_URL = url;

    await prepareE2eDatabase({
      createSchemaName: () => 'e2e_42_001122334455',
      runCommand,
      dropSchema: jest.fn(),
      verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
    });

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(new URL(process.env.DATABASE_URL!).searchParams.get('schema')).toBe(
      'e2e_42_001122334455',
    );
    expect(new URL(process.env.DATABASE_URL!).searchParams.get('options')).toBe('-c timezone=UTC');
  });

  it('preserves caller connection options and makes the e2e session timezone deterministic', async () => {
    const runCommand = jest.fn();
    process.env.DATABASE_URL =
      'postgresql://ci-user@127.0.0.1/test?schema=public&options=-c%20statement_timeout%3D5000%20-c%20timezone%3DEurope%2FMoscow';

    await prepareE2eDatabase({
      createSchemaName: () => 'e2e_42_001122334455',
      runCommand,
      dropSchema: jest.fn(),
      verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
    });

    expect(new URL(process.env.DATABASE_URL!).searchParams.get('options')).toBe(
      '-c statement_timeout=5000 -c timezone=Europe/Moscow -c timezone=UTC',
    );
  });

  it.each([
    'postgresql://ci-user@production.example/test?schema=public',
    'postgresql://localhost@production.example/test?schema=public',
    'postgresql://ci-user@localhost.evil.example/test?schema=public',
    'postgresql://ci-user@192.0.2.10/test?schema=public',
    'postgresql://ci-user@127.1/test?schema=public',
    'postgresql://ci-user@2130706433/test?schema=public',
    'postgresql://ci-user@localhost./test?schema=public',
    'postgresql://ci-user@localhost/test?schema=public&host=production.example',
    'postgresql://ci-user@127.0.0.1/test?schema=public&hostaddr=192.0.2.10',
  ])('rejects a remote e2e setup target before migrate, seed, or cleanup: %s', async (url) => {
    const runCommand = jest.fn();
    const dropSchema = jest.fn();
    process.env.DATABASE_URL = url;

    await expect(
      prepareE2eDatabase({
        createSchemaName: () => 'e2e_42_001122334455',
        runCommand,
        dropSchema,
      }),
    ).rejects.toThrow('E2E DATABASE_URL must target PostgreSQL on a loopback host');

    expect(runCommand).not.toHaveBeenCalled();
    expect(dropSchema).not.toHaveBeenCalled();
    expect(process.env.DATABASE_URL).toBe(url);
    expect(process.env[SCHEMA_ENV]).toBe(originalSchema);
    expect((globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__).toBe(originalGlobalSchema);
  });

  it('rejects a remote cleanup target before constructing a database client', async () => {
    const schema = 'e2e_42_001122334455';
    process.env[SCHEMA_ENV] = schema;
    (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ = schema;
    process.env.DATABASE_URL = `postgresql://ci-user@production.example/test?schema=${schema}`;
    const createClient = jest.fn(
      (): E2eDatabaseClient => ({
        $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
        $disconnect: jest.fn().mockResolvedValue(undefined),
      }),
    );

    await expect(cleanupE2eDatabase({ createClient })).rejects.toThrow(
      'E2E DATABASE_URL must target PostgreSQL on a loopback host',
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(process.env[SCHEMA_ENV]).toBe(schema);
  });

  it('restores the caller seed profile after setup fails', async () => {
    process.env.DATABASE_URL = 'postgresql://ci-user@127.0.0.1/test?schema=public';
    process.env.SEED_PROFILE = 'pilot';

    await expect(
      prepareE2eDatabase({
        createSchemaName: () => 'e2e_42_001122334455',
        runCommand: () => {
          throw new Error('expected setup failure');
        },
        dropSchema: jest.fn().mockResolvedValue(undefined),
        verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow('E2E database setup failed');

    expect(process.env.SEED_PROFILE).toBe('pilot');
    expect(process.env[PREVIOUS_SEED_PROFILE_ENV]).toBeUndefined();
  });

  it('does not copy child output or spawn errors into a command failure', () => {
    const sensitiveValues = [
      ['postgresql://ci-user:', 'PASSWORD_SENTINEL', '@HOST_SENTINEL:5432/db'].join(''),
      'TOKEN_SENTINEL',
      'POST-DEVICE-SERIAL-SENTINEL',
    ];
    const outputFailure = captureError(() =>
      assertCommandSucceeded('E2E seed', {
        status: 23,
        error: undefined,
        stdout: sensitiveValues.join(' '),
        stderr: sensitiveValues.join(' '),
      }),
    );
    const spawnFailure = captureError(() =>
      assertCommandSucceeded('Prisma e2e migration', {
        status: null,
        error: new Error(sensitiveValues.join(' ')),
        stdout: '',
        stderr: '',
      }),
    );

    expect(outputFailure.message).toBe('E2E seed failed with exit code 23');
    expect(spawnFailure.message).toBe('Prisma e2e migration failed to start');
    for (const sensitive of sensitiveValues) {
      expect(errorText(outputFailure)).not.toContain(sensitive);
      expect(errorText(spawnFailure)).not.toContain(sensitive);
    }
  });

  it('attempts every cleanup and retains the primary failure with cleanup diagnostics', async () => {
    const calls: string[] = [];
    const primaryFailure = new Error('primary restore failure');
    const sourceClientFailure = new Error('source client disconnect failure');
    const sourceSchemaFailure = new Error('source schema cleanup failure');
    let failure: unknown;

    try {
      await runE2eWithCleanup(async () => {
        throw primaryFailure;
      }, [
        {
          label: 'source Prisma client',
          run: () => {
            calls.push('source-client');
            throw sourceClientFailure;
          },
        },
        {
          label: 'target Prisma client',
          run: () => {
            calls.push('target-client');
          },
        },
        {
          label: 'source schema',
          run: () => {
            calls.push('source-schema');
            throw sourceSchemaFailure;
          },
        },
        {
          label: 'target database',
          run: () => {
            calls.push('target-database');
          },
        },
      ]);
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual(['source-client', 'target-client', 'source-schema', 'target-database']);
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors).toEqual([primaryFailure, sourceClientFailure, sourceSchemaFailure]);
    expect((failure as AggregateError).message).toContain('source Prisma client, source schema');
    expect(errorText(failure)).toContain('primary restore failure');
    expect(errorText(failure)).toContain('source client disconnect failure');
    expect(errorText(failure)).toContain('source schema cleanup failure');
  });

  it.each([
    'public',
    'e2e_0_001122334455',
    'e2e_-1_001122334455',
    'e2e_42_00112233445',
    'e2e_42_0011223344556',
    'e2e_42_00112233445G',
    'e2e_42_001122334455_extra',
  ])('rejects invalid destructive schema target %s', (schema) => {
    expect(() =>
      assertSchemaDestructionTarget(
        schema,
        `postgresql://ci-user@127.0.0.1/test?schema=${encodeURIComponent(schema)}`,
      ),
    ).toThrow('Refusing to drop a database schema outside the exact e2e namespace');
  });

  it('requires the exact schema to be the sole DATABASE_URL schema parameter', () => {
    const schema = 'e2e_42_001122334455';
    expect(() =>
      assertSchemaDestructionTarget(
        schema,
        'postgresql://ci-user@127.0.0.1/test?schema=e2e_42_aabbccddeeff',
      ),
    ).toThrow('Refusing to drop an e2e schema that does not match DATABASE_URL');
    expect(() =>
      assertSchemaDestructionTarget(
        schema,
        `postgresql://ci-user@127.0.0.1/test?schema=${schema}&schema=${schema}`,
      ),
    ).toThrow('Refusing to drop an e2e schema that does not match DATABASE_URL');
  });

  it('generates exact, unique namespaces across concurrent callers', async () => {
    expect(createE2eSchemaName(42, Buffer.from('001122334455', 'hex'))).toBe('e2e_42_001122334455');
    const schemas = await Promise.all(
      Array.from({ length: 64 }, async () => createE2eSchemaName()),
    );
    expect(new Set(schemas).size).toBe(schemas.length);
    expect(schemas.every((schema) => /^e2e_[1-9]\d*_[0-9a-f]{12}$/.test(schema))).toBe(true);
  });

  it('rejects an invalid fallback schema before constructing a database client', async () => {
    delete (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__;
    process.env[SCHEMA_ENV] = 'e2e_fallback';
    process.env.DATABASE_URL = 'postgresql://ci-user@127.0.0.1/test?schema=e2e_fallback';
    const createClient = jest.fn<ReturnType<() => E2eDatabaseClient>, []>();

    await expect(cleanupE2eDatabase({ createClient })).rejects.toThrow(
      'Refusing to drop a database schema outside the exact e2e namespace',
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(process.env[SCHEMA_ENV]).toBe('e2e_fallback');
  });

  it('rejects a DATABASE_URL mismatch before constructing a database client', async () => {
    const schema = 'e2e_42_001122334455';
    process.env[SCHEMA_ENV] = schema;
    (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ = schema;
    process.env.DATABASE_URL = 'postgresql://ci-user@127.0.0.1/test?schema=e2e_42_aabbccddeeff';
    const createClient = jest.fn<ReturnType<() => E2eDatabaseClient>, []>();

    await expect(cleanupE2eDatabase({ createClient })).rejects.toThrow(
      'Refusing to drop an e2e schema that does not match DATABASE_URL',
    );
    expect(createClient).not.toHaveBeenCalled();
    expect(process.env[SCHEMA_ENV]).toBe(schema);
  });

  it('keeps cleanup state and emits only a generic failure when DROP fails', async () => {
    const schema = 'e2e_42_001122334455';
    const sensitive = 'HOST-TOKEN-DEVICE-SENTINEL';
    process.env[SCHEMA_ENV] = schema;
    (globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__ = schema;
    process.env.DATABASE_URL = `postgresql://ci-user@127.0.0.1/test?schema=${schema}`;
    const client: E2eDatabaseClient = {
      $executeRawUnsafe: jest.fn().mockRejectedValue(new Error(sensitive)),
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };

    let failure: unknown;
    try {
      await cleanupE2eDatabase({
        createClient: () => client,
        verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Failed to remove the isolated e2e database schema');
    expect(errorText(failure)).not.toContain(sensitive);
    expect(process.env[SCHEMA_ENV]).toBe(schema);
    expect((globalThis as E2eGlobal).__PLENKA_E2E_SCHEMA__).toBe(schema);
  });

  it('preserves a safe setup error and adds a generic cleanup error without clearing state', async () => {
    const schema = 'e2e_42_001122334455';
    const sensitive = 'PASSWORD-TOKEN-HOST-POST-SENTINEL';
    const setupError = captureError(() =>
      assertCommandSucceeded('Prisma e2e migration', {
        status: 31,
        error: undefined,
        stdout: sensitive,
        stderr: sensitive,
      }),
    );
    process.env.DATABASE_URL = 'postgresql://ci-user@127.0.0.1/test?schema=public';

    let failure: unknown;
    try {
      await prepareE2eDatabase({
        createSchemaName: () => schema,
        runCommand: () => {
          throw setupError;
        },
        dropSchema: async () => {
          throw new Error(sensitive);
        },
        verifyDisposableTarget: jest.fn().mockResolvedValue(undefined),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors as Error[];
    expect(errors.map((error) => error.message)).toEqual([
      'Prisma e2e migration failed with exit code 31',
      'Failed to remove the isolated e2e database schema after setup failure',
    ]);
    expect(errorText(failure)).not.toContain(sensitive);
    expect(process.env[SCHEMA_ENV]).toBe(schema);
    expect(new URL(process.env.DATABASE_URL!).searchParams.get('schema')).toBe(schema);
  });

  it('uses masked random credentials and a loopback-only PostgreSQL container in CI', () => {
    const workflow = readFileSync(
      resolve(__dirname, '../../../../.github/workflows/ci.yml'),
      'utf8',
    );

    expect(workflow).not.toContain('POSTGRES_HOST_AUTH_METHOD');
    expect(workflow).not.toMatch(/^\s+services:/m);
    expect(workflow).not.toMatch(/^\s+DATABASE_URL:\s*postgres/m);
    expect(workflow).toContain('openssl rand -hex 32');
    expect(workflow).toContain('::add-mask::');
    expect(workflow).toContain('$GITHUB_ENV');
    expect(workflow).toContain('--publish 127.0.0.1:5433:5432');
    expect(workflow).toContain('--health-cmd');
    expect(workflow).toContain('PLENKA_E2E_DATABASE_NAME=');
    expect(workflow).toContain('PLENKA_E2E_DATABASE_MARKER=');
    expect(workflow).toContain('COMMENT ON DATABASE');
    expect(workflow).toContain('npm audit --omit=dev --audit-level=high');

    const apiPackage = JSON.parse(
      readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(apiPackage.scripts['test:e2e']).toMatch(/^NODE_ENV=test /u);
    expect(apiPackage.scripts['test:e2e:auth-runtime']).toMatch(/^NODE_ENV=test /u);
  });
});
