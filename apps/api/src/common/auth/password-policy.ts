import { randomBytes } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';

const LOGIN_SEGMENT = '[a-zа-яё0-9._@+-]+';
const LOGIN_PATTERN = new RegExp(`^(?=.{3,128}$)${LOGIN_SEGMENT}(?: ${LOGIN_SEGMENT})*$`, 'u');

function canonicalizeLoginText(value: string): string {
  return value.replace(/\p{White_Space}+/gu, ' ').trim().toLocaleLowerCase('ru-RU');
}

export function normalizeLogin(value: string): string {
  const login = canonicalizeLoginText(value);
  if (!LOGIN_PATTERN.test(login)) {
    throw new BadRequestException({
      code: 'ADMIN_ACCESS_INVALID',
      message:
        'Login must be 3-128 Latin/Cyrillic email-safe characters with single spaces between words.',
    });
  }
  return login;
}

export function generateTemporaryPassword(): string {
  return randomBytes(18).toString('base64url');
}

export function assertPasswordPolicy(password: string, login: string, previous?: string): void {
  if (
    password.length < 4 ||
    password.length > 128 ||
    canonicalizeLoginText(password) === normalizeLogin(login) ||
    password === previous
  ) {
    throw new BadRequestException({
      code: 'AUTH_PASSWORD_POLICY',
      message: 'Password must be 4-128 characters and differ from login and current password.',
    });
  }
}

export function assertPilotPassword(password: string, enabled: boolean): void {
  if (!enabled || !/^[0-9]{4}$/.test(password)) {
    throw new BadRequestException({
      code: 'AUTH_PILOT_PIN_POLICY',
      message: 'Pilot PIN requires the explicit pilot exception and exactly four digits.',
    });
  }
}
