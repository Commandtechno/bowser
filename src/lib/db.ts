import { createClient } from "@libsql/client";
import { and, count, desc, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { alias } from "drizzle-orm/sqlite-core";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  auditLog,
  DEFAULT_ACCENT,
  DEFAULT_PREVIEW_MODE,
  DEFAULT_ROLE,
  DEFAULT_SYNTAX_THEME,
  isValidRole,
  ROLES,
  sessions,
  shareLinks,
  shareServes,
  users,
  type TAuditAction,
  type TRole
} from "./schema";

export { DEFAULT_ACCENT, DEFAULT_PREVIEW_MODE, DEFAULT_ROLE, DEFAULT_SYNTAX_THEME, isValidRole, ROLES };
export type { TAuditAction, TRole };

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

export const db = (globalForDb.__appDb ??= drizzle(client, { schema: { users, sessions, shareLinks, shareServes, auditLog } }));

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

    CREATE TABLE IF NOT EXISTS share_serves (
      token      TEXT PRIMARY KEY REFERENCES share_links(token) ON DELETE CASCADE,
      protocol   TEXT NOT NULL,
      port       INTEGER NOT NULL,
      password   TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_share_serves_token ON share_serves(token);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action     TEXT NOT NULL,
      path       TEXT NOT NULL,
      detail     TEXT,
      undone_at  INTEGER,
      undone_by  INTEGER REFERENCES users(id),
      purged_at  INTEGER,
      purged_by  INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
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

  const hasHomeDir = cols.rows.some(row => row.name === "home_dir");
  if (!hasHomeDir) {
    await client.execute(`ALTER TABLE users ADD COLUMN home_dir TEXT`);
  }
};

const ready = (globalForDb.__appDbReady ??= bootstrap());

