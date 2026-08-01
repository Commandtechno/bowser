import type { APIRoute } from "astro";
import { stat } from "node:fs/promises";
import { canWrite, deleteShareServe, insertShareServe } from "../../lib/db";
import { InvalidPathError, PHOTOS_DIR, resolveInDir } from "../../lib/media";
import {
  activeServeCount,
  buildCopyCommand,
  isValidProtocol,
  MAX_RCLONE_SERVES,
  SERVE_USER,
  startServeProcess,
  stopServeProcess,
  type TProtocol
} from "../../lib/rcloneServe";
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

export const POST: APIRoute = async ({ request, locals, url }) => {
  const user = locals.user!;
  if (!canWrite(user)) return json(403, { error: "read-only account" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { path, durationSeconds, protocol } = (body ?? {}) as {
    path?: unknown;
    durationSeconds?: unknown;
    protocol?: unknown;
  };

  if (typeof path !== "string") return json(400, { error: "path is required" });
  if (!isValidDuration(durationSeconds))
    return json(400, { error: `duration must be between ${MIN_DURATION_S} and ${MAX_DURATION_S} seconds` });
  if (protocol !== undefined && !isValidProtocol(protocol)) return json(400, { error: "invalid protocol" });

  let dirPath: string;
  try {
    dirPath = resolveInDir(PHOTOS_DIR, path);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: "invalid path" });
    throw e;
  }

  const dirStat = await stat(dirPath).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) return json(404, { error: "folder not found" });

  if (protocol !== undefined && activeServeCount() >= MAX_RCLONE_SERVES)
    return json(429, { error: `too many active protocol shares (limit ${MAX_RCLONE_SERVES}) - revoke one first` });

  const share = await createShareLink(path, user.id, durationSeconds);

  if (protocol === undefined) return json(200, { share });

  // the share link itself is already created and valid at this point - a failure spinning up
  // the rclone process shouldn't be reported as the whole request having failed
  try {
    const { port, password } = await startServeProcess(share.token, protocol as TProtocol, dirPath);
    await insertShareServe({ token: share.token, protocol, port, password });
    // same host the browser used to reach this API - the best available guess at what's
    // actually reachable from the receiving machine, matching how the plain share link is
    // already built client-side from location.origin
    const copyCommand = await buildCopyCommand(protocol as TProtocol, url.hostname, port, password);
    return json(200, {
      share: { ...share, protocol, servePort: port },
      serve: { protocol, port, user: SERVE_USER, password, copyCommand }
    });
  } catch (e) {
    return json(200, { share, serveError: e instanceof Error ? e.message : "failed to start protocol share" });
  }
};

// owner or admin only
export const DELETE: APIRoute = async ({ url, locals }) => {
  const user = locals.user!;
  const token = url.searchParams.get("token");
  if (!token) return json(400, { error: "token is required" });

  const share = await getShareLink(token);
  if (!share) return json(404, { error: "no such share link" });
  if (share.createdBy !== user.id && user.role !== "admin") return json(403, { error: "not your share link" });

  stopServeProcess(token);
  await deleteShareServe(token);
  await deleteShareLink(token);
  return json(200, { ok: true });
};
