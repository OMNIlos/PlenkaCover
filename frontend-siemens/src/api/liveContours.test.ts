import { describe, expect, it } from 'vitest';
import {
  parseLiveContours,
  resolveConfiguredLiveContours,
  resolveLiveContours,
} from './liveContours';

describe('parseLiveContours', () => {
  it('пусто/undefined → пустой набор', () => {
    expect(parseLiveContours(undefined).size).toBe(0);
    expect(parseLiveContours('').size).toBe(0);
  });

  it('парсит список с пробелами и отбрасывает мусор', () => {
    const set = parseLiveContours(' commercial, production ,nope,operator');
    expect(set.has('commercial')).toBe(true);
    expect(set.has('production')).toBe(true);
    expect(set.has('operator')).toBe(true);
    expect(set.size).toBe(3);
  });
});

describe('resolveLiveContours', () => {
  it('включает production вместе с live commercial, чтобы handoff не попадал в demo-dashboard', () => {
    const set = resolveLiveContours('commercial,finance');

    expect(set.has('commercial')).toBe(true);
    expect(set.has('production')).toBe(true);
    expect(set.has('finance')).toBe(true);
  });

  it('не включает live-контуры для пустой demo-конфигурации', () => {
    expect(resolveLiveContours(undefined).size).toBe(0);
  });
});

describe('resolveConfiguredLiveContours', () => {
  it('enables every server-backed role when the production image has no override', () => {
    expect([...resolveConfiguredLiveContours(undefined, true)].sort()).toEqual(
      ['admin', 'commercial', 'director', 'finance', 'operator', 'production', 'warehouse'].sort(),
    );
  });

  it('keeps an explicit contour list authoritative', () => {
    expect([...resolveConfiguredLiveContours('operator,warehouse', true)].sort()).toEqual([
      'operator',
      'warehouse',
    ]);
  });
});
