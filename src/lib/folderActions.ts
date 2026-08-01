// app-specific glue between the generic download/context-menu primitives and this app's
// /api/list + /api/file endpoints - shared by Explorer.astro's grid and Sidebar.astro's tree

import type { TContextMenuItem } from "./contextMenu";
import { downloadFolder, supportsFolderDownload } from "./downloadFolder";
import type { TFileEntry } from "./mediaUrls";
import { showToast } from "./toast";

const joinPath = (base: string[], relPath: string): string => [...base, ...relPath.split("/").filter(Boolean)].join("/");

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
  return [
    { type: "action", label: "share…", onClick: () => openShareDialog(dirPath) },
    {
      type: "action",
      label: "download folder",
      onClick: () => void downloadAppFolder(dirPath),
      disabled: !supported,
      title: supported ? undefined : "your browser doesn't support saving folders directly"
    }
  ];
};

export const fileContextMenuItems = (currentPath: string[], file: TFileEntry): TContextMenuItem[] => [
  { type: "action", label: "download file", onClick: () => downloadAppFile(currentPath, file) }
];
