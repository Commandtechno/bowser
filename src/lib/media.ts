import mime from "mime";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export const PHOTOS_DIR = resolve(import.meta.env.PHOTOS_DIR || "./photos");
export const THUMBS_DIR = resolve(import.meta.env.THUMBS_DIR || "./.thumbs");

export class InvalidPathError extends Error {}

// resolves a `/`-joined relative path against a root dir, rejecting any attempt to escape it
export const resolveInDir = (root: string, relPath: string): string => {
  const segs = relPath.split("/").filter(seg => seg.length > 0);
  if (segs.some(seg => seg === "." || seg === ".."))
    throw new InvalidPathError(`path traversal rejected: ${relPath}`);

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
