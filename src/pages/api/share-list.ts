import type { APIRoute } from "astro";
import { json } from "../../lib/http";
import { InvalidPathError, listDir, ROOT_DIR } from "../../lib/media";
import { getShareLink, isShareLinkExpired, resolveSharePath } from "../../lib/shareLinks";

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get("token");
  if (!token) return json(400, { error: "token is required" });

  const share = await getShareLink(token);
  if (!share || isShareLinkExpired(share)) return json(404, { error: "this link has expired or does not exist" });

  const relPath = resolveSharePath(share.path, url.searchParams.get("path") ?? "");

  try {
    const listing = await listDir(ROOT_DIR, relPath);
    return json(200, listing);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: "invalid path" });
    return json(404, { error: "not found" });
  }
};
