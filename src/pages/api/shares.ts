import type { APIRoute } from "astro";
import { stat } from "node:fs/promises";
import { InvalidPathError, PHOTOS_DIR, resolveInDir } from "../../lib/media";
import {
  createShareLink,
  deleteShareLink,
  getShareLink,
  isValidDuration,
  listShareLinks,
  MAX_DURATION_S,
  MIN_DURATION_S
} from "../../lib/shareLinks";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// every signed-in user can see who shared what - there's no per-user folder permission
// model in this app, everyone already browses the same tree
export const GET: APIRoute = async ({ url }) => {
  const includeExpired = url.searchParams.get("includeExpired") === "1";
  return json(200, { shares: await listShareLinks(includeExpired) });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { path, durationSeconds } = (body ?? {}) as { path?: unknown; durationSeconds?: unknown };

  if (typeof path !== "string") return json(400, { error: "path is required" });
  if (!isValidDuration(durationSeconds))
    return json(400, { error: `duration must be between ${MIN_DURATION_S} and ${MAX_DURATION_S} seconds` });

  let dirPath: string;
  try {
    dirPath = resolveInDir(PHOTOS_DIR, path);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: "invalid path" });
    throw e;
  }

  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return json(404, { error: "folder not found" });

  const share = await createShareLink(path, user.id, durationSeconds);
  return json(200, { share });
};

// owner or admin only
export const DELETE: APIRoute = async ({ url, locals }) => {
  const user = locals.user!;
  const token = url.searchParams.get("token");
  if (!token) return json(400, { error: "token is required" });

  const share = await getShareLink(token);
  if (!share) return json(404, { error: "no such share link" });
  if (share.createdBy !== user.id && !user.isAdmin) return json(403, { error: "not your share link" });

  await deleteShareLink(token);
  return json(200, { ok: true });
};
