import { randomBytes } from "node:crypto";
import { deleteShareLinkRow, getShareLinkRow, insertShareLink, listShareLinkRows } from "./db";

export type TShareLink = {
  token: string;
  path: string;
  createdBy: number;
  createdByUsername: string;
  createdAt: number;
  expiresAt: number;
  protocol: string | null;
  servePort: number | null;
};

const now = (): number => Math.floor(Date.now() / 1000);

export const MIN_DURATION_S = 60; // 1 minute
export const MAX_DURATION_S = 10 * 365 * 24 * 60 * 60; // 10 years - a generous ceiling, not "forever"

export const isValidDuration = (durationSeconds: unknown): durationSeconds is number =>
  typeof durationSeconds === "number" &&
  Number.isFinite(durationSeconds) &&
  durationSeconds >= MIN_DURATION_S &&
  durationSeconds <= MAX_DURATION_S;

export const createShareLink = async (path: string, userId: number, durationSeconds: number): Promise<TShareLink> => {
  const token = randomBytes(24).toString("base64url");
  const createdAt = now();
  const expiresAt = createdAt + Math.floor(durationSeconds);
  await insertShareLink({ token, path, createdBy: userId, createdAt, expiresAt });
  return (await getShareLink(token))!;
};

export const getShareLink = (token: string): Promise<TShareLink | null> => getShareLinkRow(token);

export const isShareLinkExpired = (link: TShareLink): boolean => link.expiresAt <= now();

export const listShareLinks = (includeExpired: boolean): Promise<TShareLink[]> => listShareLinkRows(includeExpired);

export const deleteShareLink = (token: string): Promise<void> => deleteShareLinkRow(token);

// joins a subpath the visitor asked for onto the shared folder's own path - the combined
// string still goes through media.ts's resolveInDir/listDir, which reject any ".."/"."
// segment anywhere in it, so this can't be used to climb back out of the shared folder
export const resolveSharePath = (sharePath: string, subPath: string): string =>
  [...sharePath.split("/").filter(Boolean), ...subPath.split("/").filter(Boolean)].join("/");
