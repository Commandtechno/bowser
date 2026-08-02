// drag-and-drop / picked-file upload queue, shared by Explorer.astro (drop targets, context
// menu "upload files/folder…") and UploadPanel.astro (the bottom-right status UI). Owns all
// upload state so the panel is just a dumb renderer subscribed to it.

export type TUploadStatus = "queued" | "uploading" | "retrying" | "done" | "error" | "cancelled";

export type TUploadItem = {
  id: number;
  file: File;
  relPath: string; // full destination path within ROOT_DIR, "/"-joined
  status: TUploadStatus;
  loaded: number;
  size: number;
  error?: string;
  attempt: number;
};

type TDroppedEntry = { file: File; dirSegs: string[] };

const MAX_CONCURRENT = 4;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [600, 2000]; // delay before attempt 2, then attempt 3

let items: TUploadItem[] = [];
let nextId = 1;
let activeCount = 0;
const xhrs = new Map<number, XMLHttpRequest>();

// dirKey ("" | "a/b") -> names already claimed by an item queued this page session, so two
// same-named files dropped together never race each other for the same server-side name -
// the server's own dedupe (see writeUploadedFile) only ever sees one request at a time and
// can't arbitrate between two in-flight ones itself
const claimedNames = new Map<string, Set<string>>();

type TListener = () => void;
const listeners = new Set<TListener>();

let notifyScheduled = false;
const notify = (): void => {
  if (notifyScheduled) return;
  notifyScheduled = true;
  requestAnimationFrame(() => {
    notifyScheduled = false;
    for (const fn of listeners) fn();
  });
};

export const subscribe = (fn: TListener): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const getItems = (): TUploadItem[] => items;

const isSettled = (status: TUploadStatus): boolean =>
  status !== "queued" && status !== "uploading" && status !== "retrying";

// parent dirs ("" | "a/b/c") touched by uploads that finished since the last flush - batched
// so a folder drop of hundreds of files fires one fsChanged, not hundreds
const dirtyParents = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleFlush = (): void => {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirtyParents.size === 0) return;
    const parents = [...dirtyParents];
    dirtyParents.clear();
    window.dispatchEvent(new CustomEvent<{ parents: string[] }>("fsChanged", { detail: { parents } }));
  }, 200);
};

const claimName = (dirKey: string, baseName: string): string => {
  let claimed = claimedNames.get(dirKey);
  if (!claimed) {
    claimed = new Set();
    claimedNames.set(dirKey, claimed);
  }

  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";

  let name = baseName;
  for (let n = 2; claimed.has(name); n++) name = `${stem} (${n})${ext}`;
  claimed.add(name);
  return name;
};

const pump = (): void => {
  while (activeCount < MAX_CONCURRENT) {
    const next = items.find(it => it.status === "queued");
    if (!next) return;
    start(next);
  }
};

const parseError = (xhr: XMLHttpRequest): string => {
  try {
    const body = JSON.parse(xhr.responseText) as { error?: string };
    if (body?.error) return body.error;
  } catch {
    // fall through to the generic message below
  }
  return `upload failed (${xhr.status || "network error"})`;
};

const settle = (item: TUploadItem, status: "done" | "error" | "cancelled", error?: string): void => {
  item.status = status;
  item.error = error;
  xhrs.delete(item.id);
  activeCount--;
  if (status === "done") dirtyParents.add(item.relPath.split("/").slice(0, -1).join("/"));
  notify();
  scheduleFlush();
  pump();
};

const start = (item: TUploadItem): void => {
  item.status = "uploading";
  item.attempt++;
  activeCount++;
  notify();

  const xhr = new XMLHttpRequest();
  xhrs.set(item.id, xhr);
  xhr.open("PUT", `/api/upload?path=${encodeURIComponent(item.relPath)}`);

  xhr.upload.onprogress = e => {
    if (!e.lengthComputable) return;
    item.loaded = e.loaded;
    notify();
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      item.loaded = item.size;
      settle(item, "done");
      return;
    }
    retryOrFail(item, parseError(xhr));
  };

  xhr.onerror = () => retryOrFail(item, "network error");
  xhr.onabort = () => settle(item, "cancelled");

  xhr.send(item.file);
};

const retryOrFail = (item: TUploadItem, error: string): void => {
  xhrs.delete(item.id);
  if (item.attempt < MAX_ATTEMPTS) {
    // freed slot is handled here, not by settle() - "retrying" (rather than going straight
    // back to "queued") keeps pump() from grabbing this item again before its backoff elapses
    activeCount--;
    item.status = "retrying";
    item.loaded = 0;
    notify();
    setTimeout(() => {
      if (item.status !== "retrying") return; // cancelled while the backoff was pending
      item.status = "queued";
      notify();
      pump();
    }, RETRY_DELAY_MS[item.attempt - 1] ?? 2000);
    pump(); // let some other already-queued item use the slot this attempt just freed
    return;
  }
  settle(item, "error", error);
};

