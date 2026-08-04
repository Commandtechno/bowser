import { runCapture } from "./exec";
import { exiftoolCapture } from "./exiftool";

// camera raw formats embed a JPEG preview for the LCD/viewfinder - pulling that is far
// cheaper than decoding the actual raw sensor data, and covers virtually every raw format
const RAW_PREVIEW_TAGS = ["-PreviewImage", "-JpgFromRaw", "-ThumbnailImage"];

export const extractRawPreview = async (path: string): Promise<Buffer> => {
  for (const tag of RAW_PREVIEW_TAGS) {
    const buf = await exiftoolCapture(["-b", tag, path]);
    if (buf.length > 0) return buf;
  }

  throw new Error(`no embedded preview found in ${path}`);
};

export const extractVideoFrame = async (path: string): Promise<Buffer> => {
  for (const seek of ["1", "0"]) {
    try {
      const buf = await runCapture("ffmpeg", [
        "-loglevel",
        "error",
        "-ss",
        seek,
        "-i",
        path,
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1"
      ]);
      if (buf.length > 0) return buf;
    } catch (e) {
      if (seek === "0") throw e;
    }
  }

  throw new Error(`could not extract a frame from ${path}`);
};

// embedded cover art is exposed as a single-frame video stream, but input seeking (-ss)
// skips its packet - so unlike extractVideoFrame, this must read from the start
export const extractAudioCover = async (path: string): Promise<Buffer> => {
  const buf = await runCapture("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    path,
    "-frames:v",
    "1",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1"
  ]);
  if (buf.length === 0) throw new Error(`no embedded cover art in ${path}`);
  return buf;
};

// renders the first page of a PDF as a JPEG (poppler writes to stdout when no output root is given)
export const extractPdfPage = async (path: string): Promise<Buffer> => {
  const buf = await runCapture("pdftoppm", ["-jpeg", "-f", "1", "-l", "1", "-scale-to", "512", path]);
  if (buf.length === 0) throw new Error(`could not render first page of ${path}`);
  return buf;
};
