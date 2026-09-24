export async function reloadWhenReleaseChanges(
  currentEntry: string | null | undefined,
  loadShell: () => Promise<string> = async () => {
    const response = await fetch('/', { cache: 'no-store' });
    return response.ok ? response.text() : '';
  },
  reload: () => void = () => window.location.reload(),
) {
  if (!currentEntry) return;
  try {
    const shell = await loadShell();
    if (shell.includes('type="module"') && !shell.includes(currentEntry)) reload();
  } catch {
    // An offline workstation keeps the current release and retries on the next focus.
  }
}
