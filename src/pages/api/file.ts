import type { APIRoute } from "astro";
import { InvalidPathError, PHOTOS_DIR, resolveInDir, serveFile } from "../../lib/media";

export const GET: APIRoute = async ({ url, request }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  let filePath: string;
  try {
    filePath = resolveInDir(PHOTOS_DIR, relPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    throw e;
  }

  return serveFile(filePath, request);
};
