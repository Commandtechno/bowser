import type { APIRoute } from "astro";
import { logUpload } from "../../lib/auditLog";
import { canWrite } from "../../lib/roles";
import { absToRootRel, InvalidPathError, resolveInDir, rootDirFor, writeUploadedFile } from "../../lib/media";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// uploads a single file, streamed straight to disk - "path" is the full destination path
// (parent dirs + file name) within ROOT_DIR, so drag-dropped folders can be reproduced by
// just giving each file its own nested path; missing parent dirs are created automatically
export const PUT: APIRoute = async ({ request, url, locals }) => {
  if (!canWrite(locals.user!)) return json(403, { error: "read-only account" });

  const path = url.searchParams.get("path");
  if (!path) return json(400, { error: "path is required" });
  if (!request.body) return json(400, { error: "missing body" });

  try {
    const root = rootDirFor(locals.user);
    const { name, size } = await writeUploadedFile(root, path, request.body);
    const parentRel = path.split("/").filter(Boolean).slice(0, -1).join("/");
    const rootRelParent = absToRootRel(resolveInDir(root, parentRel));
    await logUpload(locals.user!.id, rootRelParent ? `${rootRelParent}/${name}` : name, size);
    return json(201, { ok: true, name });
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: e.message });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "parent folder not found" });
    throw e;
  }
};
