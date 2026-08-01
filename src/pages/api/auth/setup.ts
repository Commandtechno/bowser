import type { APIRoute } from "astro";
import {
  createSession,
  hashPassword,
  MIN_PASSWORD_LEN,
  setSessionCookie,
  validatePassword,
  validateUsername
} from "../../../lib/auth";
import { countUsers, createUser } from "../../../lib/db";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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

  const user = await createUser(username, await hashPassword(password), "admin");
  const { token } = await createSession(user.id);
  setSessionCookie(cookies, token);
  return json(200, { ok: true });
};
