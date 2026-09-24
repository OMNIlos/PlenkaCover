import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadReleaseInfo } from './release-info';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-release-info-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('gateway release info', () => {
  it('loads immutable package identity and the OS boot id', () => {
    const buildInfoPath = path.join(dir, 'BUILD-INFO');
    const bootIdPath = path.join(dir, 'boot_id');
    fs.writeFileSync(
      buildInfoPath,
      [
        'Release-Commit: 1b5005b4660f5997c956b718958e5ee3a3516d94',
        'Debian-Version: 1:0.0.1+git788.1785844317.1b5005b4660f',
      ].join('\n'),
    );
    fs.writeFileSync(bootIdPath, '7f620c8e-2bbf-4ef8-9e91-b094611229c7\n');

    expect(
      loadReleaseInfo({
        deploymentMode: 'physical',
        buildInfoPath,
        bootIdPath,
        startedAt: new Date('2026-08-04T12:45:00.000Z'),
      }),
    ).toEqual({
      packageVersion: '1:0.0.1+git788.1785844317.1b5005b4660f',
      releaseCommit: '1b5005b4660f5997c956b718958e5ee3a3516d94',
      bootId: '7f620c8e-2bbf-4ef8-9e91-b094611229c7',
      startedAt: '2026-08-04T12:45:00.000Z',
    });
  });

  it('fails closed when immutable build identity is missing in physical mode', () => {
    expect(() =>
      loadReleaseInfo({
        deploymentMode: 'physical',
        buildInfoPath: path.join(dir, 'missing'),
        bootIdPath: path.join(dir, 'missing-boot'),
      }),
    ).toThrow('gateway release info invalid');
  });

  it('uses a bounded non-production identity for development', () => {
    expect(
      loadReleaseInfo({
        deploymentMode: 'development',
        buildInfoPath: path.join(dir, 'missing'),
        bootIdPath: path.join(dir, 'missing-boot'),
        startedAt: new Date('2026-08-04T12:45:00.000Z'),
      }),
    ).toMatchObject({
      packageVersion: 'development',
      releaseCommit: '000000000000',
      startedAt: '2026-08-04T12:45:00.000Z',
    });
  });
});
