import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { runCapture, spawnLongRunning } from "./exec";
import {
  listActiveShareServes,
  listExpiredShareServeTokens,
  updateShareServePort,
  deleteShareServe,
  type TShareServeRow
} from "./db";
import { ROOT_DIR, resolveInDir } from "./media";

// optional integration: a share link can also be exposed over a real file-transfer protocol
// via `rclone serve`, scoped read-only to the share's folder, using the share's own
// password (independent of the share token) as the protocol credential.

export const PROTOCOLS = ["webdav", "sftp", "ftp", "http"] as const;
export type TProtocol = (typeof PROTOCOLS)[number];
export const isValidProtocol = (value: unknown): value is TProtocol => (PROTOCOLS as readonly unknown[]).includes(value);

export const SERVE_USER = "share";

// process.env so the docker compose `environment:` block takes effect at runtime
const RCLONE_BIN = process.env.RCLONE_BIN || "rclone";
export const MAX_RCLONE_SERVES = Number(process.env.MAX_RCLONE_SERVES) || 20;

type TServeEntry = { protocol: TProtocol; port: number; proc: ChildProcess };

// caches survive dev-server module reloads, matching db.ts's globalThis pattern
const globalForRclone = globalThis as unknown as {
  __rcloneServes?: Map<string, TServeEntry>;
  __rcloneReconciled?: Promise<void>;
  __rcloneSweepStarted?: boolean;
  __rcloneShutdownRegistered?: boolean;
};

const serves = (globalForRclone.__rcloneServes ??= new Map<string, TServeEntry>());

export const activeServeCount = (): number => serves.size;

// binds a specific port to check it's free, then releases it immediately - the resulting
// TOCTOU race (something else grabs the port before rclone binds it) is a narrow window,
// acceptable for this LAN-trusted, low-concurrency use case
// no explicit host: bind on all interfaces, matching rclone's own `--addr :<port>` binding
const canBindPort = (port: number): Promise<boolean> =>
  new Promise(resolve => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, () => srv.close(() => resolve(true)));
  });

// `rclone serve ftp --addr :0` silently ignores the request and falls back to its hardcoded
// default port 2121 (confirmed by testing) - so we always allocate ports ourselves, uniformly
// across every protocol, rather than asking rclone for an OS-assigned one
const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : null;
      srv.close(() => (port ? resolve(port) : reject(new Error("failed to allocate a port"))));
    });
  });

const buildServeArgs = (protocol: TProtocol, absPath: string, port: number, password: string): string[] => [
  "serve",
  protocol,
  absPath,
  "--addr",
  `:${port}`,
  "--user",
  SERVE_USER,
  "--pass",
  password,
  "--read-only"
];

// starts (or restarts, on reconciliation) an `rclone serve` process for a share. reuses the
// given port/password verbatim when supplied so previously-shared connection info and
// copy-paste commands keep working across a restart; only allocates fresh ones when the
// preferred port can't be rebound (or none was given, i.e. first-time creation)
export const startServeProcess = async (
  token: string,
  protocol: TProtocol,
  absPath: string,
  opts?: { port?: number; password?: string }
): Promise<{ port: number; password: string }> => {
  const password = opts?.password ?? randomBytes(18).toString("base64url");
  const port = opts?.port && (await canBindPort(opts.port)) ? opts.port : await findFreePort();

  const proc = spawnLongRunning(RCLONE_BIN, buildServeArgs(protocol, absPath, port, password), {
    onExit: code => {
      const current = serves.get(token);
      if (current?.port === port) serves.delete(token);
      if (code !== 0 && code !== null) console.error(`rclone serve ${protocol} for share ${token} exited with code ${code}`);
    }
  });
  proc.unref();

  serves.set(token, { protocol, port, proc });
  return { port, password };
};

export const stopServeProcess = (token: string): void => {
  const entry = serves.get(token);
  if (!entry) return;
  serves.delete(token);
  entry.proc.kill("SIGTERM");
};

// on boot, respawn an rclone process for every share_serves row whose parent share link
// hasn't expired yet - nothing about a running process survives a server restart otherwise
const reconcileServeProcesses = async (): Promise<void> => {
  const rows = await listActiveShareServes();
  for (const row of rows) {
    try {
      const absPath = resolveInDir(ROOT_DIR, row.path);
      const { port } = await startServeProcess(row.token, row.protocol as TProtocol, absPath, {
        port: row.port,
        password: row.password
      });
      if (port !== row.port) await updateShareServePort(row.token, port);
    } catch (e) {
      console.error(`failed to reconcile rclone serve for share ${row.token}:`, e);
    }
  }
};

