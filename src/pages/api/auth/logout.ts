import type { APIRoute } from "astro";
import { clearSessionCookie, invalidateSession, SESSION_COOKIE } from "../../../lib/auth";

export const POST: APIRoute = async ({ cookies }) => {
  const token = cookies.get(SESSION_COOKIE)?.value;
  if (token) await invalidateSession(token);
  clearSessionCookie(cookies);
  return new Response(null, { status: 204 });
};
