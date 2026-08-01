// app-specific glue between the generic download/context-menu primitives and this app's
// /api/list, /api/file, /api/folder, /api/entry endpoints - shared by Explorer.astro's
// grid and Sidebar.astro's tree

import type { TContextMenuItem } from "./contextMenu";
import { downloadFolder, supportsFolderDownload } from "./downloadFolder";
import { getCurrentPath, updatePath } from "./path";
import type { TFileEntry } from "./mediaUrls";
import { showToast } from "./toast";

const joinPath = (base: string[], relPath: string): string => [...base, ...relPath.split("/").filter(Boolean)].join("/");

declare global {
  interface Window {
    __canWrite?: boolean;
  }
}

// readonly accounts get a browse/download-only UI - mirrors the server-side canWrite
// check in api/folder.ts, api/entry.ts and api/shares.ts, which is the actual enforcement
export const canWriteClient = (): boolean => window.__canWrite !== false;

// true if `path` is `prefix` or lives somewhere underneath it
const isPathWithin = (path: string[], prefix: string[]): boolean =>
  prefix.length <= path.length && prefix.every((seg, i) => path[i] === seg);

// the parent dir (as a "/"-joined key, "" for root) of every affected path - both callers
// (Explorer's grid, Sidebar's tree) key their fetch caches by that same "" | "a/b/c" shape
const notifyFsChanged = (affectedPaths: string[][]): void => {
  const parents = [...new Set(affectedPaths.map(p => p.slice(0, -1).join("/")))];
  window.dispatchEvent(new CustomEvent<{ parents: string[] }>("fsChanged", { detail: { parents } }));
};

// window.prompt trimmed + validated as a single path segment - null means "cancelled or invalid"
const promptEntryName = (title: string, initial: string): string | null => {
  const input = window.prompt(title, initial);
  if (input === null) return null;
  const name = input.trim();
  if (!name) return null;
  if (name.includes("/") || name === "." || name === "..") {
    showToast(`"${name}" isn't a valid name`, "error");
    return null;
  }
  return name;
};

export const createFolderInteractive = async (dirPath: string[]): Promise<void> => {
  const name = promptEntryName("new folder name", "");
  if (!name) return;

  try {
    const res = await fetch("/api/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: [...dirPath, name].join("/") })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error ?? "failed to create folder", "error");
      return;
    }
    notifyFsChanged([[...dirPath, name]]);
  } catch {
    showToast("network error", "error");
  }
};

export const renameEntryInteractive = async (currentPath: string[], name: string, isDir: boolean): Promise<void> => {
  const newName = promptEntryName(`rename "${name}" to`, name);
  if (!newName || newName === name) return;

  const from = [...currentPath, name];
  const to = [...currentPath, newName];

  try {
    const res = await fetch("/api/entry", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: from.join("/"), to: to.join("/") })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error ?? "failed to rename", "error");
      return;
    }
    notifyFsChanged([from, to]);
    // renaming a folder the user is currently inside (or above) needs the url to follow it
    if (isDir && isPathWithin(getCurrentPath(), from)) updatePath([...to, ...getCurrentPath().slice(from.length)]);
    showToast(`renamed to "${newName}"`, "success");
  } catch {
    showToast("network error", "error");
  }
};

