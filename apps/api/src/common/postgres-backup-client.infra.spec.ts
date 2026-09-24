import type { SpawnSyncReturns } from 'node:child_process';
import {
  createDisposableRestoreDatabaseIdentity,
  dropDisposableRestoreDatabase,
  postgresClientEnvironment,
  postgresCommandOutcome,
  postgresMajorVersion,
  requirePostgresCommandSuccess,
  shouldDropDisposableRestoreDatabase,
} from '../../test/postgres-backup-client';

function commandResult(overrides: Partial<SpawnSyncReturns<Buffer>>): SpawnSyncReturns<Buffer> {
  return {
    pid: 1,
    output: [null, Buffer.alloc(0), Buffer.alloc(0)],
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    status: 0,
    signal: null,
    error: undefined,
    ...overrides,
  };
}

describe('PostgreSQL backup client safety', () => {
  it('removes inherited libpq target overrides and normalizes IPv6 loopback', () => {
    const env = postgresClientEnvironment(
      'postgresql://plenka:secret@[::1]:55439/e2e?schema=isolated',
      {
        PATH: '/safe/bin',
        TASK_MARKER: 'preserved',
        PGHOSTADDR: '203.0.113.10',
        PGSERVICE: 'production',
        PGSERVICEFILE: '/tmp/production.pg_service.conf',
        PGPASSFILE: '/tmp/production.pgpass',
        PGOPTIONS: '-c search_path=public',
      },
    );

    expect(env).toMatchObject({
      PATH: '/safe/bin',
      TASK_MARKER: 'preserved',
      PGHOST: '::1',
      PGPORT: '55439',
      PGUSER: 'plenka',
      PGPASSWORD: 'secret',
      PGDATABASE: 'e2e',
    });
    expect(env).not.toHaveProperty('PGHOSTADDR');
    expect(env).not.toHaveProperty('PGSERVICE');
    expect(env).not.toHaveProperty('PGSERVICEFILE');
    expect(env).not.toHaveProperty('PGPASSFILE');
    expect(env).not.toHaveProperty('PGOPTIONS');
  });

  it.each([
    'postgresql://plenka@db.internal/e2e?schema=isolated',
    'postgresql://plenka@127.0.0.1/e2e?hostaddr=203.0.113.10',
    'postgresql://plenka@localhost/e2e?host=%2Fvar%2Frun%2Fpostgresql',
  ])('rejects a non-loopback or overridden target before spawning: %s', (databaseUrl) => {
    expect(() => postgresClientEnvironment(databaseUrl)).toThrow(
      'Backup/restore e2e requires a loopback PostgreSQL target',
    );
  });

  it('treats signal termination and a null status as failure', () => {
    expect(() =>
      requirePostgresCommandSuccess('dump', commandResult({ status: null, signal: 'SIGTERM' })),
    ).toThrow('terminated by signal SIGTERM');
    expect(() => requirePostgresCommandSuccess('dump', commandResult({ status: null }))).toThrow(
      'failed with exit code null',
    );
  });

  it('parses supported PostgreSQL client version formats', () => {
    expect(postgresMajorVersion('pg_dump (PostgreSQL) 15.14 (Homebrew)')).toBe(15);
    expect(postgresMajorVersion('pg_restore (PostgreSQL) 16.3')).toBe(16);
    expect(() => postgresMajorVersion('unknown')).toThrow(
      'Cannot determine PostgreSQL major version',
    );
  });

  it('derives a strict child restore identity from two exact UUID markers', () => {
    expect(
      createDisposableRestoreDatabaseIdentity(
        '00112233-4455-4677-8899-aabbccddeeff',
        '11223344-5566-4788-99aa-bbccddeeff00',
      ),
    ).toEqual({
      database: 'plenka_e2e_restore_112233445566478899aabbccddeeff00',
      marker:
        'plenka:e2e-restore:v1:00112233-4455-4677-8899-aabbccddeeff:11223344-5566-4788-99aa-bbccddeeff00',
    });
    expect(() => createDisposableRestoreDatabaseIdentity('ALLOW=1')).toThrow(
      'Disposable restore database identity is not configured',
    );
  });

  it('never authorizes cleanup after a failed or uncertain CREATE DATABASE result', () => {
    expect(postgresCommandOutcome(commandResult({ status: 1 }))).toBe('failed');
    expect(postgresCommandOutcome(commandResult({ status: null }))).toBe('uncertain');
    expect(shouldDropDisposableRestoreDatabase('failed')).toBe(false);
    expect(shouldDropDisposableRestoreDatabase('not_attempted')).toBe(false);
    expect(() => shouldDropDisposableRestoreDatabase('uncertain')).toThrow(
      'creation outcome is uncertain',
    );
    expect(shouldDropDisposableRestoreDatabase('confirmed')).toBe(true);
  });

  it('refuses DROP when the child database marker does not match', () => {
    const identity = createDisposableRestoreDatabaseIdentity(
      '00112233-4455-4677-8899-aabbccddeeff',
      '11223344-5566-4788-99aa-bbccddeeff00',
    );
    const runClient = jest.fn().mockReturnValue(
      commandResult({
        stdout: Buffer.from(`${identity.database}\tplenka:e2e-restore:v1:wrong\n`),
      }),
    );

    expect(() =>
      dropDisposableRestoreDatabase(
        'postgresql://plenka@127.0.0.1/plenka_e2e_parent',
        'postgresql://plenka@127.0.0.1/postgres',
        identity,
        'psql',
        runClient,
      ),
    ).toThrow('Disposable restore database identity is not verified');
    expect(runClient).toHaveBeenCalledTimes(1);
  });

  it('drops only after an exact child database name and marker probe', () => {
    const identity = createDisposableRestoreDatabaseIdentity(
      '00112233-4455-4677-8899-aabbccddeeff',
      '11223344-5566-4788-99aa-bbccddeeff00',
    );
    const runClient = jest
      .fn()
      .mockReturnValueOnce(
        commandResult({ stdout: Buffer.from(`${identity.database}\t${identity.marker}\n`) }),
      )
      .mockReturnValueOnce(commandResult({}));

    expect(() =>
      dropDisposableRestoreDatabase(
        'postgresql://plenka@127.0.0.1/plenka_e2e_parent',
        'postgresql://plenka@127.0.0.1/postgres',
        identity,
        'psql',
        runClient,
      ),
    ).not.toThrow();
    expect(runClient).toHaveBeenCalledTimes(2);
    expect(runClient.mock.calls[0]?.[2]).toContainEqual(
      expect.stringContaining('shobj_description'),
    );
    expect(runClient.mock.calls[1]?.[2]).toContain(
      `DROP DATABASE "${identity.database}" WITH (FORCE);`,
    );
  });
});
