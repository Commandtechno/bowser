import { defineConfig } from "drizzle-kit";

// after changing the schema run `pnpm db:generate` and commit the new file under ./drizzle -
// src/lib/db/index.ts applies pending migrations on boot
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: `file:${process.env.DB_PATH || "./data/app.db"}`
  }
});
