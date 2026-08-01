// writes a folder straight to disk via the File System Access API - no zip archive, no
// intermediate blob: each file streams directly from its fetch response into a handle
// created under the picked directory. Requires "readwrite" access, which is what prompts
// the browser's edit-access permission dialog.

export type TListResult = { dirs: string[]; files: { name: string }[] };
export type TListFn = (relPath: string) => Promise<TListResult>;
export type TFileUrlFn = (relPath: string) => string;
export type TProgressFn = (info: { path: string }) => void;

export const supportsFolderDownload = (): boolean =>
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

// rootName is the folder's own name - a subdirectory of that name is created inside
// whatever location the user picks, so files never get dumped loose into it
export const downloadFolder = async (
  rootName: string,
  list: TListFn,
  fileUrl: TFileUrlFn,
  onProgress?: TProgressFn
): Promise<void> => {
  if (!window.showDirectoryPicker) throw new Error("folder download is not supported in this browser");

  const pickedHandle = await window.showDirectoryPicker({ mode: "readwrite" });
  const rootHandle = await pickedHandle.getDirectoryHandle(rootName, { create: true });

  const walk = async (relPath: string, dirHandle: FileSystemDirectoryHandle): Promise<void> => {
    const { dirs, files } = await list(relPath);

    for (const file of files) {
      const filePath = relPath ? `${relPath}/${file.name}` : file.name;
      onProgress?.({ path: filePath });

      const res = await fetch(fileUrl(filePath));
      if (!res.ok || !res.body) throw new Error(`failed to download "${filePath}"`);

      const fileHandle = await dirHandle.getFileHandle(file.name, { create: true });
      const writable = await fileHandle.createWritable();
      await res.body.pipeTo(writable);
    }

    for (const dir of dirs) {
      const childPath = relPath ? `${relPath}/${dir}` : dir;
      const childHandle = await dirHandle.getDirectoryHandle(dir, { create: true });
      await walk(childPath, childHandle);
    }
  };

  await walk("", rootHandle);
};
