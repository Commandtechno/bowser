import { desc, eq, getTableColumns, gt } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { shareLinks, users } from "./db/schema";
import { nowS } from "./time";

export type TShareLink = typeof shareLinks.$inferSelect & { createdByUsername: string };

// every read joins in the creator's username, so the client never has to resolve user ids
const shareLinkQuery = () =>
  db
    .select({ ...getTableColumns(shareLinks), createdByUsername: users.username })
    .from(shareLinks)
    .innerJoin(users, eq(users.id, shareLinks.createdBy));

export const MIN_DURATION_S = 60; // 1 minute
export const MAX_DURATION_S = 10 * 365 * 24 * 60 * 60; // 10 years - a generous ceiling, not "forever"

export const isValidDuration = (durationSeconds: unknown): durationSeconds is number =>
  typeof durationSeconds === "number" &&
  Number.isFinite(durationSeconds) &&
  durationSeconds >= MIN_DURATION_S &&
  durationSeconds <= MAX_DURATION_S;

export const createShareLink = async (path: string, userId: number, durationSeconds: number): Promise<TShareLink> => {
  const token = randomBytes(24).toString("base64url");
  const createdAt = nowS();
  const expiresAt = createdAt + Math.floor(durationSeconds);
  await db.insert(shareLinks).values({ token, path, createdBy: userId, createdAt, expiresAt });
  return (await getShareLink(token))!;
};

export const getShareLink = async (token: string): Promise<TShareLink | null> => {
  const [row] = await shareLinkQuery().where(eq(shareLinks.token, token));
  return row ?? null;
};

export const isShareLinkExpired = (link: TShareLink): boolean => link.expiresAt <= nowS();

// sorted newest-first; expired links are included only when asked for
export const listShareLinks = (includeExpired: boolean): Promise<TShareLink[]> =>
  shareLinkQuery()
    .where(includeExpired ? undefined : gt(shareLinks.expiresAt, nowS()))
    .orderBy(desc(shareLinks.createdAt));

export const deleteShareLink = async (token: string): Promise<void> => {
  await db.delete(shareLinks).where(eq(shareLinks.token, token));
};

// joins a subpath the visitor asked for onto the shared folder's own path - the combined
// string still goes through media.ts's resolveInDir/listDir, which reject any ".."/"."
// segment anywhere in it, so this can't be used to climb back out of the shared folder
export const resolveSharePath = (sharePath: string, subPath: string): string =>
  [...sharePath.split("/").filter(Boolean), ...subPath.split("/").filter(Boolean)].join("/");
