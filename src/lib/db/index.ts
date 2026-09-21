import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";

// process.env so the docker compose `environment:` block takes effect at runtime
const DB_PATH = resolve(process.env.DB_PATH || "./data/app.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const client = createClient({ url: `file:${DB_PATH}` });
await client.execute("PRAGMA journal_mode = WAL");

export const db = drizzle(client, { schema });

// top-level await: every importer of `db` waits on this through the module graph, so no
// query can run against an unmigrated file. Migrations are generated from ./schema.ts with
// `pnpm db:generate` into ./drizzle, which the Dockerfile copies next to dist/
await migrate(db, { migrationsFolder: resolve("drizzle") });
