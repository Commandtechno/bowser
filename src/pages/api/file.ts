import type { APIRoute } from "astro";
import { InvalidPathError, resolveInDir, rootDirFor, serveFile } from "../../lib/media";

export const GET: APIRoute = async ({ url, request, locals }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  let filePath: string;
  try {
    filePath = resolveInDir(rootDirFor(locals.user), relPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    throw e;
  }

  return serveFile(filePath, request);
};
