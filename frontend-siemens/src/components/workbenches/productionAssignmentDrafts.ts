export type DirtyStringDraft = {
  value: string;
  dirty: boolean;
  accepted?: {
    value: string;
    serverValue: string;
  };
};

export type DirtyStringDrafts = Record<string, DirtyStringDraft>;

/**
 * Reconciles server values without erasing an in-flight user choice.
 * Once the server echoes that choice, the draft becomes clean and follows later updates again.
 */
export function reconcileDirtyStringDrafts(
  current: DirtyStringDrafts,
  serverValues: Record<string, string>,
): DirtyStringDrafts {
  return Object.fromEntries(
    Object.entries(serverValues).map(([id, serverValue]) => {
      const draft = current[id];
      if (draft?.accepted) {
        if (serverValue === draft.accepted.value) {
          return [id, { value: serverValue, dirty: false }];
        }
        if (serverValue !== draft.accepted.serverValue) {
          return [id, { value: serverValue, dirty: false }];
        }
        return [id, draft];
      }
      if (draft?.dirty && draft.value !== serverValue) return [id, draft];
      return [id, { value: serverValue, dirty: false }];
    }),
  );
}

export function setDirtyStringDraft(
  current: DirtyStringDrafts,
  id: string,
  value: string,
): DirtyStringDrafts {
  const accepted = current[id]?.accepted;
  return { ...current, [id]: { value, dirty: true, ...(accepted ? { accepted } : {}) } };
}

export function resetDirtyStringDraft(
  current: DirtyStringDrafts,
  id: string,
  value: string,
): DirtyStringDrafts {
  const accepted = current[id]?.accepted;
  if (accepted && value === accepted.serverValue) {
    return { ...current, [id]: { value: accepted.value, dirty: true, accepted } };
  }
  return { ...current, [id]: { value, dirty: false } };
}

export function settleDirtyStringMutation(
  current: DirtyStringDrafts,
  id: string,
  accepted: boolean,
  serverValue: string,
): DirtyStringDrafts {
  if (!accepted) return resetDirtyStringDraft(current, id, serverValue);
  const draft = current[id];
  if (!draft) return current;
  if (draft.value === serverValue) {
    return { ...current, [id]: { value: serverValue, dirty: false } };
  }
  return {
    ...current,
    [id]: {
      value: draft.value,
      dirty: true,
      accepted: { value: draft.value, serverValue },
    },
  };
}

export function dirtyStringDraftValue(drafts: DirtyStringDrafts, id: string, fallback: string) {
  return drafts[id]?.value ?? fallback;
}

export function dirtyStringDraftBaselineValue(
  drafts: DirtyStringDrafts,
  id: string,
  fallback: string,
) {
  return drafts[id]?.accepted?.value ?? fallback;
}
