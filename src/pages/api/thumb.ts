import type { APIRoute } from "astro";
import { stat } from "node:fs/promises";
import { json, requireAdmin } from "../../lib/http";
import { InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";
import { classifyMedia, iconFor } from "../../lib/mediaKind";
import { buildThumb, clearThumbCache, getCachedDerivative, thumbCachePath } from "../../lib/thumbGen";

// Response.redirect() marks its headers immutable, which throws once the auth middleware
// appends its session cookie - build an ordinary mutable response instead
const iconRedirect = (relPath: string, url: URL): Response =>
  new Response(null, { status: 302, headers: { location: new URL(iconFor(relPath), url).href } });

export const GET: APIRoute = async ({ url, locals }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  const kind = classifyMedia(relPath);
  if (kind === "unknown" || kind === "code") return iconRedirect(relPath, url);

  let sourcePath: string;
  let thumbPath: string;
  try {
    sourcePath = resolveInDir(rootDirFor(locals.user), relPath);
    thumbPath = thumbCachePath(sourcePath);
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

  // extraction and encoding are both fallible in the same way (corrupt/unsupported source
  // media) - either one falls back to the file-type icon rather than surfacing an error
  const buffer = await getCachedDerivative({
    sourcePath,
    cachePath: thumbPath,
    sourceMtimeMs: sourceStat.mtimeMs,
    generate: () => buildThumb(sourcePath, kind)
  });
  if (!buffer) return iconRedirect(relPath, url);

  return new Response(new Uint8Array(buffer), {
    headers: { "content-type": "image/webp", "cache-control": "private, max-age=3600" }
  });
};

// admin only: clears the whole thumbnail/preview cache - everything regenerates on demand
export const DELETE: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  await clearThumbCache();
  return json(200, { ok: true });
};
