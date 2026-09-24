import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  PasswordChangeScreen,
  createPasswordChangeSubmitter,
  validatePasswordChange,
} from './PasswordChangeScreen';

describe('PasswordChangeScreen', () => {
  it('renders only new-password and confirmation inputs in setup mode', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen onSuccess={() => undefined} />);

    expect(html).toContain('Новый пароль');
    expect(html).toContain('Повторите пароль');
    expect(html).toContain('От 4 до 128 символов.');
    expect(html.match(/minLength="4"/g)).toHaveLength(2);
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
    expect(html).not.toContain('current-password');
    expect(html).not.toContain('Текущий пароль');
  });

  it('keeps the submit action disabled until valid values exist', () => {
    const html = renderToStaticMarkup(<PasswordChangeScreen onSuccess={() => undefined} />);

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сменить пароль<\/button>/);
  });
});

describe('password setup validation', () => {
  it.each([
    ['short value', '482', '482'],
    ['long value', 'x'.repeat(129), 'x'.repeat(129)],
    ['mismatch', 'valid-password-123', 'different-password-123'],
  ])('rejects %s before the request', (_case, password, confirmation) => {
    expect(validatePasswordChange(password, confirmation)).not.toBeNull();
  });

  it('accepts matching values between 4 and 128 characters', () => {
    expect(validatePasswordChange('4826', '4826')).toBeNull();
  });
});

describe('password setup submission', () => {
  it('single-flights repeated submissions', async () => {
    let resolveChange!: () => void;
    const change = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChange = resolve;
        }),
    );
    const submit = createPasswordChangeSubmitter(change);

    const first = submit('4826', '4826');
    await expect(submit('4826', '4826')).resolves.toEqual({
      status: 'ignored',
    });
    expect(change).toHaveBeenCalledOnce();

    resolveChange();
    await expect(first).resolves.toEqual({ status: 'success' });
  });

  it('returns a sanitized error without reflecting backend details', async () => {
    const submit = createPasswordChangeSubmitter(async () => {
      throw new Error('rejected value super-secret-password');
    });

    const result = await submit('valid-password-123', 'valid-password-123');

    expect(result).toMatchObject({ status: 'error' });
    expect(JSON.stringify(result)).not.toContain('super-secret-password');
  });

  it('does not call the API for mismatched values', async () => {
    const change = vi.fn(async () => undefined);
    const submit = createPasswordChangeSubmitter(change);

    await expect(submit('valid-password-123', 'different-password')).resolves.toMatchObject({
      status: 'error',
    });
    expect(change).not.toHaveBeenCalled();
  });
});
