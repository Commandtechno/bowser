import { defineConfig } from "drizzle-kit";

// for `drizzle-kit studio` only (browsing data locally) - schema DDL is hand-maintained
// in src/lib/db.ts because `username`'s COLLATE NOCASE isn't expressible through the
// drizzle column builder, so `drizzle-kit generate`/`push` must not be run against this config
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: `file:${process.env.DB_PATH || "./data/app.db"}`
  }
});
