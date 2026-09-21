import type { APIRoute } from "astro";
import { burnVerify, createSession, setSessionCookie, validateUsername, verifyPassword } from "../../../lib/auth";
import { json } from "../../../lib/http";
import { getUserWithHash } from "../../../lib/users";

// naive in-memory brute-force throttle: 5 bad tries per username locks it for 60s
const FAIL_LIMIT = 5;
const LOCKOUT_MS = 60_000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

export const POST: APIRoute = async ({ request, cookies }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (!validateUsername(username) || typeof password !== "string" || password.length === 0)
    return json(400, { error: "invalid username or password" });

  const key = username.toLowerCase();
  const entry = failures.get(key);
  if (entry && entry.lockedUntil > Date.now())
    return json(429, { error: `too many attempts - try again in ${Math.ceil((entry.lockedUntil - Date.now()) / 1000)}s` });

  const found = await getUserWithHash(username);
  const ok = found ? await verifyPassword(found.passwordHash, password) : await burnVerify();

  if (!ok || !found) {
    const next = { count: (entry?.count ?? 0) + 1, lockedUntil: 0 };
    if (next.count >= FAIL_LIMIT) {
      next.lockedUntil = Date.now() + LOCKOUT_MS;
      next.count = 0;
    }
    failures.set(key, next);
    return json(401, { error: "invalid username or password" });
  }

  failures.delete(key);
  const { token } = await createSession(found.user.id);
  setSessionCookie(cookies, token);
  return json(200, { ok: true });
};
