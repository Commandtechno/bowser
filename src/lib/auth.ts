import { hash, verify } from "@node-rs/argon2";
import type { AstroCookies } from "astro";
import { and, eq, ne } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";
import { sessions } from "./db/schema";
import { nowS } from "./time";
import { getUserById, type TUser } from "./users";

export const SESSION_COOKIE = "session";

const SESSION_TTL_S = 30 * 24 * 60 * 60; // 30 days
const RENEW_BELOW_S = 15 * 24 * 60 * 60; // sliding renewal once under 15 days remain

// sessions are stored by the sha256 of the token, so a leaked db never yields usable cookies
const tokenToId = (token: string): string => createHash("sha256").update(token).digest("hex");

export const hashPassword = (password: string): Promise<string> => hash(password);

export const verifyPassword = (passwordHash: string, password: string): Promise<boolean> =>
  verify(passwordHash, password).catch(() => false);

// used when the username doesn't exist, so both branches cost one argon2 verify (no user enumeration by timing)
const dummyHash = hash("dummy-password-for-timing");
export const burnVerify = async (): Promise<boolean> => verify(await dummyHash, "burn").catch(() => false);

export type TSession = Omit<typeof sessions.$inferSelect, "createdAt">;

export const createSession = async (userId: number): Promise<{ token: string; session: TSession }> => {
  const token = randomBytes(32).toString("base64url");
  const session: TSession = { id: tokenToId(token), userId, expiresAt: nowS() + SESSION_TTL_S };
  await db.insert(sessions).values(session);
  return { token, session };
};

// returns the user for a valid token, extending the expiry when it is past the halfway point
export const validateSessionToken = async (token: string): Promise<{ user: TUser; session: TSession } | null> => {
  const id = tokenToId(token);
  const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
  if (!row) return null;

  if (row.expiresAt <= nowS()) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  const user = await getUserById(row.userId);
  if (!user) return null;

  let expiresAt = row.expiresAt;
  if (expiresAt - nowS() < RENEW_BELOW_S) {
    expiresAt = nowS() + SESSION_TTL_S;
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
  }

  return { user, session: { id, userId: row.userId, expiresAt } };
};

export const invalidateSession = async (token: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.id, tokenToId(token)));
};

// e.g. after a password change: kick every other device
export const invalidateOtherSessions = async (userId: number, keepToken: string): Promise<void> => {
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, tokenToId(keepToken))));
};

export const invalidateUserSessions = async (userId: number): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.userId, userId));
};

export const setSessionCookie = (cookies: AstroCookies, token: string): void => {
  cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false, // served over plain http on the local network
    maxAge: SESSION_TTL_S
  });
};

export const clearSessionCookie = (cookies: AstroCookies): void => {
  cookies.delete(SESSION_COOKIE, { path: "/" });
};

// ---- shared input validation ----

export const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;
export const MIN_PASSWORD_LEN = 8;
export const ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

export const validateUsername = (username: unknown): username is string =>
  typeof username === "string" && USERNAME_RE.test(username);

export const validatePassword = (password: unknown): password is string =>
  typeof password === "string" && password.length >= MIN_PASSWORD_LEN && password.length <= 256;
