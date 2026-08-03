import type { APIRoute } from "astro";
import { listAuditLogRows, revertToPoint, scopeAuditRows } from "../../lib/auditLog";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requireAdmin = (locals: App.Locals): Response | null =>
  locals.user?.role === "admin" ? null : json(403, { error: "admin only" });

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

// every signed-in user can see the version history, scoped down to their own home dir if
// they're restricted to one (see users.homeDir) - admins are always unrestricted, so this
// stays the full log for them (mirrors GET /api/shares)
export const GET: APIRoute = async ({ url, locals }) => {
  const beforeIdParam = url.searchParams.get("beforeId");
  const beforeId = beforeIdParam ? Number(beforeIdParam) : undefined;
  if (beforeIdParam && (!Number.isInteger(beforeId) || beforeId! <= 0)) return json(400, { error: "invalid beforeId" });

  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) return json(400, { error: `limit must be 1-${MAX_LIMIT}` });

  // fetch one extra row to know whether there's more without a separate count query
  const rows = await listAuditLogRows({ beforeId, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const entries = scopeAuditRows(hasMore ? rows.slice(0, limit) : rows, locals.user!.homeDir);
  return json(200, { entries, hasMore });
};

// reverts every action after `id`, newest-first, leaving `id` itself applied - "revert to
// this point in time"
export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { id } = (body ?? {}) as { id?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id)) return json(400, { error: "id is required" });

  const result = await revertToPoint(locals.user!.id, id);
  return json(200, result);
};
