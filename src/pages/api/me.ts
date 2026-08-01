import type { APIRoute } from "astro";
import {
  ACCENT_RE,
  hashPassword,
  invalidateOtherSessions,
  MIN_PASSWORD_LEN,
  validatePassword,
  verifyPassword
} from "../../lib/auth";
import { getPasswordHash, setAccentColor, setPasswordHash, setPreviewMode, setSyntaxTheme } from "../../lib/db";
import { isPreviewMode } from "../../lib/previewMode";
import { isSyntaxTheme } from "../../lib/themes";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const GET: APIRoute = async ({ locals }) => json(200, { user: locals.user });

// updates the signed-in user's own settings; all fields optional
export const PATCH: APIRoute = async ({ request, locals }) => {
  const user = locals.user!;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid request" });
  }
  const { accentColor, syntaxTheme, previewMode, currentPassword, newPassword } = (body ?? {}) as {
    accentColor?: unknown;
    syntaxTheme?: unknown;
    previewMode?: unknown;
    currentPassword?: unknown;
    newPassword?: unknown;
  };

  if (accentColor !== undefined) {
    if (typeof accentColor !== "string" || !ACCENT_RE.test(accentColor))
      return json(400, { error: "accent must be a #rrggbb color" });
    await setAccentColor(user.id, accentColor);
  }

  if (syntaxTheme !== undefined) {
    if (!isSyntaxTheme(syntaxTheme)) return json(400, { error: "unknown syntax theme" });
    await setSyntaxTheme(user.id, syntaxTheme);
  }

  if (previewMode !== undefined) {
    if (!isPreviewMode(previewMode)) return json(400, { error: "unknown preview mode" });
    await setPreviewMode(user.id, previewMode);
  }

  if (newPassword !== undefined) {
    if (typeof currentPassword !== "string") return json(400, { error: "current password required" });
    if (!validatePassword(newPassword))
      return json(400, { error: `new password must be at least ${MIN_PASSWORD_LEN} characters` });

    const currentHash = await getPasswordHash(user.id);
    if (!currentHash || !(await verifyPassword(currentHash, currentPassword)))
      return json(403, { error: "current password is incorrect" });

    await setPasswordHash(user.id, await hashPassword(newPassword));
    await invalidateOtherSessions(user.id, locals.sessionToken!);
  }

  return json(200, { ok: true });
};
