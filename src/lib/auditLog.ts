// action logging + the trash/revert engine - pairs media.ts (the actual filesystem layer)
// with the audit_log table. API routes call the functions here rather than media.ts directly for anything mutating,
// so every create/upload/move/delete is logged in the same transaction-of-intent as the fs op.

import { and, desc, eq, getTableColumns, gt, isNull, lt, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { db } from "./db";
import { auditLog, users, type TAuditAction } from "./db/schema";
import { homeRelative, InvalidPathError, moveEntry, ROOT_DIR, resolveInDir, TRASH_DIR, uniqueName } from "./media";
import { nowS } from "./time";

const undoneByUser = alias(users, "undone_by_user");
const purgedByUser = alias(users, "purged_by_user");

// every read joins in usernames directly (rather than leaving the client to resolve user ids)
// since the audit log/trash are viewable by readonly accounts too, who can't hit the
// admin-only /api/users to look names up themselves
const auditLogQuery = () =>
  db
    .select({
      ...getTableColumns(auditLog),
      username: users.username,
      undoneByUsername: undoneByUser.username,
      purgedByUsername: purgedByUser.username
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(undoneByUser, eq(undoneByUser.id, auditLog.undoneBy))
    .leftJoin(purgedByUser, eq(purgedByUser.id, auditLog.purgedBy));

export type TAuditLogRow = Awaited<ReturnType<typeof auditLogQuery>>[number];

type TDeleteDetail = { trashId: string; isDir: boolean; size: number | null };
type TMoveDetail = { from: string; to: string };
type TRestoreDetail = { trashId: string; fromLogId: number; restoredPath: string };
type TPurgeDetail = { trashId: string; fromLogId: number };
type TUploadDetail = { size: number };

export class NotRevertibleError extends Error {}

const parentOf = (relPath: string): string => relPath.split("/").slice(0, -1).join("/");

const insert = async (userId: number, action: TAuditAction, path: string, detail: unknown): Promise<number> => {
  const [{ id }] = await db
    .insert(auditLog)
    .values({ userId, action, path, detail: detail == null ? null : JSON.stringify(detail) })
    .returning({ id: auditLog.id });
  return id;
};

const detailOf = <T>(row: TAuditLogRow): T => JSON.parse(row.detail!) as T;

const getAuditLogRow = async (id: number): Promise<TAuditLogRow | null> => {
  const [row] = await auditLogQuery().where(eq(auditLog.id, id));
  return row ?? null;
};

const markUndone = async (id: number, userId: number): Promise<void> => {
  await db.update(auditLog).set({ undoneAt: nowS(), undoneBy: userId }).where(eq(auditLog.id, id));
};

const markPurged = async (id: number, userId: number): Promise<void> => {
  await db.update(auditLog).set({ purgedAt: nowS(), purgedBy: userId }).where(eq(auditLog.id, id));
};

// ---- reads, viewable by every signed-in user (History/Trash tabs) ----

// newest-first, cursor-paginated for the settings History tab
export const listAuditLogRows = (opts: { beforeId?: number; limit: number }): Promise<TAuditLogRow[]> =>
  auditLogQuery()
    .where(opts.beforeId !== undefined ? lt(auditLog.id, opts.beforeId) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(opts.limit);

// currently-trashed items: deletes that haven't been restored or permanently purged
export const listActiveTrash = (): Promise<TAuditLogRow[]> =>
  auditLogQuery()
    .where(and(eq(auditLog.action, "delete"), isNull(auditLog.undoneAt), isNull(auditLog.purgedAt)))
    .orderBy(desc(auditLog.id));

// active (not yet undone, and not a terminal purge) rows newer than `id`, newest-first -
// the "everything that happened after this point" set that a revert-to-here cascade walks
const listAuditLogAfter = (id: number): Promise<TAuditLogRow[]> =>
  auditLogQuery()
    .where(and(gt(auditLog.id, id), isNull(auditLog.undoneAt), ne(auditLog.action, "purge")))
    .orderBy(desc(auditLog.id));

// restricted users (see users.homeDir) only see rows that touch their own home dir - every
// path-shaped field (the top-level `path`, plus move/restore's detail fields) is translated
// to be relative to their home, and rows that don't intersect it at all are dropped. Admins
// are always unrestricted (homeDir null), so this is a no-op for them
export const scopeAuditRows = (rows: TAuditLogRow[], homeDir: string | null): TAuditLogRow[] => {
  if (!homeDir) return rows;

  const scoped: TAuditLogRow[] = [];
  for (const row of rows) {
    const path = homeRelative(homeDir, row.path);
    if (path === null) continue;

    let detail = row.detail;
    if (detail) {
      const parsed = JSON.parse(detail) as Record<string, unknown>;
      for (const key of ["from", "to", "restoredPath"]) {
        if (typeof parsed[key] === "string") parsed[key] = homeRelative(homeDir, parsed[key] as string) ?? parsed[key];
      }
      detail = JSON.stringify(parsed);
    }

    scoped.push({ ...row, path, detail });
  }
  return scoped;
};

// ---- plain logging, called by API routes right after the corresponding media.ts op succeeds ----

export const logCreateFolder = (userId: number, path: string): Promise<number> => insert(userId, "create_folder", path, null);

export const logUpload = (userId: number, path: string, size: number): Promise<number> =>
  insert(userId, "upload", path, { size } satisfies TUploadDetail);

export const logMove = (userId: number, from: string, to: string): Promise<number> =>
  insert(userId, "move", to, { from, to } satisfies TMoveDetail);

// ---- trash: soft-delete / restore / purge ----

// moves `path` into TRASH_DIR under a fresh uuid and logs a `delete` row - used both by
// DELETE /api/entry and as the inverse of create_folder/upload/restore during a revert
export const softDelete = async (userId: number, path: string): Promise<number> => {
  const targetPath = resolveInDir(ROOT_DIR, path);
  if (targetPath === ROOT_DIR) throw new InvalidPathError("cannot delete the root directory");

  const st = await stat(targetPath);
  const isDir = st.isDirectory();
  const trashId = randomUUID();

  await mkdir(TRASH_DIR, { recursive: true });
  await rename(targetPath, join(TRASH_DIR, trashId));

  return insert(userId, "delete", path, { trashId, isDir, size: isDir ? null : st.size } satisfies TDeleteDetail);
};

// restores a specific `delete` log entry back to (as close as possible to) its original path -
// the parent dir is recreated if it no longer exists, and the destination gets a
// uniqueName()-style " (2)" suffix if something now occupies the original spot
export const restoreFromTrash = async (userId: number, logId: number): Promise<{ newLogId: number; path: string }> => {
  const row = await getAuditLogRow(logId);
  if (!row || row.action !== "delete") throw new NotRevertibleError("not a trash entry");
  if (row.undoneAt) throw new NotRevertibleError("already restored");
  if (row.purgedAt) throw new NotRevertibleError("permanently deleted, cannot be restored");

  const { trashId } = detailOf<TDeleteDetail>(row);
  const parentRel = parentOf(row.path);
  const parentAbs = resolveInDir(ROOT_DIR, parentRel);
  await mkdir(parentAbs, { recursive: true });

  const name = await uniqueName(parentAbs, basename(row.path));
  const restoredPath = parentRel ? `${parentRel}/${name}` : name;

  await rename(join(TRASH_DIR, trashId), join(parentAbs, name));
  await markUndone(logId, userId);
  const newLogId = await insert(userId, "restore", restoredPath, {
    trashId,
    fromLogId: logId,
    restoredPath
  } satisfies TRestoreDetail);

  return { newLogId, path: restoredPath };
};

// permanently deletes one trashed entry - terminal, never itself revertible
export const purgeTrashEntry = async (userId: number, logId: number): Promise<number> => {
  const row = await getAuditLogRow(logId);
  if (!row || row.action !== "delete") throw new NotRevertibleError("not a trash entry");
  if (row.undoneAt) throw new NotRevertibleError("already restored");
  if (row.purgedAt) throw new NotRevertibleError("already purged");

  const { trashId } = detailOf<TDeleteDetail>(row);
  await rm(join(TRASH_DIR, trashId), { recursive: true, force: true });
  await markPurged(logId, userId);
  return insert(userId, "purge", row.path, { trashId, fromLogId: logId } satisfies TPurgeDetail);
};

export const purgeAllTrash = async (userId: number): Promise<number> => {
  const rows = await listActiveTrash();
  for (const row of rows) await purgeTrashEntry(userId, row.id);
  return rows.length;
};

// ---- revert engine ----

// undoes a single log entry by performing its inverse operation, then marks it undone and
// records the inverse as a new log row - so the log stays an honest, append-only trail
export const revertEntry = async (userId: number, logId: number): Promise<number> => {
  const row = await getAuditLogRow(logId);
  if (!row) throw new NotRevertibleError("not found");
  if (row.undoneAt) throw new NotRevertibleError("already reverted");
  if (row.purgedAt || row.action === "purge") throw new NotRevertibleError("permanently deleted, cannot be reverted");

  switch (row.action) {
    case "create_folder":
    case "upload": {
      const newLogId = await softDelete(userId, row.path);
      await markUndone(logId, userId);
      return newLogId;
    }
    case "move": {
      const { from, to } = detailOf<TMoveDetail>(row);
      await moveEntry(ROOT_DIR, to, from);
      const newLogId = await insert(userId, "move", from, { from: to, to: from } satisfies TMoveDetail);
      await markUndone(logId, userId);
      return newLogId;
    }
    case "delete": {
      const { newLogId } = await restoreFromTrash(userId, logId);
      return newLogId;
    }
    case "restore": {
      const { restoredPath } = detailOf<TRestoreDetail>(row);
      const newLogId = await softDelete(userId, restoredPath);
      await markUndone(logId, userId);
      return newLogId;
    }
    default:
      throw new NotRevertibleError(`don't know how to revert "${row.action}"`);
  }
};

export type TRevertResult = { reverted: number[]; failedAt?: { id: number; error: string } };

// "revert to any point" - undoes everything that happened after `targetLogId`, newest-first,
// stopping at the first failure so the log always reflects a coherent, in-order rewind
export const revertToPoint = async (userId: number, targetLogId: number): Promise<TRevertResult> => {
  const rows = await listAuditLogAfter(targetLogId);
  const reverted: number[] = [];
  for (const row of rows) {
    try {
      await revertEntry(userId, row.id);
      reverted.push(row.id);
    } catch (e) {
      return { reverted, failedAt: { id: row.id, error: (e as Error).message } };
    }
  }
  return { reverted };
};
