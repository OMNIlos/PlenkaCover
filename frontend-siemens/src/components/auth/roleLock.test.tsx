import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DemoRoleSwitcherGate, resolveInitialRole } from './roleLock';

describe('initial authenticated role', () => {
  it('keeps the verified role when the URL requests admin', () => {
    expect(
      resolveInitialRole({
        authRequired: true,
        verifiedRole: 'warehouse',
        search: '?role=admin',
      }),
    ).toBe('warehouse');
  });

  it('ignores role queries when authentication is required without a verified role', () => {
    expect(
      resolveInitialRole({ authRequired: true, verifiedRole: null, search: '?role=admin' }),
    ).toBe('commercial');
  });

  it('allows the role query only in the explicit development demo', () => {
    expect(
      resolveInitialRole({ authRequired: false, verifiedRole: null, search: '?role=admin' }),
    ).toBe('admin');
  });
});

describe('production role switcher lock', () => {
  const switcher = <div className="demo-role-switcher">Role switcher</div>;

  it('emits no demo role-switcher markup when authentication is required', () => {
    const html = renderToStaticMarkup(
      <DemoRoleSwitcherGate authRequired>{switcher}</DemoRoleSwitcherGate>,
    );

    expect(html).not.toContain('demo-role-switcher');
    expect(html).toBe('');
  });

  it('retains the switcher only for the explicit unauthenticated demo', () => {
    const html = renderToStaticMarkup(
      <DemoRoleSwitcherGate authRequired={false}>{switcher}</DemoRoleSwitcherGate>,
    );

    expect(html).toContain('demo-role-switcher');
  });
});
