// shared by the grid (Explorer.astro), the preview panel (PreviewPanel.astro), the player and lib/meta.ts

export const humanSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
};

export const humanDate = (mtime: number): string =>
  new Date(mtime).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export const formatTime = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const s = Math.floor(secs % 60);
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
};
