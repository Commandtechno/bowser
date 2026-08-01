import type { APIRoute } from "astro";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { InvalidPathError, PHOTOS_DIR, THUMBS_DIR, resolveInDir } from "../../lib/media";
import { classifyMedia, iconFor } from "../../lib/mediaKind";
import { extractAudioCover, extractPdfPage, extractRawPreview, extractVideoFrame } from "../../lib/preview";

const THUMB_SIZE = 300;

// Response.redirect() marks its headers immutable, which throws once the auth middleware
// appends its session cookie - build an ordinary mutable response instead
const iconRedirect = (relPath: string, url: URL): Response =>
  new Response(null, { status: 302, headers: { location: new URL(iconFor(relPath), url).href } });

export const GET: APIRoute = async ({ url }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  const kind = classifyMedia(relPath);
  if (kind === "unknown" || kind === "code") return iconRedirect(relPath, url);

  let sourcePath: string;
  let thumbPath: string;
  try {
    sourcePath = resolveInDir(PHOTOS_DIR, relPath);
    thumbPath = resolveInDir(THUMBS_DIR, relPath) + ".webp";
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    throw e;
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    return new Response(null, { status: 404 });
  }

  const cachedStat = await stat(thumbPath).catch(() => null);

  if (cachedStat && cachedStat.mtimeMs >= sourceStat.mtimeMs) {
    return new Response(await readFile(thumbPath), {
      headers: { "content-type": "image/webp", "cache-control": "private, max-age=3600" }
    });
  }

  // extraction and encoding are both fallible in the same way (corrupt/unsupported source
  // media) - either one falls back to the file-type icon rather than surfacing an error
  let buffer: Buffer;
  try {
    let source: string | Buffer = sourcePath;
    if (kind === "raw") source = await extractRawPreview(sourcePath);
    else if (kind === "video") source = await extractVideoFrame(sourcePath);
    // uses embedded cover art; files without any fall through to the icon below
    else if (kind === "audio") source = await extractAudioCover(sourcePath);
    else if (kind === "pdf") source = await extractPdfPage(sourcePath);

    buffer = await sharp(source)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
      .webp()
      .toBuffer();
  } catch (e) {
    console.warn(`thumbnail generation failed for ${relPath}:`, e);
    return iconRedirect(relPath, url);
  }

  await mkdir(dirname(thumbPath), { recursive: true });
  await writeFile(thumbPath, buffer);

  return new Response(new Uint8Array(buffer), {
    headers: { "content-type": "image/webp", "cache-control": "private, max-age=3600" }
  });
};
