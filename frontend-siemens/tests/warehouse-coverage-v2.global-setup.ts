import type { FullConfig } from 'playwright/test';

type FrontendRole = 'commercial' | 'finance' | 'production' | 'warehouse';

const roles = ['commercial', 'finance', 'production', 'warehouse'] as const;
const loginByRole = {
  commercial: 'коммерция',
  finance: 'бухгалтерия',
  production: 'производство',
  warehouse: 'склад',
} satisfies Record<FrontendRole, string>;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the Coverage V2 acceptance setup.`);
  return value;
}

async function createSessions(apiPort: string, password: string) {
  const sessions: Partial<Record<FrontendRole, unknown>> = {};
  for (const role of roles) {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: loginByRole[role], password }),
    });
    if (!response.ok) {
      throw new Error(
        `Acceptance login for ${role} on API port ${apiPort} failed with ` +
          `${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      expiresAt?: unknown;
      passwordChangeRequired?: unknown;
      token?: unknown;
      user?: { displayName?: unknown; id?: unknown; role?: unknown };
    };
    if (
      typeof body.token !== 'string' ||
      typeof body.expiresAt !== 'string' ||
      typeof body.user?.id !== 'string' ||
      typeof body.user.role !== 'string'
    ) {
      throw new Error(`Acceptance login for ${role} returned an invalid session.`);
    }
    sessions[role] = {
      version: 1,
      token: body.token,
      role,
      serverRole: body.user.role,
      userId: body.user.id,
      displayName:
        typeof body.user.displayName === 'string' ? body.user.displayName : null,
      expiresAt: body.expiresAt,
      passwordChangeRequired: body.passwordChangeRequired === true,
    };
  }
  return sessions;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const password = requiredEnvironment('COVERAGE_V2_ACCEPTANCE_PASSWORD');
  const portByProject = {
    'coverage-v2-1024x768': requiredEnvironment('COVERAGE_V2_API_PORT_1024'),
    'coverage-v2-1440x900': requiredEnvironment('COVERAGE_V2_API_PORT_1440'),
  };
  const configuredProjects = new Set(config.projects.map((project) => project.name));
  for (const projectName of Object.keys(portByProject)) {
    if (!configuredProjects.has(projectName)) {
      throw new Error(`Coverage V2 acceptance project is missing: ${projectName}.`);
    }
  }

  const sessions = Object.fromEntries(
    await Promise.all(
      Object.entries(portByProject).map(async ([projectName, apiPort]) => [
        projectName,
        await createSessions(apiPort, password),
      ]),
    ),
  );
  process.env.COVERAGE_V2_ACCEPTANCE_SESSIONS = JSON.stringify(sessions);
}
