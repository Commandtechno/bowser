import { runCapture } from "./exec";
import type { MediaKind } from "./mediaKind";

export type TMetaField = { label: string; value: string };

// concise, human-readable metadata for the preview side panel - curated subset of what
// exiftool/ffprobe report, not the full dump

const runExiftoolFields = async (path: string, tags: string[], labels: Record<string, string>): Promise<TMetaField[]> => {
  const buf = await runCapture("exiftool", ["-json", ...tags.map(t => `-${t}`), path]);
  const [data] = JSON.parse(buf.toString("utf8")) as Record<string, unknown>[];

  const fields: TMetaField[] = [];
  for (const tag of tags) {
    const value = data?.[tag];
    if (value === undefined || value === null || value === "") continue;
    fields.push({ label: labels[tag] ?? tag, value: String(value) });
  }
  return fields;
};

const IMAGE_TAGS = [
  "Make",
  "Model",
  "LensModel",
  "ISO",
  "FNumber",
  "ExposureTime",
  "FocalLength",
  "ImageSize",
  "DateTimeOriginal",
  "GPSPosition",
  "ColorSpace",
  "Orientation"
];

const IMAGE_LABELS: Record<string, string> = {
  Make: "camera make",
  Model: "camera model",
  LensModel: "lens",
  ISO: "ISO",
  FNumber: "aperture",
  ExposureTime: "shutter speed",
  FocalLength: "focal length",
  ImageSize: "dimensions",
  DateTimeOriginal: "date taken",
  GPSPosition: "location",
  ColorSpace: "color space",
  Orientation: "orientation"
};

export const getImageMeta = (path: string): Promise<TMetaField[]> => runExiftoolFields(path, IMAGE_TAGS, IMAGE_LABELS);

const PDF_TAGS = ["Title", "Author", "Creator", "PageCount", "CreationDate"];

const PDF_LABELS: Record<string, string> = {
  Title: "title",
  Author: "author",
  Creator: "created with",
  PageCount: "pages",
  CreationDate: "created"
};

export const getPdfMeta = (path: string): Promise<TMetaField[]> => runExiftoolFields(path, PDF_TAGS, PDF_LABELS);

const fmtDuration = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const s = Math.floor(secs % 60);
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
};

type TFfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
};

type TFfprobeOutput = {
  format?: {
    duration?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
  streams?: TFfprobeStream[];
};

export const getMediaMeta = async (path: string): Promise<TMetaField[]> => {
  const buf = await runCapture("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  const data = JSON.parse(buf.toString("utf8")) as TFfprobeOutput;

  const format = data.format ?? {};
  const streams = data.streams ?? [];
  // an mp3/flac's embedded cover art shows up as its own "video" stream (mjpeg, usually with
  // a nonsense frame rate) - only treat it as video if it isn't just attached artwork
  const video = streams.find(s => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find(s => s.codec_type === "audio");

  const fields: TMetaField[] = [];

  if (video) {
    if (video.width && video.height) fields.push({ label: "dimensions", value: `${video.width}×${video.height}` });
    if (video.codec_name) fields.push({ label: "video codec", value: video.codec_name });
    if (video.r_frame_rate) {
      const [n, d] = video.r_frame_rate.split("/").map(Number);
      if (d) fields.push({ label: "frame rate", value: `${(n / d).toFixed(2)} fps` });
    }
  }

  if (audio) {
    if (audio.codec_name) fields.push({ label: "audio codec", value: audio.codec_name });
    if (audio.sample_rate) fields.push({ label: "sample rate", value: `${Math.round(Number(audio.sample_rate) / 1000)} kHz` });
    if (audio.channels) fields.push({ label: "channels", value: String(audio.channels) });
  }

  if (format.duration) fields.push({ label: "duration", value: fmtDuration(Number(format.duration)) });
  if (format.bit_rate) fields.push({ label: "bit rate", value: `${Math.round(Number(format.bit_rate) / 1000)} kbps` });

  const tags = format.tags ?? {};
  const title = tags.title ?? tags.TITLE;
  const artist = tags.artist ?? tags.ARTIST;
  const album = tags.album ?? tags.ALBUM;
  if (title) fields.push({ label: "title", value: title });
  if (artist) fields.push({ label: "artist", value: artist });
  if (album) fields.push({ label: "album", value: album });

  return fields;
};

export const getMeta = async (kind: MediaKind, path: string): Promise<TMetaField[]> => {
  try {
    if (kind === "native" || kind === "raw") return await getImageMeta(path);
    if (kind === "video" || kind === "audio") return await getMediaMeta(path);
    if (kind === "pdf") return await getPdfMeta(path);
    return [];
  } catch {
    // missing binary, corrupt file, unsupported format, etc. - just show nothing extra
    return [];
  }
};
