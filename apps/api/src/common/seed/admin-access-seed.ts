import { ROLES, type Role } from '@plenka/contracts';
import type { Prisma } from '@prisma/client';

type AccessTemplateClient = Pick<Prisma.TransactionClient, 'accessTemplate'>;

const ROLE_NAMES: Record<Role, string> = {
  commercial: 'Коммерция',
  production_lead: 'Заведующий производством',
  operator: 'Оператор',
  warehouse: 'Склад',
  finance: 'Финансы',
  director: 'Директор',
  admin: 'Администратор платформы',
};

export async function seedSystemAccessTemplates(
  prisma: AccessTemplateClient,
  options: { createOnly?: boolean } = {},
): Promise<void> {
  for (const role of ROLES) {
    const canonical = {
      name: ROLE_NAMES[role],
      role,
      setupStatus: 'active',
      assignments: [],
      capabilityGrants: [],
      capabilityDenials: [],
      version: 1,
      isSystem: true,
    };
    await prisma.accessTemplate.upsert({
      where: { id: `tpl-${role}` },
      update: options.createOnly ? {} : canonical,
      create: { id: `tpl-${role}`, ...canonical },
    });
  }
}
