/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly ROOT_DIR: string;
  readonly THUMBS_DIR?: string;
  readonly DB_PATH?: string;
}

declare namespace App {
  interface Locals {
    user?: import("./lib/db").TUser;
    sessionToken?: string;
  }
}

// showDirectoryPicker isn't in TS's lib.dom.d.ts yet, even though the rest of the
// File System Access API (FileSystemDirectoryHandle etc.) is - used by lib/downloadFolder.ts
interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
}

interface Window {
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
}
