import type { APIRoute } from "astro";
import {
  hashPassword,
  invalidateUserSessions,
  MIN_PASSWORD_LEN,
  validatePassword,
  validateUsername
} from "../../lib/auth";
import { createUser, deleteUser, getUserById, getUserWithHash, listUsers, setAdmin, setPasswordHash } from "../../lib/db";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requireAdmin = (locals: App.Locals): Response | null =>
  locals.user?.isAdmin ? null : json(403, { error: "admin only" });

export const GET: APIRoute = async ({ locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;
  return json(200, { users: await listUsers() });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { username, password, isAdmin } = (body ?? {}) as {
    username?: unknown;
    password?: unknown;
    isAdmin?: unknown;
  };

  if (!validateUsername(username)) return json(400, { error: "username must be 2-32 chars: letters, digits, . _ -" });
  if (!validatePassword(password))
    return json(400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  if (await getUserWithHash(username)) return json(409, { error: "username already taken" });

  const user = await createUser(username, await hashPassword(password), isAdmin === true);
  return json(200, { user });
};

// admin actions on another user: reset password and/or toggle admin
export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { id, password, isAdmin } = (body ?? {}) as { id?: unknown; password?: unknown; isAdmin?: unknown };

  if (typeof id !== "number" || !(await getUserById(id))) return json(404, { error: "no such user" });

  if (password !== undefined) {
    if (!validatePassword(password))
      return json(400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
    await setPasswordHash(id, await hashPassword(password));
    await invalidateUserSessions(id); // force re-login everywhere with the new password
  }

  if (isAdmin !== undefined) {
    if (typeof isAdmin !== "boolean") return json(400, { error: "invalid request" });
    if (id === locals.user!.id) return json(400, { error: "cannot change your own admin status" });
    await setAdmin(id, isAdmin);
  }

  return json(200, { user: await getUserById(id) });
};

export const DELETE: APIRoute = async ({ url, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  const id = Number(url.searchParams.get("id"));
  if (!Number.isInteger(id) || !(await getUserById(id))) return json(404, { error: "no such user" });
  if (id === locals.user!.id) return json(400, { error: "cannot delete yourself" });

  await deleteUser(id); // sessions cascade
  return json(200, { ok: true });
};
