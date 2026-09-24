import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import type { GatewayDeploymentMode } from './config';

const DEFAULT_BUILD_INFO = '/usr/share/doc/plenka-gateway-agent/BUILD-INFO';
const DEFAULT_BOOT_ID = '/proc/sys/kernel/random/boot_id';
const RELEASE_COMMIT = /^[0-9a-f]{7,64}$/u;
const BOOT_ID = /^[A-Za-z0-9-]{1,128}$/u;

export interface GatewayAgentReleaseInfo {
  packageVersion: string;
  releaseCommit: string;
  bootId: string;
  startedAt: string;
}

export interface LoadReleaseInfoOptions {
  deploymentMode: GatewayDeploymentMode;
  buildInfoPath?: string;
  bootIdPath?: string;
  startedAt?: Date;
}

function readBuildInfo(file: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

function readBootId(file: string): string {
  return fs.readFileSync(file, 'utf8').trim();
}

function validPackageVersion(value: string | undefined): value is string {
  return Boolean(value && value.length <= 128 && !/[\r\n]/u.test(value));
}

export function loadReleaseInfo(options: LoadReleaseInfoOptions): GatewayAgentReleaseInfo {
  const startedAt = options.startedAt ?? new Date();
  const buildInfoPath = options.buildInfoPath ?? DEFAULT_BUILD_INFO;
  const bootIdPath = options.bootIdPath ?? DEFAULT_BOOT_ID;

  if (options.deploymentMode === 'development') {
    let bootId: string;
    try {
      const candidate = readBootId(bootIdPath);
      bootId = BOOT_ID.test(candidate) ? candidate : `dev-${randomUUID()}`;
    } catch {
      bootId = `dev-${randomUUID()}`;
    }
    return {
      packageVersion: 'development',
      releaseCommit: '000000000000',
      bootId,
      startedAt: startedAt.toISOString(),
    };
  }

  try {
    const fields = readBuildInfo(buildInfoPath);
    const packageVersion = fields['Debian-Version'];
    const releaseCommit = fields['Release-Commit'];
    const bootId = readBootId(bootIdPath);
    const startedAtIso = startedAt.toISOString();
    if (
      !validPackageVersion(packageVersion) ||
      !releaseCommit ||
      !RELEASE_COMMIT.test(releaseCommit) ||
      !BOOT_ID.test(bootId)
    ) {
      throw new Error('invalid immutable identity');
    }
    return { packageVersion, releaseCommit, bootId, startedAt: startedAtIso };
  } catch {
    throw new Error('gateway release info invalid: immutable package identity is unavailable');
  }
}

/** Hash only an explicitly selected, secret-free device configuration projection. */
export function configFingerprint(config: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
