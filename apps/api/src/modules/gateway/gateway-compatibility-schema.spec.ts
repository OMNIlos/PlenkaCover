import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const prismaRoot = resolve(__dirname, '../../../prisma');
const migration = resolve(
  prismaRoot,
  'migrations/20260804162000_gateway_agent_compatibility/migration.sql',
);

describe('gateway agent compatibility persistence', () => {
  it('stores durable commissioning and safe agent metadata without duplicating derived readiness', () => {
    const schema = readFileSync(resolve(prismaRoot, 'schema.prisma'), 'utf8');

    expect(schema).toMatch(
      /model Post \{[\s\S]*commissioningState\s+String\s+@default\("uncommissioned"\)/,
    );
    expect(schema).toMatch(/agentCompatibility\s+String\s+@default\("unknown"\)/);
    expect(schema).toMatch(/agentProtocolVersion\s+Int\?/);
    expect(schema).toMatch(/agentCapabilities\s+Json\?/);
    expect(schema).toMatch(/model DeviceRuntime \{[\s\S]*configFingerprint\s+String\?/);
    expect(schema).toMatch(/lastProbeAt\s+DateTime\?/);
    expect(schema).not.toMatch(/operationalState\s+String/);
  });

  it('backfills every existing post conservatively and constrains lifecycle values', () => {
    expect(existsSync(migration)).toBe(true);
    if (!existsSync(migration)) return;

    const sql = readFileSync(migration, 'utf8');
    expect(sql).toContain(`"commissioningState" TEXT NOT NULL DEFAULT 'uncommissioned'`);
    expect(sql).toContain(`"agentCompatibility" TEXT NOT NULL DEFAULT 'unknown'`);
    expect(sql).toContain('posts_commissioning_state_check');
    expect(sql).toContain('posts_agent_compatibility_check');
    expect(sql).not.toMatch(
      /UPDATE\s+"posts"[\s\S]*SET\s+"commissioningState"\s*=\s*'commissioned'/i,
    );
  });
});
