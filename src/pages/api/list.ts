import type { APIRoute } from "astro";
import { InvalidPathError, listDir, resolveInDir, rootDirFor } from "../../lib/media";
import { warmRawThumbs } from "../../lib/thumbGen";

export const GET: APIRoute = async ({ url, locals }) => {
  const relPath = url.searchParams.get("path") ?? "";

  try {
    const root = rootDirFor(locals.user);
    const listing = await listDir(root, relPath);
    // pre-generate this folder's raw thumbnails in the background while the grid renders,
    // so scrolling hits warm cache instead of paying extraction latency per tile
    warmRawThumbs(resolveInDir(root, relPath), listing.files.map(f => f.name));
    return new Response(JSON.stringify(listing), {
      headers: { "content-type": "application/json", "cache-control": "private, max-age=60" }
    });
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    return new Response(null, { status: 404 });
  }
};
