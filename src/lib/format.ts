// shared by the grid (Explorer.astro) and the preview panel (PreviewPanel.astro)

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
