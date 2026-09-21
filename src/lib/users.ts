import { count, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "./db";
import { users } from "./db/schema";

const { passwordHash: _passwordHash, avatar: _avatar, ...publicColumns } = getTableColumns(users);

// everything that's safe to hand to the client - no hash, and the avatar blob collapsed to a flag
const userColumns = {
  ...publicColumns,
  hasAvatar: sql`(${users.avatar} is not null)`.mapWith(Boolean)
};

type TUserRow = typeof users.$inferSelect;
export type TUser = Omit<TUserRow, "passwordHash" | "avatar"> & { hasAvatar: boolean };

export const countUsers = async (): Promise<number> => {
  const [row] = await db.select({ n: count() }).from(users);
  return row?.n ?? 0;
};

export const getUserById = async (id: number): Promise<TUser | null> => {
  const [row] = await db.select(userColumns).from(users).where(eq(users.id, id));
  return row ?? null;
};

export const getUserWithHash = async (username: string): Promise<{ user: TUser; passwordHash: string } | null> => {
  const [row] = await db
    .select({ ...userColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, username));
  if (!row) return null;
  const { passwordHash, ...user } = row;
  return { user, passwordHash };
};

export const getPasswordHash = async (id: number): Promise<string | null> => {
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, id));
  return row?.passwordHash ?? null;
};

export const listUsers = (): Promise<TUser[]> => db.select(userColumns).from(users).orderBy(users.id);

export const createUser = async (values: Pick<TUserRow, "username" | "passwordHash" | "role" | "homeDir">): Promise<TUser> => {
  const [user] = await db.insert(users).values(values).returning(userColumns);
  return user;
};

export const updateUser = async (id: number, patch: Partial<Omit<TUserRow, "id" | "createdAt">>): Promise<void> => {
  await db.update(users).set(patch).where(eq(users.id, id));
};

export const deleteUser = async (id: number): Promise<void> => {
  await db.delete(users).where(eq(users.id, id));
};

export const getAvatar = async (id: number): Promise<Buffer | null> => {
  const [row] = await db.select({ avatar: users.avatar }).from(users).where(eq(users.id, id));
  return row?.avatar ?? null;
};
