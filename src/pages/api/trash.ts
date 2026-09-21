import type { APIRoute } from "astro";
import {
  listActiveTrash,
  NotRevertibleError,
  purgeAllTrash,
  purgeTrashEntry,
  restoreFromTrash,
  scopeAuditRows
} from "../../lib/auditLog";
import { json, requireAdmin } from "../../lib/http";

// every signed-in user can see what's in the trash (scoped to their home dir if restricted,
// see users.homeDir) - only admins can restore or purge it
export const GET: APIRoute = async ({ locals }) => {
  const items = scopeAuditRows(await listActiveTrash(), locals.user!.homeDir);
  return json(200, { items });
};

// restores one trashed entry
export const PATCH: APIRoute = async ({ request, locals }) => {
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

  try {
    const { path } = await restoreFromTrash(locals.user!.id, id);
    return json(200, { ok: true, path });
  } catch (e) {
    if (e instanceof NotRevertibleError) return json(409, { error: e.message });
    throw e;
  }
};

// ?id= purges one trashed entry permanently; ?all=1 empties the whole trash - both admin-only
export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  if (url.searchParams.get("all") === "1") {
    const purged = await purgeAllTrash(locals.user!.id);
    return json(200, { ok: true, purged });
  }

  const idParam = url.searchParams.get("id");
  const id = idParam ? Number(idParam) : NaN;
  if (!Number.isInteger(id)) return json(400, { error: "id is required" });

  try {
    await purgeTrashEntry(locals.user!.id, id);
  } catch (e) {
    if (e instanceof NotRevertibleError) return json(409, { error: e.message });
    throw e;
  }
  return json(200, { ok: true });
};
