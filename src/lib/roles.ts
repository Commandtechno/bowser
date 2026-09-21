// readonly: browse/view/download only. member: also create/rename/move/delete files and
// folders, and create share links. admin: also manage users and any share link.
export const ROLES = ["readonly", "member", "admin"] as const;
export type TRole = (typeof ROLES)[number];
export const DEFAULT_ROLE: TRole = "member";

export const isValidRole = (value: unknown): value is TRole => (ROLES as readonly unknown[]).includes(value);

export const canWrite = (user: { role: TRole }): boolean => user.role !== "readonly";
