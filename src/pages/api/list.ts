import type { APIRoute } from "astro";
import { InvalidPathError, PHOTOS_DIR, listDir } from "../../lib/media";

export const GET: APIRoute = async ({ url }) => {
  const relPath = url.searchParams.get("path") ?? "";

  try {
    const listing = await listDir(PHOTOS_DIR, relPath);
    return new Response(JSON.stringify(listing), {
      headers: { "content-type": "application/json", "cache-control": "private, max-age=60" }
    });
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    return new Response(null, { status: 404 });
  }
};
