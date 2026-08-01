import { spawn } from "node:child_process";

// runs a system binary and captures its stdout as a buffer; rejects on non-zero exit
// (used to shell out to ffmpeg/exiftool, which are expected to already be installed - see requirements.txt)
export const runCapture = (cmd: string, args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    proc.on("error", reject);
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`));
      resolve(Buffer.concat(chunks));
    });
  });
