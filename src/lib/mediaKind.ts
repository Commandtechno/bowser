// pure classification, no node/server imports - safe to use from client-side scripts too

// extensions sharp can read to produce a thumbnail directly
const NATIVE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "tif", "tiff", "svg"]);

// camera raw formats - thumbnailed/previewed via their embedded preview (see lib/preview.ts)
const RAW_EXTENSIONS = new Set([
  "rwl", // Leica
  "cr2",
  "cr3", // Canon
  "nef", // Nikon
  "arw", // Sony
  "dng", // Adobe / various
  "rw2", // Panasonic
  "orf", // Olympus
  "raf", // Fujifilm
  "srw", // Samsung
  "pef" // Pentax
]);

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi"]);

const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff", "opus"]);

// text formats previewed with syntax highlighting (see pages/api/code.ts) - maps extension
// to a shiki language id; "text" renders with no highlighting but still gets a viewer
const CODE_LANGUAGES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  rb: "ruby",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  php: "php",
  rs: "rust",
  swift: "swift",
  kt: "kotlin",
  cs: "csharp",
  lua: "lua",
  pl: "perl",
  r: "r",
  scala: "scala",
  dart: "dart",
  sql: "sql",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  astro: "astro",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  diff: "diff",
  patch: "diff",
  txt: "text",
  log: "text",
  csv: "text",
  conf: "text",
  cfg: "text",
  env: "text"
};

export type MediaKind = "native" | "raw" | "video" | "audio" | "pdf" | "code" | "unknown";

export const extOf = (filename: string): string => filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();

export const classifyMedia = (filename: string): MediaKind => {
  const ext = extOf(filename);
  if (NATIVE_EXTENSIONS.has(ext)) return "native";
  if (RAW_EXTENSIONS.has(ext)) return "raw";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (ext in CODE_LANGUAGES) return "code";
  return "unknown";
};

export const codeLangOf = (filename: string): string => CODE_LANGUAGES[extOf(filename)] ?? "text";

// maps extensions to one of the icons in public/filetypes/ - used as a fallback
// when we can't (or shouldn't) render an actual thumbnail
const EXTENSION_ICONS: Record<string, string> = {
  pdf: "acrobat",

  aep: "ae",
  aet: "ae",

  ai: "ai",

  psd: "ps",
  psb: "ps",

  sketch: "sketch",

  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",

  mp3: "audio",
  wav: "audio",
  flac: "audio",
  aac: "audio",
  ogg: "audio",
  m4a: "audio",
  wma: "audio",
  aiff: "audio",

  doc: "document",
  docx: "document",
  rtf: "document",
  txt: "document",
  pages: "document",
  odt: "document",

  xls: "spreadsheet",
  xlsx: "spreadsheet",
  csv: "spreadsheet",
  numbers: "spreadsheet",
  ods: "spreadsheet",

  js: "code",
  jsx: "code",
  ts: "code",
  tsx: "code",
  py: "code",
  rb: "code",
  go: "code",
  java: "code",
  c: "code",
  cpp: "code",
  h: "code",
  hpp: "code",
  sh: "code",
  php: "code",
  rs: "code",
  swift: "code",
  kt: "code",
  cs: "code",

  html: "webcode",
  htm: "webcode",
  css: "webcode",
  json: "webcode",
  xml: "webcode",
  yaml: "webcode",
  yml: "webcode",
  md: "webcode",

  // image formats browsers/sharp can't render directly, but aren't camera raw
  heic: "image",
  heif: "image",
  bmp: "image",
  ico: "image"
};

for (const ext of RAW_EXTENSIONS) EXTENSION_ICONS[ext] = "image";
for (const ext of VIDEO_EXTENSIONS) EXTENSION_ICONS[ext] = "video";
for (const ext of AUDIO_EXTENSIONS) EXTENSION_ICONS[ext] ??= "audio";
for (const ext of Object.keys(CODE_LANGUAGES)) EXTENSION_ICONS[ext] ??= "code";

export const iconFor = (filename: string): string => `/filetypes/${EXTENSION_ICONS[extOf(filename)] ?? "unknown"}.svg`;
