import type { APIRoute } from "astro";
import { getMeta } from "../../lib/meta";
import { classifyMedia } from "../../lib/mediaKind";
import { InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const GET: APIRoute = async ({ url, locals }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return json(400, { error: "path is required" });

  let filePath: string;
  try {
    filePath = resolveInDir(rootDirFor(locals.user), relPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return json(400, { error: "invalid path" });
    throw e;
  }

  const kind = classifyMedia(relPath);
  const fields = await getMeta(kind, filePath);

  return json(200, { fields });
};
