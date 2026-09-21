import type { APIRoute } from "astro";
import sharp from "sharp";
import { getAvatar, updateUser } from "../../lib/users";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const AVATAR_SIZE = 128;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// any signed-in user can view any avatar (they're shown in the admin user list)
export const GET: APIRoute = async ({ url }) => {
  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id)) return new Response(null, { status: 400 });

  const avatar = await getAvatar(id);
  if (!avatar) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(avatar), {
    headers: { "content-type": "image/webp", "cache-control": "private, no-cache" }
  });
};

// upload/replace your own profile picture
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: "expected multipart form data" });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json(400, { error: "missing file" });
  if (file.size > MAX_UPLOAD_BYTES) return json(400, { error: "image too large (max 8 MB)" });

  let webp: Buffer;
  try {
    webp = await sharp(Buffer.from(await file.arrayBuffer()))
      .rotate() // respect EXIF orientation
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    return json(400, { error: "could not read image" });
  }

  await updateUser(user.id, { avatar: webp });
  return json(200, { ok: true });
};

export const DELETE: APIRoute = async ({ locals }) => {
  await updateUser(locals.user!.id, { avatar: null });
  return json(200, { ok: true });
};
