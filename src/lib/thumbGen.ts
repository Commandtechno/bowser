import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { absToRootRel, resolveInDir, THUMBS_DIR } from "./media";
import { classifyMedia, type MediaKind } from "./mediaKind";
import { extractAudioCover, extractPdfPage, extractRawPreview, extractVideoFrame } from "./preview";

const THUMB_SIZE = 300;

// a failed generation writes an empty marker next to where the artifact would be, so a
// broken/coverless source costs one extraction attempt instead of one per page view -
// the marker is mtime-gated exactly like the artifact, so a replaced source retries
const FAIL_SUFFIX = ".fail";

// simple FIFO semaphore - caps how many extract+encode jobs run at once so a burst of
// grid requests (or a warm sweep) can't fan out unbounded exiftool/ffmpeg/sharp work
const makeLimiter = (max: number) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>(res => waiting.push(res));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next(); // hand the slot straight to the next waiter
      else active--;
    }
  };
};

// state survives dev-server module reloads, matching db.ts's globalThis pattern
const globalForThumbs = globalThis as unknown as {
  __thumbGen?: {
    inFlight: Map<string, Promise<Buffer | null>>;
    interactive: ReturnType<typeof makeLimiter>;
    warm: ReturnType<typeof makeLimiter>;
  };
};

// two lanes so a background warm sweep can never starve thumbnails the user is actually
// looking at - warm work queues in its own (smaller) lane
const state = (globalForThumbs.__thumbGen ??= {
  inFlight: new Map(),
  interactive: makeLimiter(4),
  warm: makeLimiter(2)
});

export const thumbCachePath = (sourcePath: string): string =>
  resolveInDir(THUMBS_DIR, absToRootRel(sourcePath)) + ".webp";

export const previewCachePath = (sourcePath: string): string =>
  resolveInDir(THUMBS_DIR, absToRootRel(sourcePath)) + ".preview.jpg";

// serves a cached derivative (thumbnail/preview) of a media file, generating it if stale
// or missing - with in-flight dedup so concurrent requests for the same file do the work
// once. Returns null when generation failed (freshly or via a cached .fail marker);
// callers map that to their own fallback (icon redirect / 404)
export const getCachedDerivative = async (opts: {
  sourcePath: string;
  cachePath: string;
  sourceMtimeMs: number;
  warm?: boolean;
  generate: () => Promise<Buffer>;
}): Promise<Buffer | null> => {
  const { sourcePath, cachePath, sourceMtimeMs, warm, generate } = opts;

  const cachedStat = await stat(cachePath).catch(() => null);
  if (cachedStat && cachedStat.mtimeMs >= sourceMtimeMs) return readFile(cachePath);

  const failStat = await stat(cachePath + FAIL_SUFFIX).catch(() => null);
  if (failStat && failStat.mtimeMs >= sourceMtimeMs) return null;

  const existing = state.inFlight.get(cachePath);
  if (existing) return existing;

  const limiter = warm ? state.warm : state.interactive;
  const task = limiter(async (): Promise<Buffer | null> => {
    // a request that queued behind the in-flight generation of the same file re-checks
    // the cache once it gets a slot, rather than generating again
    const st = await stat(cachePath).catch(() => null);
    if (st && st.mtimeMs >= sourceMtimeMs) return readFile(cachePath);

    let buffer: Buffer;
    try {
      buffer = await generate();
    } catch (e) {
      console.warn(`derivative generation failed for ${sourcePath}:`, e);
      await mkdir(dirname(cachePath), { recursive: true }).catch(() => {});
      await writeFile(cachePath + FAIL_SUFFIX, "").catch(() => {});
      return null;
    }

    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, buffer);
    await rm(cachePath + FAIL_SUFFIX, { force: true }).catch(() => {});
    return buffer;
  }).finally(() => state.inFlight.delete(cachePath));

  state.inFlight.set(cachePath, task);
  return task;
};

// renders the grid thumbnail for any thumbable media kind - shared by the on-demand
// /api/thumb endpoint and the background warm sweep below
export const buildThumb = async (sourcePath: string, kind: MediaKind): Promise<Buffer> => {
  let source: string | Buffer = sourcePath;
  if (kind === "raw") source = await extractRawPreview(sourcePath);
  else if (kind === "video") source = await extractVideoFrame(sourcePath);
  // uses embedded cover art; files without any fail through to the caller's icon fallback
  else if (kind === "audio") source = await extractAudioCover(sourcePath);
  else if (kind === "pdf") source = await extractPdfPage(sourcePath);

  return sharp(source)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
    .webp()
    .toBuffer();
};

// how many missing thumbnails one directory listing may queue in the background - bounds
// pathological folders; anything beyond is generated on demand as the user scrolls
const WARM_MAX = 300;

// fire-and-forget: pre-generates missing raw thumbnails for a just-listed directory so
// the grid doesn't pay extraction latency tile by tile. Raw only - that's where cold
// thumbnails hurt most, and native images are cheap enough on demand while video/pdf
// warming would fan out an ffmpeg/poppler process per file the user may never scroll to
export const warmRawThumbs = (dirAbsPath: string, fileNames: string[]): void => {
  const rawNames = fileNames.filter(name => classifyMedia(name) === "raw").slice(0, WARM_MAX);

  void Promise.all(
    rawNames.map(async name => {
      const sourcePath = join(dirAbsPath, name);
      try {
        const sourceStat = await stat(sourcePath);
        await getCachedDerivative({
          sourcePath,
          cachePath: thumbCachePath(sourcePath),
          sourceMtimeMs: sourceStat.mtimeMs,
          warm: true,
          generate: () => buildThumb(sourcePath, "raw")
        });
      } catch {
        // best-effort - the on-demand path will surface anything that matters
      }
    })
  );
};
