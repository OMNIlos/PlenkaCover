import { DECORATORS } from '@nestjs/swagger';
import {
  AdminAccessEventResponseDto,
  AdminAuditSystemActorResponseDto,
  AdminAuditUserActorResponseDto,
} from './dto/admin-response.dto';
import { AdminAuditProjectionService } from './admin-audit-projection.service';

describe('AdminAuditProjectionService', () => {
  it('documents the nullable legacy role and discriminated safe actor union', () => {
    const actorRole = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      AdminAccessEventResponseDto.prototype,
      'actorRole',
    );
    const actor = Reflect.getMetadata(
      DECORATORS.API_MODEL_PROPERTIES,
      AdminAccessEventResponseDto.prototype,
      'actor',
    );
    const userFields = (
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        AdminAuditUserActorResponseDto.prototype,
      ) ?? []
    ).map((field: string) => field.slice(1));
    const systemFields = (
      Reflect.getMetadata(
        DECORATORS.API_MODEL_PROPERTIES_ARRAY,
        AdminAuditSystemActorResponseDto.prototype,
      ) ?? []
    ).map((field: string) => field.slice(1));

    expect(actorRole?.nullable).toBe(true);
    expect(actor?.discriminator).toEqual({ propertyName: 'kind' });
    expect(actor?.oneOf).toHaveLength(2);
    expect(userFields).toEqual(['kind', 'role', 'userId']);
    expect(systemFields).toEqual(['kind', 'key', 'label']);
  });

  it('returns only account/access events and never secret fields', async () => {
    const event = {
      id: 'e1',
      type: 'admin.user.password_reset',
      objectId: 'u1',
      actorKind: 'user',
      actorId: 'a1',
      actorRole: 'admin',
      systemActorKey: null,
      label: null,
      oldValue: null,
      newValue: { mustChangePassword: true },
      reason: 'Reset requested',
      createdAt: new Date(),
    };
    const prisma = {
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([event]),
        count: jest.fn().mockResolvedValue(1),
      },
    };
    const service = new AdminAuditProjectionService(prisma as never);
    const result = await service.list({ targetUserId: 'u1', page: 1, pageSize: 50 });
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|tokenHash|temporaryPassword/);
    const { actorKind: _actorKind, systemActorKey: _systemActorKey, ...safeEvent } = event;
    expect(result.items).toEqual([
      { ...safeEvent, actor: { kind: 'user', role: 'admin', userId: 'a1' } },
    ]);
    const query = prisma.domainEvent.findMany.mock.calls[0][0];
    expect(query.select.detail).toBeUndefined();
    expect(query.select.actorKind).toBe(true);
    expect(query.select.systemActorKey).toBe(true);
    expect(query.where.objectId).toBe('u1');
    expect(query.where.type.in).not.toContain('audit:auth_login_failed');
  });

  it('projects a system event without fabricating an admin role or user', async () => {
    const event = {
      id: 'e-system',
      type: 'admin.user.access_updated',
      objectId: 'u1',
      actorKind: 'system',
      actorId: null,
      actorRole: null,
      systemActorKey: 'warehouse_coverage_engine',
      label: 'Automated coverage maintenance',
      oldValue: null,
      newValue: null,
      reason: null,
      createdAt: new Date(),
    };
    const prisma = {
      domainEvent: {
        findMany: jest.fn().mockResolvedValue([event]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const service = new AdminAuditProjectionService(prisma as never);
    const result = await service.list({ page: 1, pageSize: 50 });

    const { actorKind: _actorKind, systemActorKey: _systemActorKey, ...safeEvent } = event;
    expect(result.items[0]).toEqual({
      ...safeEvent,
      actor: {
        kind: 'system',
        key: 'warehouse_coverage_engine',
        label: 'Система',
      },
    });
    expect(result.items[0]?.actorRole).toBeNull();
    expect(result.items[0]?.actorId).toBeNull();
    expect(result.items[0]).not.toHaveProperty('actorKind');
    expect(result.items[0]).not.toHaveProperty('systemActorKey');
  });
});
