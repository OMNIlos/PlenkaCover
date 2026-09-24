import { BadRequestException } from '@nestjs/common';
import {
  assertPasswordPolicy,
  assertPilotPassword,
  generateTemporaryPassword,
  normalizeLogin,
} from './password-policy';

describe('password policy', () => {
  it('normalizes supported logins', () => {
    expect(normalizeLogin(' Admin.User@Example.COM ')).toBe('admin.user@example.com');
  });

  it('normalizes Russian logins used by pilot accounts', () => {
    expect(normalizeLogin(' ОПЕРАТОР2 ')).toBe('оператор2');
    expect(normalizeLogin('Бухгалтерия')).toBe('бухгалтерия');
  });

  it.each([
    ['Ахметов Булат', 'ахметов булат'],
    ['  ХАБИБУЛИН   РУСЛАН  ', 'хабибулин руслан'],
    ['Гайнулин\tИльназ', 'гайнулин ильназ'],
  ])('canonicalizes a spaced Cyrillic login', (input, expected) => {
    expect(normalizeLogin(input)).toBe(expected);
  });

  it.each([
    ['Ахметов\u0085Булат', 'ахметов булат'],
    ['\u0085Ахметов Булат\u0085', 'ахметов булат'],
  ])('canonicalizes Unicode White_Space in a login', (input, expected) => {
    expect(normalizeLogin(input)).toBe(expected);
  });

  it.each(['аб', 'ахметов / булат', 'ахметов  булат!', 'a'.repeat(129)])(
    'rejects an invalid canonical login: %s',
    (input) => {
      expect(() => normalizeLogin(input)).toThrow(BadRequestException);
    },
  );

  it.each([
    ['abc', 'abc'],
    [`  ${'a'.repeat(128)}  `, 'a'.repeat(128)],
  ])('preserves the canonical login length boundary', (input, expected) => {
    expect(normalizeLogin(input)).toBe(expected);
  });

  it('generates non-repeating strong temporary passwords', () => {
    const first = generateTemporaryPassword();
    const second = generateTemporaryPassword();
    expect(first).toHaveLength(24);
    expect(second).not.toBe(first);
  });

  it('accepts four characters and rejects three characters', () => {
    expect(() => assertPasswordPolicy('1234', 'operator')).not.toThrow();
    expect(() => assertPasswordPolicy('123', 'operator')).toThrow(BadRequestException);
  });

  it('rejects login-equal and unchanged passwords', () => {
    expect(() => assertPasswordPolicy('operator', 'operator')).toThrow(BadRequestException);
    expect(() =>
      assertPasswordPolicy('correct horse battery', 'operator', 'correct horse battery'),
    ).toThrow(BadRequestException);
  });

  it('rejects a password equal to the canonical login', () => {
    expect(() => assertPasswordPolicy('  АХМЕТОВ   БУЛАТ  ', 'ахметов булат')).toThrow(
      BadRequestException,
    );
    expect(() => assertPasswordPolicy('\u0085АХМЕТОВ\u0085БУЛАТ\u0085', 'ахметов булат')).toThrow(
      BadRequestException,
    );
  });

  it('accepts exactly four digits only for the explicit pilot exception', () => {
    expect(() => assertPilotPassword('1234', false)).toThrow(BadRequestException);
    expect(() => assertPilotPassword('1234', true)).not.toThrow();
  });

  it.each(['123', '12345', '12a4', '１２３４', ' 1234 '])(
    'rejects a malformed pilot PIN without normalizing it (%s)',
    (pin) => {
      expect(() => assertPilotPassword(pin, true)).toThrow(BadRequestException);
    },
  );
});
