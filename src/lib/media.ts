import mime from "mime";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PHOTOS_DIR = resolve(import.meta.env.PHOTOS_DIR || "./photos");
export const THUMBS_DIR = resolve(import.meta.env.THUMBS_DIR || "./.thumbs");
// nested inside PHOTOS_DIR (not a sibling like THUMBS_DIR) so trashing an entry is an atomic
// same-filesystem rename() rather than a copy+delete - and it's invisible in listings for
// free, since listDir already skips dot-prefixed entries. See src/lib/auditLog.ts.
export const TRASH_DIR = join(PHOTOS_DIR, ".trash");

export class InvalidPathError extends Error {}
export class EntryExistsError extends Error {}

// resolves a `/`-joined relative path against a root dir, rejecting any attempt to escape it
export const resolveInDir = (root: string, relPath: string): string => {
  const segs = relPath.split("/").filter(seg => seg.length > 0);
  if (segs.some(seg => seg === "." || seg === ".."))
    throw new InvalidPathError(`path traversal rejected: ${relPath}`);
  // .trash is reserved for src/lib/auditLog.ts - without this a member could bypass
  // admin-only restore/purge by addressing trashed entries directly through the normal
  // file API (e.g. PATCH /api/entry with path=".trash/<id>")
  if (segs[0] === ".trash") throw new InvalidPathError(`path is reserved: ${relPath}`);

  const full = resolve(join(root, ...segs));
  if (full !== root && !full.startsWith(root + sep)) throw new InvalidPathError(`path escapes root: ${relPath}`);

  return full;
};

export const mimeTypeOf = (filename: string): string => mime.getType(filename) ?? "application/octet-stream";

export type TFileEntry = { name: string; size: number; mtime: number };
export type TDirListing = { dirs: string[]; files: TFileEntry[] };

// lists the immediate contents of a single directory (no recursion)
export const listDir = async (root: string, relPath: string): Promise<TDirListing> => {
  const dirPath = resolveInDir(root, relPath);
  const entries = await readdir(dirPath, { withFileTypes: true });

  const dirs: string[] = [];
  const fileNames: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // skip hidden entries (.thumbs, .DS_Store, ...)

    if (entry.isDirectory()) dirs.push(entry.name);
    else if (entry.isFile()) fileNames.push(entry.name);
  }

  const files = await Promise.all(
    fileNames.map(async name => {
      const stats = await stat(join(dirPath, name));
      return { name, size: stats.size, mtime: stats.mtimeMs };
    })
  );

  dirs.sort((a, b) => a.localeCompare(b));
  files.sort((a, b) => a.name.localeCompare(b.name));

  return { dirs, files };
};

// creates a single new, empty directory - the parent must already exist (mirrors mkdir,
// not mkdir -p) since the only caller is "new folder" inside a directory the user is
// already looking at
export const createFolder = async (root: string, relPath: string): Promise<void> => {
  const dirPath = resolveInDir(root, relPath);
  if (dirPath === root) throw new InvalidPathError("cannot create the root directory");
  await mkdir(dirPath);
};

// renames/moves a file or directory - refuses to touch the root, to move an entry into
// itself or one of its own descendants, or to clobber an existing entry at the destination
export const moveEntry = async (root: string, fromRelPath: string, toRelPath: string): Promise<void> => {
  const fromPath = resolveInDir(root, fromRelPath);
  const toPath = resolveInDir(root, toRelPath);
  if (fromPath === root || toPath === root) throw new InvalidPathError("cannot move the root directory");
  if (toPath === fromPath || toPath.startsWith(fromPath + sep))
    throw new InvalidPathError("cannot move an item into itself");

  const destExists = await stat(toPath)
    .then(() => true)
    .catch(() => false);
  if (destExists) throw new EntryExistsError(`"${toRelPath}" already exists`);

  await rename(fromPath, toPath);
};

// picks a name that doesn't collide with anything already in dirPath, appending " (2)",
// " (3)", ... before the extension - mirrors how common OS file managers resolve conflicts
// instead of silently clobbering an existing file. Same stat-then-act race the rest of this
// file accepts elsewhere (see moveEntry) rather than something transactional. Also reused by
// src/lib/auditLog.ts when restoring a trashed entry whose original spot is now occupied
export const uniqueName = async (dirPath: string, baseName: string): Promise<string> => {
  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";

  let name = baseName;
  for (let n = 2; await stat(join(dirPath, name)).then(() => true, () => false); n++) {
    name = `${stem} (${n})${ext}`;
  }
  return name;
};

// writes an uploaded file's body to disk under root/relPath, creating any missing parent
// directories and dodging name collisions (see uniqueName) - relPath's last segment is the
// file name, everything before it is the destination directory. Streams directly from the
// request body to disk rather than buffering, so upload size isn't bounded by memory
export const writeUploadedFile = async (
  root: string,
  relPath: string,
  body: ReadableStream<Uint8Array>
): Promise<{ name: string; size: number }> => {
  const segs = relPath.split("/").filter(seg => seg.length > 0);
  if (segs.length === 0) throw new InvalidPathError("a file name is required");
  if (segs.some(seg => seg === "." || seg === ".."))
    throw new InvalidPathError(`path traversal rejected: ${relPath}`);

  const dirPath = resolveInDir(root, segs.slice(0, -1).join("/"));
  await mkdir(dirPath, { recursive: true });

  const name = await uniqueName(dirPath, segs[segs.length - 1]);
  const destPath = join(dirPath, name);

  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(destPath));
  } catch (e) {
    // don't leave a truncated/partial file behind for a client-side retry to trip over
    await rm(destPath, { force: true }).catch(() => {});
    throw e;
  }

  const { size } = await stat(destPath);
  return { name, size };
};

// streams a file with range support - shared by the authenticated /api/file endpoint and
// the public share-scoped /api/share-file endpoint, which both just need to hand it a
// path they've already resolved+validated themselves
export const serveFile = async (filePath: string, request: Request): Promise<Response> => {
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!fileStat.isFile()) return new Response(null, { status: 404 });

  const mimeType = mimeTypeOf(filePath);
  const range = request.headers.get("range");

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : fileStat.size - 1;

    if (start > end || end >= fileStat.size) {
      return new Response(null, { status: 416, headers: { "content-range": `bytes */${fileStat.size}` } });
    }

    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        "content-type": mimeType,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${fileStat.size}`,
        "accept-ranges": "bytes"
      }
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": mimeType,
      "content-length": String(fileStat.size),
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600"
    }
  });
};
