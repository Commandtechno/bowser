import type { APIRoute } from "astro";
import { logCreateFolder } from "../../lib/auditLog";
import { json } from "../../lib/http";
import { canWrite } from "../../lib/roles";
import { absToRootRel, createFolder, InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";

export const POST: APIRoute = async ({ request, locals }) => {
  if (!canWrite(locals.user!)) return json(403, { error: "read-only account" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { path } = (body ?? {}) as { path?: unknown };
  if (typeof path !== "string" || !path) return json(400, { error: "path is required" });

  let rootRelPath: string;
  try {
    const root = rootDirFor(locals.user);
    rootRelPath = absToRootRel(resolveInDir(root, path));
    await createFolder(root, path);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: e.message });
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return json(409, { error: "a folder with that name already exists" });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "parent folder not found" });
    throw e;
  }

  await logCreateFolder(locals.user!.id, rootRelPath);
  return json(201, { ok: true });
};
