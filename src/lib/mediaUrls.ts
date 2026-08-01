// per-file url/kind computation shared by the lightbox grid (Explorer.astro) and the
// side-panel preview (PreviewPanel.astro) - keeps both in sync on how each media kind
// is actually viewed vs downloaded

import { classifyMedia, type MediaKind } from "./mediaKind";

export type TFileEntry = { name: string; size: number; mtime: number };

export type TMediaUrls = {
  key: string;
  kind: MediaKind;
  fileUrl: string;
  thumbUrl: string;
  viewUrl: string;
  isRaw: boolean;
  isCode: boolean;
  isPdf: boolean;
  // kinds that can't be viewed as the file itself (raw sensor data, code, pdf) - the
  // original file is still offered as a separate download
  indirect: boolean;
};

export const getMediaUrls = (currentPath: string[], file: TFileEntry): TMediaUrls => {
  const key = [...currentPath, file.name].join("/");
  const fileUrl = `/api/file?path=${encodeURIComponent(key)}`;
  const thumbUrl = `/api/thumb?path=${encodeURIComponent(key)}`;
  const kind = classifyMedia(file.name);

  const isRaw = kind === "raw";
  const isCode = kind === "code";
  const isPdf = kind === "pdf";
  const viewUrl = isRaw
    ? `/api/preview?path=${encodeURIComponent(key)}`
    : isCode
      ? `/api/code?path=${encodeURIComponent(key)}`
      : isPdf
        ? `/pdf?path=${encodeURIComponent(key)}`
        : fileUrl;

  return { key, kind, fileUrl, thumbUrl, viewUrl, isRaw, isCode, isPdf, indirect: isRaw || isCode || isPdf };
};
