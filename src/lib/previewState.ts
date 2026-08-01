// tiny pub/sub for the side-panel preview's currently-open item - same "state + CustomEvent
// on window" shape as lib/path.ts's pathUpdate event. Explorer.astro sets/clears this on
// click (panel preview mode) and close; PreviewPanel.astro is the sole reader/renderer.

import type { TFileEntry } from "./mediaUrls";

export type TPreviewItem = {
  currentPath: string[];
  files: TFileEntry[];
  index: number;
};

let current: TPreviewItem | null = null;

export const getPreviewItem = (): TPreviewItem | null => current;

export const openPreview = (item: TPreviewItem) => {
  current = item;
  window.dispatchEvent(new CustomEvent("previewChange"));
};

// used by the panel's prev/next controls - keeps currentPath/files, just moves the index
export const stepPreview = (delta: number) => {
  if (!current) return;
  const index = current.index + delta;
  if (index < 0 || index >= current.files.length) return;
  current = { ...current, index };
  window.dispatchEvent(new CustomEvent("previewChange"));
};

export const closePreview = () => {
  if (!current) return;
  current = null;
  window.dispatchEvent(new CustomEvent("previewChange"));
};
