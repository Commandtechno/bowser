import type { APIRoute } from "astro";
import { stat } from "node:fs/promises";
import { json } from "../../lib/http";
import { canWrite } from "../../lib/roles";
import { absToRootRel, homeRelative, InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";
import {
  createShareLink,
  deleteShareLink,
  getShareLink,
  isValidDuration,
  listShareLinks,
  MAX_DURATION_S,
  MIN_DURATION_S
} from "../../lib/shareLinks";

// every signed-in user can see who shared what, scoped down to their own home dir if
// they're restricted to one (see users.homeDir) - admins are always unrestricted, so this
// stays the full list for them
export const GET: APIRoute = async ({ url, locals }) => {
  const includeExpired = url.searchParams.get("includeExpired") === "1";
  const shares = await listShareLinks(includeExpired);
  const homeDir = locals.user!.homeDir;
  const scoped = homeDir
    ? shares.flatMap(s => {
        const path = homeRelative(homeDir, s.path);
        return path === null ? [] : [{ ...s, path }];
      })
    : shares;
  return json(200, { shares: scoped });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;
  if (!canWrite(user)) return json(403, { error: "read-only account" });

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
  let rootRelPath: string;
  try {
    dirPath = resolveInDir(rootDirFor(user), path);
    // shares are always stored relative to the true ROOT_DIR, not the creator's scoped root -
    // the public /share page resolves them without any signed-in user (and thus no home dir)
    // to translate against
    rootRelPath = absToRootRel(dirPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: "invalid path" });
    throw e;
  }

  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return json(404, { error: "folder not found" });

  const share = await createShareLink(rootRelPath, user.id, durationSeconds);
  return json(200, { share });
};

// owner or admin only
export const DELETE: APIRoute = async ({ url, locals }) => {
  const user = locals.user!;
  const token = url.searchParams.get("token");
  if (!token) return json(400, { error: "token is required" });

  const share = await getShareLink(token);
  if (!share) return json(404, { error: "no such share link" });
  if (share.createdBy !== user.id && user.role !== "admin") return json(403, { error: "not your share link" });
  // covers a home dir reassigned after the share was created - a restricted user can no
  // longer manage a share that's since fallen outside their scope
  if (user.homeDir && homeRelative(user.homeDir, share.path) === null) return json(403, { error: "not your share link" });

  await deleteShareLink(token);
  return json(200, { ok: true });
};
