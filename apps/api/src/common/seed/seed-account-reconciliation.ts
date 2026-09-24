import { Role, type Prisma, type User } from '@prisma/client';
import { hashPassword, verifyPassword } from '../auth/password';

export type SeedAccountManifestEntry<PasswordKey extends string> = {
  externalId: string;
  login: string;
  displayName: string;
  role: Role;
  passwordKey: PasswordKey;
};

export class SeedAccountConflictError extends Error {
  constructor(message: string) {
    super(`Seed account conflict: ${message}`);
    this.name = 'SeedAccountConflictError';
  }
}

interface ReconciliationOptions<PasswordKey extends string> {
  accounts: readonly SeedAccountManifestEntry<PasswordKey>[];
  retiredExternalIds: readonly string[];
  passwordFor: (passwordKey: PasswordKey) => string;
  conflict: (message: string) => Error;
}

interface ResolvedAccount<PasswordKey extends string> {
  account: SeedAccountManifestEntry<PasswordKey>;
  existing: User | null;
  password: string;
}

function validateManifest<PasswordKey extends string>(
  options: ReconciliationOptions<PasswordKey>,
): void {
  const activeLogins = new Set<string>();
  const activeExternalIds = new Set<string>();

  for (const account of options.accounts) {
    if (activeLogins.has(account.login)) {
      throw options.conflict(`duplicate active login: ${account.login}`);
    }
    if (activeExternalIds.has(account.externalId)) {
      throw options.conflict(`duplicate active external ID: ${account.externalId}`);
    }
    activeLogins.add(account.login);
    activeExternalIds.add(account.externalId);
  }

  const retiredExternalIds = new Set<string>();
  for (const externalId of options.retiredExternalIds) {
    if (retiredExternalIds.has(externalId)) {
      throw options.conflict(`duplicate retired external ID: ${externalId}`);
    }
    if (activeExternalIds.has(externalId)) {
      throw options.conflict(`active and retired external ID overlap: ${externalId}`);
    }
    retiredExternalIds.add(externalId);
  }
}

async function resolveActiveAccounts<PasswordKey extends string>(
  prisma: Pick<Prisma.TransactionClient, 'user' | 'session'>,
  options: ReconciliationOptions<PasswordKey>,
): Promise<ResolvedAccount<PasswordKey>[]> {
  return Promise.all(
    options.accounts.map(async (account) => {
      const [byLogin, byExternalId] = await Promise.all([
        prisma.user.findUnique({ where: { login: account.login } }),
        prisma.user.findUnique({ where: { externalId: account.externalId } }),
      ]);
      if (byLogin && byExternalId && byLogin.id !== byExternalId.id) {
        throw options.conflict(`account identity mismatch for ${account.login}`);
      }

      const existing = byLogin ?? byExternalId;
      if (
        existing &&
        (existing.identityProvider !== 'local' ||
          existing.role !== account.role ||
          (existing.externalId !== null && existing.externalId !== account.externalId))
      ) {
        throw options.conflict(`account metadata mismatch for ${account.login}`);
      }

      return {
        account,
        existing,
        password: options.passwordFor(account.passwordKey),
      };
    }),
  );
}

async function reconcileActiveAccount<PasswordKey extends string>(
  prisma: Pick<Prisma.TransactionClient, 'user' | 'session'>,
  resolved: ResolvedAccount<PasswordKey>,
): Promise<void> {
  const { account, existing, password } = resolved;
  if (!existing) {
    await prisma.user.create({
      data: {
        externalId: account.externalId,
        login: account.login,
        passwordHash: hashPassword(password),
        identityProvider: 'local',
        displayName: account.displayName,
        role: account.role,
        isActive: true,
        mustChangePassword: false,
      },
    });
    return;
  }

  const update: Prisma.UserUpdateInput = {};
  const loginChanged = existing.login !== account.login;
  const activeStateChanged = !existing.isActive;
  const passwordMatches =
    existing.passwordHash !== null && verifyPassword(password, existing.passwordHash);

  if (loginChanged) update.login = account.login;
  if (existing.displayName !== account.displayName) update.displayName = account.displayName;
  if (existing.externalId === null) update.externalId = account.externalId;
  if (activeStateChanged) update.isActive = true;
  if (!passwordMatches) {
    update.passwordHash = hashPassword(password);
    update.passwordChangedAt = new Date();
  }
  if (existing.mustChangePassword) update.mustChangePassword = false;

  if (Object.keys(update).length > 0) {
    await prisma.user.update({ where: { id: existing.id }, data: update });
  }
  if (loginChanged || activeStateChanged || !passwordMatches) {
    await prisma.session.updateMany({
      where: { userId: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export async function reconcileSeedAccounts<PasswordKey extends string>(
  prisma: Pick<Prisma.TransactionClient, 'user' | 'session'>,
  options: ReconciliationOptions<PasswordKey>,
): Promise<void> {
  validateManifest(options);
  const [activeAccounts, retiredAccounts] = await Promise.all([
    resolveActiveAccounts(prisma, options),
    Promise.all(
      options.retiredExternalIds.map((externalId) =>
        prisma.user.findUnique({ where: { externalId } }),
      ),
    ),
  ]);

  for (const account of activeAccounts) {
    await reconcileActiveAccount(prisma, account);
  }

  for (const retired of retiredAccounts) {
    if (!retired) continue;
    if (retired.isActive) {
      await prisma.user.update({
        where: { id: retired.id },
        data: { isActive: false },
      });
    }
    await prisma.session.updateMany({
      where: { userId: retired.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
