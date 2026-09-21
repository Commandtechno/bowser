import type { APIRoute } from "astro";
import { logMove, softDelete } from "../../lib/auditLog";
import { canWrite } from "../../lib/roles";
import { absToRootRel, EntryExistsError, InvalidPathError, moveEntry, resolveInDir, rootDirFor } from "../../lib/media";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// soft-deletes a file or folder (recursively) - moved into trash, not actually removed;
// see src/lib/auditLog.ts
export const DELETE: APIRoute = async ({ url, locals }) => {
  if (!canWrite(locals.user!)) return json(403, { error: "read-only account" });

  const path = url.searchParams.get("path");
  if (!path) return json(400, { error: "path is required" });

  try {
    const root = rootDirFor(locals.user);
    const rootRelPath = absToRootRel(resolveInDir(root, path));
    await softDelete(locals.user!.id, rootRelPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: e.message });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "not found" });
    throw e;
  }

  return json(200, { ok: true });
};

// renames or moves a file or folder - "to" is the full destination path, so a plain
// rename is just "to" sharing the same parent as "path"
export const PATCH: APIRoute = async ({ request, locals }) => {
  if (!canWrite(locals.user!)) return json(403, { error: "read-only account" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { path, to } = (body ?? {}) as { path?: unknown; to?: unknown };
  if (typeof path !== "string" || !path) return json(400, { error: "path is required" });
  if (typeof to !== "string" || !to) return json(400, { error: "to is required" });

  let rootRelFrom: string;
  let rootRelTo: string;
  try {
    const root = rootDirFor(locals.user);
    // resolved (and validated as staying within the user's scope) before the move happens,
    // since "path" no longer exists at its old spot to re-resolve afterwards
    rootRelFrom = absToRootRel(resolveInDir(root, path));
    rootRelTo = absToRootRel(resolveInDir(root, to));
    await moveEntry(root, path, to);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: e.message });
    if (e instanceof EntryExistsError) return json(409, { error: e.message });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "not found" });
    throw e;
  }

  await logMove(locals.user!.id, rootRelFrom, rootRelTo);
  return json(200, { ok: true });
};
