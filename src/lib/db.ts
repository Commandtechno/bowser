import { createClient } from "@libsql/client";
import { and, count, desc, eq, gt, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_ACCENT,
  DEFAULT_PREVIEW_MODE,
  DEFAULT_ROLE,
  DEFAULT_SYNTAX_THEME,
  isValidRole,
  ROLES,
  sessions,
  shareLinks,
  users,
  type TRole
} from "./schema";

export { DEFAULT_ACCENT, DEFAULT_PREVIEW_MODE, DEFAULT_ROLE, DEFAULT_SYNTAX_THEME, isValidRole, ROLES };
export type { TRole };

// readonly accounts can browse/view/download but can't touch the filesystem or share links
export const canWrite = (user: { role: TRole }): boolean => user.role !== "readonly";

const DB_PATH = resolve(import.meta.env.DB_PATH || "./data/app.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });

// keep a single connection across dev-server module reloads
const globalForDb = globalThis as unknown as {
  __appDb?: ReturnType<typeof drizzle>;
  __appDbReady?: Promise<void>;
};

export const db = (globalForDb.__appDb ??= drizzle(client, { schema: { users, sessions, shareLinks } }));

// no migration system - bootstrap runs on every boot and patches pre-existing db files
const bootstrap = async (): Promise<void> => {
  await client.executeMultiple(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT '${DEFAULT_ROLE}',
      accent_color  TEXT NOT NULL DEFAULT '${DEFAULT_ACCENT}',
      syntax_theme  TEXT NOT NULL DEFAULT '${DEFAULT_SYNTAX_THEME}',
      preview_mode  TEXT NOT NULL DEFAULT '${DEFAULT_PREVIEW_MODE}',
      avatar        BLOB,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS share_links (
      token      TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_share_links_created_by ON share_links(created_by);
    CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON share_links(expires_at);
  `);

  const cols = await client.execute("PRAGMA table_info(users)");
  const hasPreviewMode = cols.rows.some(row => row.name === "preview_mode");
  if (!hasPreviewMode) {
    await client.execute(`ALTER TABLE users ADD COLUMN preview_mode TEXT NOT NULL DEFAULT '${DEFAULT_PREVIEW_MODE}'`);
  }

  // upgrading from the old boolean is_admin column - the column itself is left in place
  // (unused going forward) rather than dropped, matching this file's additive-only approach
  const hasRole = cols.rows.some(row => row.name === "role");
  const hasIsAdmin = cols.rows.some(row => row.name === "is_admin");
  if (!hasRole) {
    await client.execute(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT '${DEFAULT_ROLE}'`);
    if (hasIsAdmin) await client.execute(`UPDATE users SET role = 'admin' WHERE is_admin = 1`);
  }
};

const ready = (globalForDb.__appDbReady ??= bootstrap());

export type TUser = {
  id: number;
  username: string;
  role: TRole;
  accentColor: string;
  syntaxTheme: string;
  previewMode: string;
  hasAvatar: boolean;
  createdAt: number;
};

const userSelection = {
  id: users.id,
  username: users.username,
  passwordHash: users.passwordHash,
  role: users.role,
  accentColor: users.accentColor,
  syntaxTheme: users.syntaxTheme,
  previewMode: users.previewMode,
  hasAvatar: sql<number>`(${users.avatar} is not null)`,
  createdAt: users.createdAt
};

const toUser = (row: {
  id: number;
  username: string;
  role: TRole;
  accentColor: string;
  syntaxTheme: string;
  previewMode: string;
  hasAvatar: number;
  createdAt: number;
}): TUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  accentColor: row.accentColor,
  syntaxTheme: row.syntaxTheme,
  previewMode: row.previewMode,
  hasAvatar: row.hasAvatar === 1,
  createdAt: row.createdAt
});

export const countUsers = async (): Promise<number> => {
  await ready;
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
};

export const getUserById = async (id: number): Promise<TUser | null> => {
  await ready;
  const [row] = await db.select(userSelection).from(users).where(eq(users.id, id));
  return row ? toUser(row) : null;
};

export const getUserWithHash = async (username: string): Promise<{ user: TUser; passwordHash: string } | null> => {
  await ready;
  const [row] = await db.select(userSelection).from(users).where(eq(users.username, username));
  return row ? { user: toUser(row), passwordHash: row.passwordHash } : null;
};

export const getPasswordHash = async (id: number): Promise<string | null> => {
  await ready;
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, id));
  return row?.passwordHash ?? null;
};

