import type { APIRoute } from "astro";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import sharp from "sharp";
import { InvalidPathError, ROOT_DIR, THUMBS_DIR, resolveInDir } from "../../lib/media";
import { classifyMedia } from "../../lib/mediaKind";
import { extractRawPreview } from "../../lib/preview";

// browsers can't decode raw sensor data, so this serves the camera's embedded JPEG preview
// (much higher res than the thumbnail, but still just a preview - not the full raw resolution)
const PREVIEW_MAX_DIMENSION = 2048;

export const GET: APIRoute = async ({ url }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  if (classifyMedia(relPath) !== "raw") return new Response(null, { status: 400 });

  let sourcePath: string;
  let previewPath: string;
  try {
    sourcePath = resolveInDir(ROOT_DIR, relPath);
    previewPath = resolveInDir(THUMBS_DIR, relPath) + ".preview.jpg";
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

  const cachedStat = await stat(previewPath).catch(() => null);

  if (cachedStat && cachedStat.mtimeMs >= sourceStat.mtimeMs) {
    return new Response(await readFile(previewPath), {
      headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" }
    });
  }

  let buffer: Buffer;
  try {
    const extracted = await extractRawPreview(sourcePath);
    buffer = await sharp(extracted)
      .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (e) {
    console.warn(`preview generation failed for ${relPath}:`, e);
    return new Response(null, { status: 404 });
  }

  await mkdir(dirname(previewPath), { recursive: true });
  await writeFile(previewPath, buffer);

  return new Response(new Uint8Array(buffer), {
    headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" }
  });
};
