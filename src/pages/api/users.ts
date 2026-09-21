import type { APIRoute } from "astro";
import {
  hashPassword,
  invalidateUserSessions,
  MIN_PASSWORD_LEN,
  validatePassword,
  validateUsername
} from "../../lib/auth";
import { InvalidPathError, validateHomeDir } from "../../lib/media";
import { DEFAULT_ROLE, isValidRole, ROLES } from "../../lib/roles";
import { createUser, deleteUser, getUserById, getUserWithHash, listUsers, updateUser } from "../../lib/users";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const requireAdmin = (locals: App.Locals): Response | null =>
  locals.user?.role === "admin" ? null : json(403, { error: "admin only" });

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
  const { username, password, role, homeDir } = (body ?? {}) as {
    username?: unknown;
    password?: unknown;
    role?: unknown;
    homeDir?: unknown;
  };

  if (!validateUsername(username)) return json(400, { error: "username must be 2-32 chars: letters, digits, . _ -" });
  if (!validatePassword(password))
    return json(400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  if (role !== undefined && !isValidRole(role)) return json(400, { error: `role must be one of ${ROLES.join(", ")}` });
  if (await getUserWithHash(username)) return json(409, { error: "username already taken" });

  const targetRole = isValidRole(role) ? role : DEFAULT_ROLE;
  let normalizedHomeDir: string | null = null;
  if (homeDir !== undefined && homeDir !== null && homeDir !== "") {
    if (typeof homeDir !== "string") return json(400, { error: "homeDir must be a string" });
    if (targetRole === "admin") return json(400, { error: "admins cannot be restricted to a folder" });
    try {
      normalizedHomeDir = await validateHomeDir(homeDir);
    } catch (e) {
      if (e instanceof InvalidPathError) return json(400, { error: e.message });
      throw e;
    }
  }

  const user = await createUser({
    username,
    passwordHash: await hashPassword(password),
    role: targetRole,
    homeDir: normalizedHomeDir
  });
  return json(200, { user });
};

// admin actions on another user: reset password and/or change role
export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = requireAdmin(locals);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { id, password, role, homeDir } = (body ?? {}) as {
    id?: unknown;
    password?: unknown;
    role?: unknown;
    homeDir?: unknown;
  };

  if (typeof id !== "number") return json(404, { error: "no such user" });
  const existing = await getUserById(id);
  if (!existing) return json(404, { error: "no such user" });

  if (password !== undefined) {
    if (!validatePassword(password))
      return json(400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
    await updateUser(id, { passwordHash: await hashPassword(password) });
    await invalidateUserSessions(id); // force re-login everywhere with the new password
  }

  if (role !== undefined) {
    if (!isValidRole(role)) return json(400, { error: `role must be one of ${ROLES.join(", ")}` });
    if (id === locals.user!.id) return json(400, { error: "cannot change your own role" });
    await updateUser(id, { role });
    // becoming admin always lifts any restriction - admins are never restricted to a folder
    if (role === "admin" && homeDir === undefined && existing.homeDir) await updateUser(id, { homeDir: null });
  }

  if (homeDir !== undefined) {
    if (homeDir === null || homeDir === "") {
      await updateUser(id, { homeDir: null });
    } else if (typeof homeDir !== "string") {
      return json(400, { error: "homeDir must be a string" });
    } else {
      const effectiveRole = isValidRole(role) ? role : existing.role;
      if (effectiveRole === "admin") return json(400, { error: "admins cannot be restricted to a folder" });
      try {
        await updateUser(id, { homeDir: await validateHomeDir(homeDir) });
      } catch (e) {
        if (e instanceof InvalidPathError) return json(400, { error: e.message });
        throw e;
      }
    }
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
