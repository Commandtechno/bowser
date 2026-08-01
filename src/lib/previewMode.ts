// how clicking a file preview opens: fancybox lightbox (default) or the side panel - see
// SettingsDialog.astro (picker), api/me.ts (validation), Explorer.astro (behavior)
export const PREVIEW_MODES: { id: string; label: string }[] = [
  { id: "lightbox", label: "lightbox" },
  { id: "panel", label: "side panel" }
];

export const isPreviewMode = (id: unknown): id is string =>
  typeof id === "string" && PREVIEW_MODES.some(m => m.id === id);