export type TUser = {
  id: number;
  username: string;
  role: TRole;
  homeDir: string | null;
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
  homeDir: users.homeDir,
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
  homeDir: string | null;
  accentColor: string;
  syntaxTheme: string;
  previewMode: string;
  hasAvatar: number;
  createdAt: number;
}): TUser => ({
  id: row.id,
  username: row.username,
  role: row.role,
  homeDir: row.homeDir,
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

export const createUser = async (
  username: string,
  passwordHash: string,
  role: TRole,
  homeDir: string | null = null
): Promise<TUser> => {
  await ready;
  const [{ id }] = await db.insert(users).values({ username, passwordHash, role, homeDir }).returning({ id: users.id });
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

export const setHomeDir = async (id: number, homeDir: string | null): Promise<void> => {
  await ready;
  await db.update(users).set({ homeDir }).where(eq(users.id, id));
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

export type TShareLinkWithUser = TShareLinkRow & {
  createdByUsername: string;
  protocol: string | null;
  servePort: number | null;
};

const shareLinkSelection = {
  token: shareLinks.token,
  path: shareLinks.path,
  createdBy: shareLinks.createdBy,
  createdAt: shareLinks.createdAt,
  expiresAt: shareLinks.expiresAt,
  createdByUsername: users.username,
  protocol: shareServes.protocol,
  servePort: shareServes.port
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
    .leftJoin(shareServes, eq(shareServes.token, shareLinks.token))
    .where(eq(shareLinks.token, token));
  return row ?? null;
};

// sorted newest-first; expired links are included only when asked for
export const listShareLinkRows = async (includeExpired: boolean): Promise<TShareLinkWithUser[]> => {
  await ready;
  const base = db
    .select(shareLinkSelection)
    .from(shareLinks)
    .innerJoin(users, eq(users.id, shareLinks.createdBy))
    .leftJoin(shareServes, eq(shareServes.token, shareLinks.token));

  if (includeExpired) return base.orderBy(desc(shareLinks.createdAt));

  const nowS = Math.floor(Date.now() / 1000);
  return base.where(gt(shareLinks.expiresAt, nowS)).orderBy(desc(shareLinks.createdAt));
};

export const deleteShareLinkRow = async (token: string): Promise<void> => {
  await ready;
  await db.delete(shareLinks).where(eq(shareLinks.token, token));
};

// ---- share serves (rclone-backed protocol access for a share link, src/lib/rcloneServe.ts) ----

export type TShareServeRow = { token: string; protocol: string; port: number; password: string };

export const insertShareServe = async (row: TShareServeRow): Promise<void> => {
  await ready;
  await db.insert(shareServes).values(row);
};

export const getShareServe = async (token: string): Promise<TShareServeRow | null> => {
  await ready;
  const [row] = await db
    .select({ token: shareServes.token, protocol: shareServes.protocol, port: shareServes.port, password: shareServes.password })
    .from(shareServes)
    .where(eq(shareServes.token, token));
  return row ?? null;
};

export const deleteShareServe = async (token: string): Promise<void> => {
  await ready;
  await db.delete(shareServes).where(eq(shareServes.token, token));
};

export const updateShareServePort = async (token: string, port: number): Promise<void> => {
  await ready;
  await db.update(shareServes).set({ port }).where(eq(shareServes.token, token));
};

// share serves whose parent share link hasn't expired yet - used to respawn rclone
// processes for still-active shares after a server restart
export const listActiveShareServes = async (): Promise<(TShareServeRow & { path: string; expiresAt: number })[]> => {
  await ready;
  const nowS = Math.floor(Date.now() / 1000);
  return db
    .select({
      token: shareServes.token,
      protocol: shareServes.protocol,
      port: shareServes.port,
      password: shareServes.password,
      path: shareLinks.path,
      expiresAt: shareLinks.expiresAt
    })
    .from(shareServes)
    .innerJoin(shareLinks, eq(shareLinks.token, shareServes.token))
    .where(gt(shareLinks.expiresAt, nowS));
};

// tokens of share_serves rows whose parent share link has already expired - covers shares
// that expired while the server was down and so were never picked up by
// listActiveShareServes/reconciliation in the first place; the periodic sweep in
// rcloneServe.ts uses this (not just its in-memory process map) so those rows don't leak
export const listExpiredShareServeTokens = async (): Promise<string[]> => {
  await ready;
  const nowS = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({ token: shareServes.token })
    .from(shareServes)
    .innerJoin(shareLinks, eq(shareLinks.token, shareServes.token))
    .where(lte(shareLinks.expiresAt, nowS));
  return rows.map(row => row.token);
};

// ---- audit log / trash (backing store for src/lib/auditLog.ts) ----

const undoneByUser = alias(users, "undone_by_user");
const purgedByUser = alias(users, "purged_by_user");

export type TAuditLogRow = {
  id: number;
  userId: number;
  username: string;
  action: TAuditAction;
  path: string;
  detail: string | null;
  undoneAt: number | null;
  undoneBy: number | null;
  undoneByUsername: string | null;
  purgedAt: number | null;
  purgedBy: number | null;
  purgedByUsername: string | null;
  createdAt: number;
};

// every read joins in usernames directly (rather than leaving the client to resolve user ids)
// since the audit log/trash are viewable by readonly accounts too, who can't hit the
// admin-only /api/users to look names up themselves
const auditLogSelection = {
  id: auditLog.id,
  userId: auditLog.userId,
  username: users.username,
  action: auditLog.action,
  path: auditLog.path,
  detail: auditLog.detail,
  undoneAt: auditLog.undoneAt,
  undoneBy: auditLog.undoneBy,
  undoneByUsername: undoneByUser.username,
  purgedAt: auditLog.purgedAt,
  purgedBy: auditLog.purgedBy,
  purgedByUsername: purgedByUser.username,
  createdAt: auditLog.createdAt
};

export const insertAuditLog = async (row: {
  userId: number;
  action: TAuditAction;
  path: string;
  detail: string | null;
}): Promise<number> => {
  await ready;
  const [{ id }] = await db.insert(auditLog).values(row).returning({ id: auditLog.id });
  return id;
};

export const getAuditLogRow = async (id: number): Promise<TAuditLogRow | null> => {
  await ready;
  const [row] = await db
    .select(auditLogSelection)
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(undoneByUser, eq(undoneByUser.id, auditLog.undoneBy))
    .leftJoin(purgedByUser, eq(purgedByUser.id, auditLog.purgedBy))
    .where(eq(auditLog.id, id));
  return row ?? null;
};

// newest-first, cursor-paginated for the settings History tab
export const listAuditLogRows = async (opts: { beforeId?: number; limit: number }): Promise<TAuditLogRow[]> => {
  await ready;
  const base = db
    .select(auditLogSelection)
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(undoneByUser, eq(undoneByUser.id, auditLog.undoneBy))
    .leftJoin(purgedByUser, eq(purgedByUser.id, auditLog.purgedBy));

  return (opts.beforeId !== undefined ? base.where(sql`${auditLog.id} < ${opts.beforeId}`) : base)
    .orderBy(desc(auditLog.id))
    .limit(opts.limit);
};

// active (not yet undone, and not a terminal purge) rows newer than `id`, newest-first -
// the "everything that happened after this point" set that a revert-to-here cascade walks
export const listAuditLogAfter = async (id: number): Promise<TAuditLogRow[]> => {
  await ready;
  return db
    .select(auditLogSelection)
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(undoneByUser, eq(undoneByUser.id, auditLog.undoneBy))
    .leftJoin(purgedByUser, eq(purgedByUser.id, auditLog.purgedBy))
    .where(and(gt(auditLog.id, id), isNull(auditLog.undoneAt), ne(auditLog.action, "purge")))
    .orderBy(desc(auditLog.id));
};

// currently-trashed items: deletes that haven't been restored or permanently purged
export const listActiveTrash = async (): Promise<TAuditLogRow[]> => {
  await ready;
  return db
    .select(auditLogSelection)
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(undoneByUser, eq(undoneByUser.id, auditLog.undoneBy))
    .leftJoin(purgedByUser, eq(purgedByUser.id, auditLog.purgedBy))
    .where(and(eq(auditLog.action, "delete"), isNull(auditLog.undoneAt), isNull(auditLog.purgedAt)))
    .orderBy(desc(auditLog.id));
};

export const markAuditLogUndone = async (id: number, userId: number): Promise<void> => {
  await ready;
  await db.update(auditLog).set({ undoneAt: Math.floor(Date.now() / 1000), undoneBy: userId }).where(eq(auditLog.id, id));
};

export const markAuditLogPurged = async (id: number, userId: number): Promise<void> => {
  await ready;
  await db.update(auditLog).set({ purgedAt: Math.floor(Date.now() / 1000), purgedBy: userId }).where(eq(auditLog.id, id));
};
