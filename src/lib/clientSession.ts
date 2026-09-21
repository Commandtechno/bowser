// the signed-in user as the browser sees them - Layout.astro renders these onto <html> as
// data attributes, so client scripts read them from here instead of each page injecting globals
import { canWrite, isValidRole } from "./roles";

const { userId, role, previewMode } = document.documentElement.dataset;

export const currentUserId = Number(userId);
export const isAdmin = role === "admin";
export const initialPreviewMode = previewMode === "lightbox" ? "lightbox" : "panel";

// readonly accounts get a browse/download-only UI - mirrors the server-side canWrite
// check in api/folder.ts, api/entry.ts and api/shares.ts, which is the actual enforcement
export const canWriteClient = (): boolean => isValidRole(role) && canWrite({ role });