export const deleteEntryInteractive = async (currentPath: string[], name: string, isDir: boolean): Promise<void> => {
  if (!window.confirm(`delete "${name}"? this can't be undone.`)) return;

  const target = [...currentPath, name];

  try {
    const res = await fetch(`/api/entry?path=${encodeURIComponent(target.join("/"))}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error ?? "failed to delete", "error");
      return;
    }
    notifyFsChanged([target]);
    // the folder the user's looking at (or a parent of it) just disappeared - back out of it
    if (isDir && isPathWithin(getCurrentPath(), target)) updatePath(currentPath);
    showToast(`"${name}" deleted`, "success");
  } catch {
    showToast("network error", "error");
  }
};

export type TMoveSource = { currentPath: string[]; name: string; isDir: boolean };

export const openMoveDialog = (source: TMoveSource): void => {
  window.dispatchEvent(new CustomEvent<TMoveSource>("openMoveDialog", { detail: source }));
};

// shared by MoveDialog so it doesn't have to duplicate the fs-changed/navigation fixup logic
export const moveEntryTo = async (source: TMoveSource, destDir: string[]): Promise<boolean> => {
  const from = [...source.currentPath, source.name];
  const to = [...destDir, source.name];

  try {
    const res = await fetch("/api/entry", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: from.join("/"), to: to.join("/") })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showToast(body.error ?? "failed to move", "error");
      return false;
    }
    notifyFsChanged([from, to]);
    if (source.isDir && isPathWithin(getCurrentPath(), from)) updatePath([...to, ...getCurrentPath().slice(from.length)]);
    showToast(`moved "${source.name}"`, "success");
    return true;
  } catch {
    showToast("network error", "error");
    return false;
  }
};

export const downloadAppFolder = async (dirPath: string[]): Promise<void> => {
  const name = dirPath.at(-1) ?? "photos";
  try {
    await downloadFolder(
      name,
      async relPath => {
        const res = await fetch(`/api/list?path=${encodeURIComponent(joinPath(dirPath, relPath))}`);
        if (!res.ok) throw new Error("failed to list folder");
        return res.json();
      },
      relPath => `/api/file?path=${encodeURIComponent(joinPath(dirPath, relPath))}`
    );
    showToast(`"${name}" downloaded`, "success");
  } catch (e) {
    if ((e as { name?: string } | undefined)?.name === "AbortError") return; // user cancelled the picker
    console.error(e);
    showToast(`failed to download "${name}"`, "error");
  }
};

export const downloadAppFile = (currentPath: string[], file: TFileEntry): void => {
  const key = [...currentPath, file.name].join("/");
  const a = document.createElement("a");
  a.href = `/api/file?path=${encodeURIComponent(key)}`;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

export const openShareDialog = (dirPath: string[]): void => {
  window.dispatchEvent(new CustomEvent<{ path: string[] }>("openShareDialog", { detail: { path: dirPath } }));
};

export const folderContextMenuItems = (dirPath: string[]): TContextMenuItem[] => {
  const supported = supportsFolderDownload();
  const parentPath = dirPath.slice(0, -1);
  const name = dirPath.at(-1)!;
  const source: TMoveSource = { currentPath: parentPath, name, isDir: true };

  const items: TContextMenuItem[] = [
    {
      type: "action",
      label: "download folder",
      onClick: () => void downloadAppFolder(dirPath),
      disabled: !supported,
      title: supported ? undefined : "your browser doesn't support saving folders directly"
    }
  ];
  if (!canWriteClient()) return items;

  items.unshift({ type: "action", label: "share…", onClick: () => openShareDialog(dirPath) });
  items.push(
    { type: "separator" },
    { type: "action", label: "rename…", onClick: () => void renameEntryInteractive(parentPath, name, true) },
    { type: "action", label: "move…", onClick: () => openMoveDialog(source) },
    { type: "action", label: "delete", danger: true, onClick: () => void deleteEntryInteractive(parentPath, name, true) }
  );
  return items;
};

export const fileContextMenuItems = (currentPath: string[], file: TFileEntry): TContextMenuItem[] => {
  const source: TMoveSource = { currentPath, name: file.name, isDir: false };

  const items: TContextMenuItem[] = [
    { type: "action", label: "download file", onClick: () => downloadAppFile(currentPath, file) }
  ];
  if (!canWriteClient()) return items;

  items.push(
    { type: "separator" },
    { type: "action", label: "rename…", onClick: () => void renameEntryInteractive(currentPath, file.name, false) },
    { type: "action", label: "move…", onClick: () => openMoveDialog(source) },
    { type: "action", label: "delete", danger: true, onClick: () => void deleteEntryInteractive(currentPath, file.name, false) }
  );
  return items;
};
