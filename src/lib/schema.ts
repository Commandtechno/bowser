import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const DEFAULT_ACCENT = "#00ffc1";
export const DEFAULT_SYNTAX_THEME = "github-dark";
export const DEFAULT_PREVIEW_MODE = "panel";

// username uniqueness/collation (COLLATE NOCASE) is enforced by the raw DDL in db.ts,
// not expressible through the drizzle-kit column builder
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull(),
  passwordHash: text("password_hash").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
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
