import type { APIRoute } from "astro";
import { canWrite } from "../../lib/db";
import { createFolder, InvalidPathError, PHOTOS_DIR } from "../../lib/media";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

  try {
    await createFolder(PHOTOS_DIR, path);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: e.message });
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return json(409, { error: "a folder with that name already exists" });
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return json(404, { error: "parent folder not found" });
    throw e;
  }

  return json(201, { ok: true });
};
