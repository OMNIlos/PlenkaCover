export type CommitThenRefreshResult =
  | { committed: false; refreshed: false; error: unknown }
  | { committed: true; refreshed: false; error: unknown }
  | { committed: true; refreshed: true };

export async function commitThenRefresh(
  commit: () => Promise<unknown>,
  refresh: () => Promise<unknown>,
  afterCommit?: () => void,
): Promise<CommitThenRefreshResult> {
  try {
    await commit();
  } catch (error) {
    return { committed: false, refreshed: false, error };
  }

  afterCommit?.();

  try {
    await refresh();
    return { committed: true, refreshed: true };
  } catch (error) {
    return { committed: true, refreshed: false, error };
  }
}