// kicked off once at module load, not awaited by any request handler - a missing/broken
// rclone binary shouldn't be able to turn unrelated requests into 500s. a ~1-2s window right
// after boot where a pre-existing protocol-share hasn't finished respawning yet is acceptable
export const rcloneReconciled = (globalForRclone.__rcloneReconciled ??= reconcileServeProcesses().catch(err => {
  console.error("rclone reconciliation failed:", err);
}));

// setTimeout can't be used for expiry (its ~24.8 day max delay is far short of the 10-year
// MAX_DURATION_S ceiling) - a periodic sweep against the db is the same lazy-expiry
// philosophy already used for the plain web-link flow, and doubles as a backstop cleanup for
// any tracked process whose share_serves row went away by some other path
const sweep = async (): Promise<void> => {
  // the source of truth is the db, not the in-memory map: a share that expired while the
  // server was down never gets tracked by reconciliation in the first place, so relying only
  // on "was it in `serves`" would let those rows leak forever
  const expiredTokens = await listExpiredShareServeTokens().catch((): string[] => []);
  for (const token of expiredTokens) {
    stopServeProcess(token);
    await deleteShareServe(token).catch(() => {});
  }

  // backstop: a still-tracked process whose share_serves row is gone for some other reason
  // (shouldn't normally happen - the DELETE endpoint always calls stopServeProcess itself)
  const active = await listActiveShareServes().catch(() => []);
  const activeTokens = new Set(active.map(row => row.token));
  for (const token of [...serves.keys()]) {
    if (!activeTokens.has(token) && !expiredTokens.includes(token)) stopServeProcess(token);
  }
};

if (!globalForRclone.__rcloneSweepStarted) {
  globalForRclone.__rcloneSweepStarted = true;
  setInterval(() => void sweep(), 60_000).unref();
}

// @astrojs/node's standalone adapter registers no shutdown hook of its own (confirmed by
// reading its source - bare server.listen(), no signal handlers), so without this, SIGTERM's
// default behavior (immediate exit) already tears everything down; the point of this handler
// is only to give tracked rclone children a chance to exit cleanly first, bounded so we never
// hang past what an orchestrator would tolerate before escalating to SIGKILL
if (!globalForRclone.__rcloneShutdownRegistered) {
  globalForRclone.__rcloneShutdownRegistered = true;
  const shutdown = (): void => {
    for (const token of [...serves.keys()]) stopServeProcess(token);
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// builds a ready-to-paste `rclone copy ... --progress` command for the receiving machine.
// the http backend has no user=/pass= backend option at all (confirmed: passing them is
// silently ignored and the request comes back 401) - auth has to go in the url userinfo
// instead, like a plain `curl http://user:pass@host/`. the other three protocols need their
// password obscured via `rclone obscure` for use in an on-the-fly connection string.
//
// the whole `:backend,...:` token is wrapped in double quotes in the displayed command - this
// isn't just shell hygiene, it's load-bearing: confirmed by hands-on testing that without
// literal single-quote characters surviving *into* rclone's own connection-string parser
// (which double quotes preserve but bash's own single quotes would strip before rclone ever
// sees them), rclone misparses any value containing ":"/"/" (e.g. the url= value) and fails
// with a bogus "unsupported protocol scheme" error
export const buildCopyCommand = async (protocol: TProtocol, host: string, port: number, password: string): Promise<string> => {
  if (protocol === "http") {
    return `rclone copy ":http,url='http://${SERVE_USER}:${password}@${host}:${port}/':" ./downloaded --progress`;
  }

  const obscured = (await runCapture(RCLONE_BIN, ["obscure", password])).toString().trim();

  if (protocol === "webdav") {
    return `rclone copy ":webdav,url='http://${host}:${port}/',vendor=rclone,user=${SERVE_USER},pass=${obscured}:" ./downloaded --progress`;
  }
  if (protocol === "ftp") {
    return `rclone copy ":ftp,host='${host}',port=${port},user=${SERVE_USER},pass=${obscured}:" ./downloaded --progress`;
  }
  return `rclone copy ":sftp,host='${host}',port=${port},user='${SERVE_USER}',pass='${obscured}':" ./downloaded --progress`;
};

export type { TShareServeRow };