const enqueue = (targetDir: string[], entries: TDroppedEntry[]): void => {
  if (entries.length === 0) return;

  for (const { file, dirSegs } of entries) {
    const dirParts = [...targetDir, ...dirSegs];
    const dirKey = dirParts.join("/");
    const name = claimName(dirKey, file.name);
    items.push({
      id: nextId++,
      file,
      relPath: [...dirParts, name].join("/"),
      status: "queued",
      loaded: 0,
      size: file.size,
      attempt: 0
    });
  }

  notify();
  pump();
};

/** Enqueues a flat list of picked/dropped files (no folder structure) into targetDir. */
export const enqueueFiles = (targetDir: string[], files: Iterable<File>): void => {
  const entries: TDroppedEntry[] = [];
  for (const file of files) {
    if (file.name.startsWith(".")) continue;
    entries.push({ file, dirSegs: [] });
  }
  enqueue(targetDir, entries);
};

/**
 * Enqueues files picked via an <input type="file" webkitdirectory> - each File's
 * webkitRelativePath ("folder/sub/leaf.jpg") reconstructs the dropped tree's structure.
 */
export const enqueueFileListWithPaths = (targetDir: string[], files: Iterable<File>): void => {
  const entries: TDroppedEntry[] = [];
  for (const file of files) {
    const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const segs = relPath ? relPath.split("/").filter(Boolean) : [file.name];
    if (segs.some(seg => seg.startsWith("."))) continue;
    entries.push({ file, dirSegs: segs.slice(0, -1) });
  }
  enqueue(targetDir, entries);
};

// FileSystemDirectoryReader.readEntries must be called repeatedly until it returns an empty
// batch - a single call isn't guaranteed to return every child, especially in large folders
const readAllEntries = (reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(batch => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });

const collectEntry = async (entry: FileSystemEntry, dirSegs: string[]): Promise<TDroppedEntry[]> => {
  if (entry.name.startsWith(".")) return [];

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    return [{ file, dirSegs }];
  }

  if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(children.map(child => collectEntry(child, [...dirSegs, entry.name])));
    return nested.flat();
  }

  return [];
};

/** Enqueues a drop's DataTransfer, recursing into dropped folders where the browser supports it. */
export const enqueueDrop = async (targetDir: string[], dataTransfer: DataTransfer): Promise<void> => {
  const dtItems = [...dataTransfer.items].filter(it => it.kind === "file");

  // webkitGetAsEntry (despite the name, supported by every major engine) is required to see
  // folder structure at all - without it, fall back to the flat file list
  const topEntries = dtItems.map(it => it.webkitGetAsEntry?.() ?? null);
  if (topEntries.some(e => e === null)) {
    enqueueFiles(targetDir, dataTransfer.files);
    return;
  }

  const nested = await Promise.all(topEntries.map(e => collectEntry(e!, [])));
  enqueue(targetDir, nested.flat());
};

export const cancelItem = (id: number): void => {
  const item = items.find(it => it.id === id);
  if (!item) return;
  if (item.status === "uploading") {
    xhrs.get(id)?.abort();
    return; // onabort -> settle() takes it from here, including the activeCount decrement
  }
  if (item.status === "queued" || item.status === "retrying") {
    // never actually held a slot (queued) or already gave it back (retrying) - just mark it
    // done, no activeCount/pump involvement needed
    item.status = "cancelled";
    notify();
  }
};

export const retryItem = (id: number): void => {
  const item = items.find(it => it.id === id);
  if (!item || item.status !== "error") return;
  item.attempt = 0;
  item.status = "queued";
  item.error = undefined;
  notify();
  pump();
};

export const removeItem = (id: number): void => {
  const item = items.find(it => it.id === id);
  if (item && !isSettled(item.status)) cancelItem(id);
  items = items.filter(it => it.id !== id);
  notify();
};

/** Cancels everything in-flight/queued and clears the whole list, e.g. the panel's close button. */
export const clearAll = (): void => {
  // let each aborted upload's own onabort -> settle() decrement activeCount as it actually
  // fires, rather than forcing it to 0 here - settle() mutates the item object directly (not
  // via an items-array lookup), so it's still safe to call once this array is cleared below
  for (const item of items) if (item.status === "uploading") xhrs.get(item.id)?.abort();
  items = [];
  notify();
};

/** Drops finished (done/error/cancelled) items from the list, leaving active ones alone. */
export const clearFinished = (): void => {
  items = items.filter(it => !isSettled(it.status));
  notify();
};
