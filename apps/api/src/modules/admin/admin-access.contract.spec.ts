import {
  ACCOUNT_STATUSES,
  CAPABILITY_OVERRIDE_EFFECTS,
  DOMAIN_EVENTS,
  SESSION_PURPOSES,
} from '@plenka/contracts';
import { ADMIN_CAPABILITY_METADATA } from './admin-capability-catalog';

describe('admin access contracts', () => {
  it('exports stable account/access vocabulary', () => {
    expect(ACCOUNT_STATUSES).toEqual(['active', 'password_setup', 'blocked']);
    expect(SESSION_PURPOSES).toEqual(['full', 'password_setup']);
    expect(CAPABILITY_OVERRIDE_EFFECTS).toEqual(['allow', 'deny']);
  });

  it('exports every A1 audit event', () => {
    expect(DOMAIN_EVENTS).toEqual(
      expect.arrayContaining([
        'admin.user.created',
        'admin.user.profile_updated',
        'admin.user.blocked',
        'admin.user.reactivated',
        'admin.user.password_reset',
        'admin.user.access_updated',
        'admin.access_template.created',
        'audit:password_changed',
      ]),
    );
  });

  it('documents every Big-Bag lifecycle capability for the access editor', () => {
    expect(ADMIN_CAPABILITY_METADATA['bigbag:print']).toMatchObject({
      group: 'Склад',
    });
    expect(ADMIN_CAPABILITY_METADATA['bigbag:move']).toMatchObject({
      group: 'Склад',
    });
  });

  it('documents read-only roll inventory separately from warehouse tasks', () => {
    expect(ADMIN_CAPABILITY_METADATA['warehouse_inventory:read']).toMatchObject({
      label: expect.stringMatching(/[А-Яа-яЁё]/),
      group: 'Склад',
    });
  });
});
