import { UnauthorizedException } from '@nestjs/common';
import { capabilitiesForRole } from '@plenka/contracts';
import { AdminController } from './admin.controller';

const actor = {
  userId: 'admin-1',
  role: 'admin' as const,
  capabilities: capabilitiesForRole('admin'),
};
const createDto = { login: 'operator.2', displayName: 'Operator 2', role: 'operator' as const };

function setup() {
  const technical = {};
  const accounts = {
    create: jest.fn().mockResolvedValue({ temporaryPassword: 'temporary-password-12' }),
    resetPassword: jest.fn().mockResolvedValue({ temporaryPassword: 'temporary-password-34' }),
  };
  const access = {
    listCapabilities: jest.fn().mockResolvedValue([
      {
        key: 'roll:weigh',
        label: 'Взвешивание рулона',
        description: 'Фиксировать вес рулона по подтвержденным данным весов.',
        group: 'Оператор',
        baseRoles: ['operator'],
        grantable: true,
      },
    ]),
  };
  const audit = {};
  const controller = new AdminController(
    technical as never,
    accounts as never,
    access as never,
    audit as never,
  );
  return { controller, accounts, access };
}

describe('AdminController accounts', () => {
  it('marks created temporary credentials as no-store', async () => {
    const { controller, accounts } = setup();
    const response = { setHeader: jest.fn() };
    await controller.createUser(actor, createDto, response as never);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(accounts.create).toHaveBeenCalledWith(actor, createDto);
  });

  it('marks reset temporary credentials as no-store', async () => {
    const { controller, accounts } = setup();
    const response = { setHeader: jest.fn() };
    await controller.resetUserPassword(
      actor,
      'u1',
      { reason: 'Credential recovery' },
      response as never,
    );
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(accounts.resetPassword).toHaveBeenCalledWith(actor, 'u1', 'Credential recovery');
  });

  it('rejects mutating requests without an actor', async () => {
    const { controller } = setup();
    await expect(
      controller.createUser(undefined, createDto, { setHeader: jest.fn() } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the current administrator capability catalog from the access service', async () => {
    const { controller, access } = setup();

    await expect(controller.capabilities(actor)).resolves.toEqual([
      expect.objectContaining({ key: 'roll:weigh', grantable: true }),
    ]);
    expect(access.listCapabilities).toHaveBeenCalledWith(actor);
  });

  it('rejects a capability catalog request without an authenticated actor', () => {
    const { controller, access } = setup();

    expect(() => controller.capabilities(undefined)).toThrow(UnauthorizedException);
    expect(access.listCapabilities).not.toHaveBeenCalled();
  });
});
