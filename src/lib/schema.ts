import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const DEFAULT_ACCENT = "#00ffc1";
export const DEFAULT_SYNTAX_THEME = "github-dark";
export const DEFAULT_PREVIEW_MODE = "panel";

// readonly: browse/view/download only. member: also create/rename/move/delete files and
// folders, and create share links. admin: also manage users and any share link.
export const ROLES = ["readonly", "member", "admin"] as const;
export type TRole = (typeof ROLES)[number];
export const DEFAULT_ROLE: TRole = "member";
export const isValidRole = (value: unknown): value is TRole => (ROLES as readonly unknown[]).includes(value);

// username uniqueness/collation (COLLATE NOCASE) is enforced by the raw DDL in db.ts,
// not expressible through the drizzle-kit column builder
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").$type<TRole>().notNull().default(DEFAULT_ROLE),
  // "/"-joined path relative to ROOT_DIR that this user is confined to (browsing, uploads,
  // share creation, everything) - null means unrestricted. Only meaningful for non-admin
  // roles; admins are always unrestricted, see src/pages/api/users.ts
  homeDir: text("home_dir"),
  accentColor: text("accent_color").notNull().default(DEFAULT_ACCENT),
  syntaxTheme: text("syntax_theme").notNull().default(DEFAULT_SYNTAX_THEME),
  previewMode: text("preview_mode").notNull().default(DEFAULT_PREVIEW_MODE),
  avatar: blob("avatar", { mode: "buffer" }),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`)
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`)
  },
  table => [index("idx_sessions_user").on(table.userId)]
);

export const shareLinks = sqliteTable(
  "share_links",
  {
    token: text("token").primaryKey(),
    path: text("path").notNull(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`),
    expiresAt: integer("expires_at").notNull()
  },
  table => [index("idx_share_links_created_by").on(table.createdBy), index("idx_share_links_expires_at").on(table.expiresAt)]
);

// create_folder/upload/move: undoing them soft-deletes/moves the path back. delete: a trash
// entry while undoneAt/purgedAt are both unset - detail.trashId names its folder under
// ROOT_DIR/.trash. restore: the inverse of a delete. purge: emptying trash, terminal (never
// itself undoable). See src/lib/auditLog.ts for the per-action `detail` JSON shapes.
export const AUDIT_ACTIONS = ["create_folder", "upload", "move", "delete", "restore", "purge"] as const;
export type TAuditAction = (typeof AUDIT_ACTIONS)[number];

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    action: text("action").$type<TAuditAction>().notNull(),
    path: text("path").notNull(),
    detail: text("detail"), // JSON, shape depends on `action` - see src/lib/auditLog.ts
    undoneAt: integer("undone_at"),
    undoneBy: integer("undone_by").references(() => users.id),
    purgedAt: integer("purged_at"), // only ever set on `delete` rows
    purgedBy: integer("purged_by").references(() => users.id),
    createdAt: integer("created_at")
      .notNull()
      .default(sql`(unixepoch())`)
  },
  table => [index("idx_audit_log_created_at").on(table.createdAt)]
);

// optional 1:1 child of a share link - present only when the share is also exposed via
// `rclone serve` over a real file-transfer protocol, not just the browser-based /share page
export const shareServes = sqliteTable("share_serves", {
  token: text("token")
    .primaryKey()
    .references(() => shareLinks.token, { onDelete: "cascade" }),
  protocol: text("protocol").notNull(), // "webdav" | "sftp" | "ftp" | "http"
  port: integer("port").notNull(),
  password: text("password").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch())`)
});
