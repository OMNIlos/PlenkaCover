import { BadRequestException } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';

describe('AccessPolicyService', () => {
  const service = new AccessPolicyService();

  it('computes base + allow - deny in canonical order', () => {
    const capabilities = service.resolve('operator', [
      { capability: 'finance_order:read', effect: 'allow' },
      { capability: 'operator_task:read', effect: 'deny' },
    ]);

    expect(capabilities).toEqual(expect.arrayContaining(['roll:weigh', 'finance_order:read']));
    expect(capabilities).not.toContain('operator_task:read');
  });

  it('ignores corrupt privileged grants while resolving stored data', () => {
    expect(
      service.resolve('operator', [
        { capability: 'admin:users', effect: 'allow' },
        { capability: 'override:finance', effect: 'allow' },
        { capability: 'not:real', effect: 'allow' },
      ]),
    ).not.toEqual(expect.arrayContaining(['admin:users', 'override:finance', 'not:real']));
  });

  it('rejects unknown, admin and director override grants', () => {
    expect(() => service.validate('operator', ['admin:users'], [])).toThrow(BadRequestException);
    expect(() => service.validate('operator', ['override:finance'], [])).toThrow(
      BadRequestException,
    );
    expect(() => service.validate('operator', ['pallet_label_layout:manage'], [])).toThrow(
      BadRequestException,
    );
    expect(() => service.validate('operator', ['not:real'], [])).toThrow(BadRequestException);
  });

  it('rejects business grants for admin accounts', () => {
    expect(() => service.validate('admin', ['finance_order:read'], [])).toThrow(
      BadRequestException,
    );
  });

  it('rejects overlap and meaningless denials', () => {
    expect(() =>
      service.validate('operator', ['finance_order:read'], ['finance_order:read']),
    ).toThrow(BadRequestException);
    expect(() => service.validate('operator', [], ['finance_order:read'])).toThrow(
      BadRequestException,
    );
  });
});
