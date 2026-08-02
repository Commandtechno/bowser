import type { APIRoute } from "astro";
import { InvalidPathError, ROOT_DIR, resolveInDir, serveFile } from "../../lib/media";
import { getShareLink, isShareLinkExpired, resolveSharePath } from "../../lib/shareLinks";

export const GET: APIRoute = async ({ url, request }) => {
  const token = url.searchParams.get("token");
  if (!token) return new Response(null, { status: 400 });

  const share = await getShareLink(token);
  if (!share || isShareLinkExpired(share)) return new Response(null, { status: 404 });

  const relPath = resolveSharePath(share.path, url.searchParams.get("path") ?? "");

  let filePath: string;
  try {
    filePath = resolveInDir(ROOT_DIR, relPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    throw e;
  }

  return serveFile(filePath, request);
};
