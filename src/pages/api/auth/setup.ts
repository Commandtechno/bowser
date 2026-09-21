import type { APIRoute } from "astro";
import {
  createSession,
  hashPassword,
  MIN_PASSWORD_LEN,
  setSessionCookie,
  validatePassword,
  validateUsername
} from "../../../lib/auth";
import { json } from "../../../lib/http";
import { countUsers, createUser } from "../../../lib/users";

// creates the first (admin) account; only available while the users table is empty
export const POST: APIRoute = async ({ request, cookies }) => {
  if ((await countUsers()) > 0) return json(403, { error: "setup already completed" });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (!validateUsername(username))
    return json(400, { error: "username must be 2-32 chars: letters, digits, . _ -" });
  if (!validatePassword(password))
    return json(400, { error: `password must be at least ${MIN_PASSWORD_LEN} characters` });

  const user = await createUser({ username, passwordHash: await hashPassword(password), role: "admin", homeDir: null });
  const { token } = await createSession(user.id);
  setSessionCookie(cookies, token);
  return json(200, { ok: true });
};
