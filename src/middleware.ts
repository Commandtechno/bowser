import type { MiddlewareHandler } from "astro";
import { SESSION_COOKIE, setSessionCookie, validateSessionToken } from "./lib/auth";
import { json } from "./lib/http";
import { countUsers } from "./lib/users";

// users can't delete themselves (see api/users.ts), so once one exists there always is one
let hasUsers = false;

const PUBLIC_PAGES = new Set(["/login", "/setup"]);

// static assets (public/, dev modules) all carry a file extension; app pages and APIs never do
const hasExtension = (path: string): boolean => /\.[a-zA-Z0-9]+$/.test(path);

const isDevInternal = (path: string): boolean =>
  import.meta.env.DEV && (path.startsWith("/@") || path.startsWith("/node_modules/") || path.startsWith("/.astro/"));

// share links are meant to be opened by people without an account - the page and its two
// API endpoints validate the token+expiry themselves, so they skip auth entirely rather
// than being added to PUBLIC_PAGES (which redirects signed-in visitors away)
const isPublicSharePath = (path: string): boolean =>
  path === "/share" || path === "/api/share-list" || path === "/api/share-file";

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { url, cookies, locals, redirect } = context;

  try {
    const path = url.pathname;

    if (hasExtension(path) || isDevInternal(path)) return await next();

    const token = cookies.get(SESSION_COOKIE)?.value;
    if (token) {
      const result = await validateSessionToken(token);
      if (result) {
        locals.user = result.user;
        locals.sessionToken = token;
        // sliding expiry: keep the cookie's lifetime in step with the db row
        setSessionCookie(cookies, token);
      }
    }

    // fresh instance: force the first-admin setup flow until a user exists
    if (!hasUsers && !(hasUsers = (await countUsers()) > 0)) {
      if (path === "/setup" || path.startsWith("/api/auth/")) return await next();
      return redirect("/setup");
    }

    if (isPublicSharePath(path)) return await next();

    if (!locals.user) {
      if (PUBLIC_PAGES.has(path) && path !== "/setup") return await next();
      if (path.startsWith("/api/auth/")) return await next();
      if (path.startsWith("/api/")) return json(401, { error: "unauthorized" });
      return redirect("/login");
    }

    // already signed in: login/setup make no sense
    if (PUBLIC_PAGES.has(path)) return redirect("/");

    return await next();
  } catch (e) {
    // last-resort safety net: any error that escapes a route handler gets logged and turned
    // into a plain 500 instead of Astro/Vite's dev error overlay
    console.error(`unhandled error on ${context.request.method} ${context.request.url}:`, e);
    return new Response(null, { status: 500 });
  }
};
