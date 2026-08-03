import type { APIRoute } from "astro";
import { open, stat } from "node:fs/promises";
import { codeToHtml } from "shiki";
import { InvalidPathError, resolveInDir, rootDirFor } from "../../lib/media";
import { classifyMedia, codeLangOf } from "../../lib/mediaKind";
import { isSyntaxTheme } from "../../lib/themes";

// serves a syntax-highlighted HTML page for a text/code file - shown in an iframe by the lightbox

// highlighting more than this is slow and unreadable anyway; longer files are truncated
const MAX_BYTES = 512 * 1024;

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const GET: APIRoute = async ({ url, locals }) => {
  const relPath = url.searchParams.get("path");
  if (!relPath) return new Response(null, { status: 400 });

  if (classifyMedia(relPath) !== "code") return new Response(null, { status: 400 });

  let sourcePath: string;
  try {
    sourcePath = resolveInDir(rootDirFor(locals.user), relPath);
  } catch (e) {
    if (e instanceof InvalidPathError) return new Response(null, { status: 400 });
    throw e;
  }

  let sourceStat;
  try {
    sourceStat = await stat(sourcePath);
  } catch {
    return new Response(null, { status: 404 });
  }
  if (!sourceStat.isFile()) return new Response(null, { status: 404 });

  const truncated = sourceStat.size > MAX_BYTES;
  const handle = await open(sourcePath);
  let code: string;
  try {
    const buffer = Buffer.alloc(Math.min(sourceStat.size, MAX_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    code = buffer.toString("utf-8");
  } finally {
    await handle.close();
  }

  const userTheme = locals.user?.syntaxTheme;
  const theme = isSyntaxTheme(userTheme) ? userTheme : "github-dark";

  let highlighted: string;
  try {
    highlighted = await codeToHtml(code, { lang: codeLangOf(relPath), theme });
  } catch {
    highlighted = await codeToHtml(code, { lang: "text", theme });
  }

  // shiki inlines the theme background on the <pre>; reuse it for the page + line numbers
  const bg = /background-color:\s*(#[0-9a-fA-F]{3,8})/.exec(highlighted)?.[1] ?? "#24292e";
  const fg = /(?<!background-)color:\s*(#[0-9a-fA-F]{3,8})/.exec(highlighted)?.[1] ?? "#8b949e";

  const name = relPath.split("/").at(-1) ?? relPath;
  const lineCount = code.split("\n").length;
  const lineNumberWidth = Math.max(2, String(lineCount).length);
  const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(name)}</title>
    <style>
      html,
      body {
        margin: 0;
        min-height: 100%;
        background-color: ${bg}; /* theme background */
      }
      pre.shiki {
        margin: 0;
        padding: 16px 20px;
        overflow: auto;
        font-family: "Space Mono", monospace;
        font-size: 13px;
        line-height: 1.5;
        tab-size: 4;
      }
      /* line numbers - shiki wraps each line in a span.line */
      pre.shiki code {
        counter-reset: line;
      }
      pre.shiki .line::before {
        counter-increment: line;
        content: counter(line);
        display: inline-block;
        width: ${String(lineNumberWidth)}ch;
        margin-right: 2ch;
        text-align: right;
        color: ${fg};
        opacity: 0.55;
        user-select: none;
      }
      .truncated {
        padding: 8px 20px;
        color: ${fg};
        font-family: monospace;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    ${highlighted}${truncated ? `<div class="truncated">… truncated (showing first ${MAX_BYTES / 1024} KiB) - download for the full file</div>` : ""}
  </body>
</html>`;

  return new Response(page, {
    // no-cache (not max-age): the page depends on the viewer's syntax theme, which can change any time
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-cache" }
  });
};
