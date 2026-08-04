import type { APIRoute } from "astro";
import { stat } from "node:fs/promises";
import sharp from "sharp";
import { InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";
import { classifyMedia } from "../../lib/mediaKind";
import { extractRawPreview } from "../../lib/preview";
import { getCachedDerivative, previewCachePath } from "../../lib/thumbGen";

// browsers can't decode raw sensor data, so this serves the camera's embedded JPEG preview
// (much higher res than the thumbnail, but still just a preview - not the full raw resolution)
const PREVIEW_MAX_DIMENSION = 2048;

export const GET: APIRoute = async ({ url, locals }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  if (classifyMedia(relPath) !== "raw") return new Response(null, { status: 400 });

  let sourcePath: string;
  let previewPath: string;
  try {
    sourcePath = resolveInDir(rootDirFor(locals.user), relPath);
    previewPath = previewCachePath(sourcePath);
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

  const buffer = await getCachedDerivative({
    sourcePath,
    cachePath: previewPath,
    sourceMtimeMs: sourceStat.mtimeMs,
    generate: async () => {
      const extracted = await extractRawPreview(sourcePath);
      return sharp(extracted)
        .resize(PREVIEW_MAX_DIMENSION, PREVIEW_MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();
    }
  });
  if (!buffer) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(buffer), {
    headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" }
  });
};
