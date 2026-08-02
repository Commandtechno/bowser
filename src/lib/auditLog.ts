// action logging + the trash/revert engine - wraps media.ts (the actual filesystem layer)
// and db.ts (the audit_log table) the same way shareLinks.ts wraps db.ts's share tables.
// API routes call the functions here rather than media.ts directly for anything mutating,
// so every create/upload/move/delete is logged in the same transaction-of-intent as the fs op.

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  getAuditLogRow,
  insertAuditLog,
  listActiveTrash as listActiveTrashRows,
  listAuditLogAfter,
  listAuditLogRows as listAuditLogRowsFromDb,
  markAuditLogPurged,
  markAuditLogUndone,
  type TAuditLogRow
} from "./db";
import { InvalidPathError, moveEntry, ROOT_DIR, resolveInDir, TRASH_DIR, uniqueName } from "./media";

export type { TAuditLogRow };

type TDeleteDetail = { trashId: string; isDir: boolean; size: number | null };
type TMoveDetail = { from: string; to: string };
type TRestoreDetail = { trashId: string; fromLogId: number; restoredPath: string };
type TPurgeDetail = { trashId: string; fromLogId: number };
type TUploadDetail = { size: number };

export class NotRevertibleError extends Error {}

const parentOf = (relPath: string): string => relPath.split("/").slice(0, -1).join("/");

const insert = (userId: number, action: TAuditLogRow["action"], path: string, detail: unknown): Promise<number> =>
  insertAuditLog({ userId, action, path, detail: detail == null ? null : JSON.stringify(detail) });

const detailOf = <T>(row: TAuditLogRow): T => JSON.parse(row.detail!) as T;

// ---- reads, viewable by every signed-in user (History/Trash tabs) ----

export const listAuditLogRows = (opts: { beforeId?: number; limit: number }): Promise<TAuditLogRow[]> =>
  listAuditLogRowsFromDb(opts);

export const listActiveTrash = (): Promise<TAuditLogRow[]> => listActiveTrashRows();

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
  await markAuditLogUndone(logId, userId);
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
  await markAuditLogPurged(logId, userId);
  return insert(userId, "purge", row.path, { trashId, fromLogId: logId } satisfies TPurgeDetail);
};

export const purgeAllTrash = async (userId: number): Promise<number> => {
  const rows = await listActiveTrashRows();
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
      await markAuditLogUndone(logId, userId);
      return newLogId;
    }
    case "move": {
      const { from, to } = detailOf<TMoveDetail>(row);
      await moveEntry(ROOT_DIR, to, from);
      const newLogId = await insert(userId, "move", from, { from: to, to: from } satisfies TMoveDetail);
      await markAuditLogUndone(logId, userId);
      return newLogId;
    }
    case "delete": {
      const { newLogId } = await restoreFromTrash(userId, logId);
      return newLogId;
    }
    case "restore": {
      const { restoredPath } = detailOf<TRestoreDetail>(row);
      const newLogId = await softDelete(userId, restoredPath);
      await markAuditLogUndone(logId, userId);
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
