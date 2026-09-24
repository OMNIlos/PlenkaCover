import { describe, expect, it } from 'vitest';

import {
  reconcileDirtyStringDrafts,
  resetDirtyStringDraft,
  setDirtyStringDraft,
  settleDirtyStringMutation,
} from './productionAssignmentDrafts';

describe('production assignment draft reconciliation', () => {
  it('keeps a dirty choice while polling still returns the previous server value', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');

    expect(reconcileDirtyStringDrafts(dirty, { 'roll-a9': '' })).toEqual({
      'roll-a9': { value: 'operator-b', dirty: true },
    });
  });

  it('marks a confirmed choice clean and follows the next authoritative update', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');
    const confirmed = reconcileDirtyStringDrafts(dirty, { 'roll-a9': 'operator-b' });

    expect(confirmed).toEqual({ 'roll-a9': { value: 'operator-b', dirty: false } });
    expect(reconcileDirtyStringDrafts(confirmed, { 'roll-a9': 'operator-c' })).toEqual({
      'roll-a9': { value: 'operator-c', dirty: false },
    });
  });

  it('drops drafts for rows that disappeared from the server response', () => {
    const current = {
      'roll-a9': { value: 'operator-b', dirty: true },
      removed: { value: 'operator-c', dirty: true },
    };

    expect(reconcileDirtyStringDrafts(current, { 'roll-a9': '' })).not.toHaveProperty('removed');
  });

  it('restores the authoritative value after an immediate mutation is rejected', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');

    expect(settleDirtyStringMutation(dirty, 'roll-a9', false, 'operator-c')).toEqual({
      'roll-a9': { value: 'operator-c', dirty: false },
    });
  });

  it('keeps an accepted optimistic choice while the server prop is still the pre-commit value', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');
    const accepted = settleDirtyStringMutation(dirty, 'roll-a9', true, '');

    expect(resetDirtyStringDraft(accepted, 'roll-a9', '')).toEqual({
      'roll-a9': {
        value: 'operator-b',
        dirty: true,
        accepted: { value: 'operator-b', serverValue: '' },
      },
    });
  });

  it('lets a newer server value supersede an accepted optimistic choice', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');
    const accepted = settleDirtyStringMutation(dirty, 'roll-a9', true, '');

    expect(reconcileDirtyStringDrafts(accepted, { 'roll-a9': 'operator-c' })).toEqual({
      'roll-a9': { value: 'operator-c', dirty: false },
    });
  });

  it('cleans an accepted choice immediately when the latest server value already matches it', () => {
    const dirty = setDirtyStringDraft({}, 'roll-a9', 'operator-b');

    expect(settleDirtyStringMutation(dirty, 'roll-a9', true, 'operator-b')).toEqual({
      'roll-a9': { value: 'operator-b', dirty: false },
    });
  });
});
