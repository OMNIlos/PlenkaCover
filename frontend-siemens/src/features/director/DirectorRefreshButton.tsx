export function DirectorRefreshButton({
  busy,
  onRefresh,
}: {
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      className="director-refresh-button"
      type="button"
      aria-label="Обновить данные вкладки"
      aria-busy={busy}
      disabled={busy}
      onClick={() => {
        if (!busy) onRefresh();
      }}
    >
      Обновить
    </button>
  );
}