export const listUsers = async (): Promise<TUser[]> => {
  await ready;
  const rows = await db.select(userSelection).from(users).orderBy(users.id);
  return rows.map(toUser);
};

export const createUser = async (username: string, passwordHash: string, role: TRole): Promise<TUser> => {
  await ready;
  const [{ id }] = await db.insert(users).values({ username, passwordHash, role }).returning({ id: users.id });
  return (await getUserById(id))!;
};

export const deleteUser = async (id: number): Promise<void> => {
  await ready;
  await db.delete(users).where(eq(users.id, id));
};

export const setPasswordHash = async (id: number, passwordHash: string): Promise<void> => {
  await ready;
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
};

export const setRole = async (id: number, role: TRole): Promise<void> => {
  await ready;
  await db.update(users).set({ role }).where(eq(users.id, id));
};

export const setAccentColor = async (id: number, accentColor: string): Promise<void> => {
  await ready;
  await db.update(users).set({ accentColor }).where(eq(users.id, id));
};

export const setSyntaxTheme = async (id: number, syntaxTheme: string): Promise<void> => {
  await ready;
  await db.update(users).set({ syntaxTheme }).where(eq(users.id, id));
};

export const setPreviewMode = async (id: number, previewMode: string): Promise<void> => {
  await ready;
  await db.update(users).set({ previewMode }).where(eq(users.id, id));
};

export const setAvatar = async (id: number, avatar: Buffer | null): Promise<void> => {
  await ready;
  await db.update(users).set({ avatar }).where(eq(users.id, id));
};

export const getAvatar = async (id: number): Promise<Buffer | null> => {
  await ready;
  const [row] = await db.select({ avatar: users.avatar }).from(users).where(eq(users.id, id));
  return row?.avatar ?? null;
};

// ---- sessions (backing store for src/lib/auth.ts) ----

export type TSessionRow = { id: string; userId: number; expiresAt: number };

export const insertSession = async (session: TSessionRow): Promise<void> => {
  await ready;
  await db.insert(sessions).values(session);
};

export const getSession = async (id: string): Promise<TSessionRow | null> => {
  await ready;
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(eq(sessions.id, id));
  return row ?? null;
};

export const deleteSession = async (id: string): Promise<void> => {
  await ready;
  await db.delete(sessions).where(eq(sessions.id, id));
};

export const updateSessionExpiry = async (id: string, expiresAt: number): Promise<void> => {
  await ready;
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
};

export const deleteOtherSessions = async (userId: number, keepId: string): Promise<void> => {
  await ready;
  await db.delete(sessions).where(and(eq(sessions.userId, userId), ne(sessions.id, keepId)));
};

export const deleteUserSessions = async (userId: number): Promise<void> => {
  await ready;
  await db.delete(sessions).where(eq(sessions.userId, userId));
};

// ---- share links (backing store for src/lib/shareLinks.ts) ----

export type TShareLinkRow = {
  token: string;
  path: string;
  createdBy: number;
  createdAt: number;
  expiresAt: number;
};

export type TShareLinkWithUser = TShareLinkRow & { createdByUsername: string };

const shareLinkSelection = {
  token: shareLinks.token,
  path: shareLinks.path,
  createdBy: shareLinks.createdBy,
  createdAt: shareLinks.createdAt,
  expiresAt: shareLinks.expiresAt,
  createdByUsername: users.username
};

export const insertShareLink = async (row: TShareLinkRow): Promise<void> => {
  await ready;
  await db.insert(shareLinks).values(row);
};

export const getShareLinkRow = async (token: string): Promise<TShareLinkWithUser | null> => {
  await ready;
  const [row] = await db
    .select(shareLinkSelection)
    .from(shareLinks)
    .innerJoin(users, eq(users.id, shareLinks.createdBy))
    .where(eq(shareLinks.token, token));
  return row ?? null;
};

// sorted newest-first; expired links are included only when asked for
export const listShareLinkRows = async (includeExpired: boolean): Promise<TShareLinkWithUser[]> => {
  await ready;
  const base = db
    .select(shareLinkSelection)
    .from(shareLinks)
    .innerJoin(users, eq(users.id, shareLinks.createdBy));

  if (includeExpired) return base.orderBy(desc(shareLinks.createdAt));

  const nowS = Math.floor(Date.now() / 1000);
  return base.where(gt(shareLinks.expiresAt, nowS)).orderBy(desc(shareLinks.createdAt));
};

export const deleteShareLinkRow = async (token: string): Promise<void> => {
  await ready;
  await db.delete(shareLinks).where(eq(shareLinks.token, token));
};
