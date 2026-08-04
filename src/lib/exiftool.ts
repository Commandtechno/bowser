import { spawn, type ChildProcess } from "node:child_process";
import { runCapture } from "./exec";

// a pool of persistent `exiftool -stay_open` processes. exiftool is a perl script whose
// interpreter startup (~150-300ms) dwarfs the actual work of reading an embedded preview,
// so instead of one spawn per call each worker is started once and fed commands over stdin
// (exiftool's -@ argfile protocol), one at a time; output on stdout is delimited by a
// numbered {readyN} marker
const POOL_SIZE = 3;

type TJob = {
  args: string[];
  resolve: (buf: Buffer) => void;
  reject: (err: Error) => void;
};

class Worker {
  busy = false;

  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private tail = Buffer.alloc(0);
  private stderr = "";
  private marker = Buffer.alloc(0);
  private job: TJob | null = null;
  private onDone: (() => void) | null = null;

  run(job: TJob, seq: number, onDone: () => void): void {
    this.busy = true;
    this.job = job;
    this.onDone = onDone;
    this.chunks = [];
    this.tail = Buffer.alloc(0);
    this.stderr = "";
    this.marker = Buffer.from(`{ready${seq}}`);

    const proc = this.ensureProc();
    proc.stdin!.write(job.args.map(arg => arg + "\n").join("") + `-execute${seq}\n`);
  }

  kill(): void {
    this.proc?.kill();
  }

  private ensureProc(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;

    const proc = spawn("exiftool", ["-stay_open", "True", "-@", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    // if the spawn itself fails the 'error' handler below rejects the job - swallow the
    // EPIPE the already-issued stdin write would otherwise crash the process with
    proc.stdin!.on("error", () => {});
    proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk));
    proc.on("error", err => this.finish(null, err));
    proc.on("close", () => {
      this.proc = null;
      this.finish(null, new Error("exiftool exited unexpectedly"));
    });
    this.proc = proc;
    return proc;
  }

  private onData(chunk: Buffer): void {
    if (!this.job) return;
    this.chunks.push(chunk);
    // the marker can straddle a chunk boundary, so match against a small rolling tail
    // rather than re-concatenating the whole (potentially tens-of-MB) output every chunk
    this.tail = Buffer.concat([this.tail, chunk]).subarray(-(this.marker.length + 8));
    if (!this.tail.includes(this.marker)) return;

    const full = Buffer.concat(this.chunks);
    this.finish(full.subarray(0, full.lastIndexOf(this.marker)), null);
  }

  private finish(payload: Buffer | null, err: Error | null): void {
    const { job, onDone } = this;
    this.job = null;
    this.onDone = null;
    this.busy = false;
    this.chunks = [];
    if (!job) return;

    // a missing tag yields empty output with no error - that emptiness is meaningful to
    // callers (extractRawPreview's tag fallback), so only surface stderr alongside it
    if (payload && payload.length === 0 && this.stderr.trim())
      console.warn(`exiftool: ${this.stderr.trim()} (${job.args.join(" ")})`);

    if (err || !payload) job.reject(err ?? new Error("exiftool failed"));
    else job.resolve(payload);
    onDone?.();
  }
}

// pool state survives dev-server module reloads, matching db.ts's globalThis pattern -
// otherwise every reload would strand a set of live exiftool processes
const globalForExiftool = globalThis as unknown as {
  __exiftoolPool?: { workers: Worker[]; queue: TJob[]; seq: number };
};

const pool = (globalForExiftool.__exiftoolPool ??= (() => {
  const workers = Array.from({ length: POOL_SIZE }, () => new Worker());
  // stay_open workers also exit on their own when stdin hits EOF (parent death), this
  // just makes shutdown prompt
  process.once("exit", () => workers.forEach(w => w.kill()));
  return { workers, queue: [] as TJob[], seq: 0 };
})());

const pump = (): void => {
  while (pool.queue.length > 0) {
    const worker = pool.workers.find(w => !w.busy);
    if (!worker) return;
    worker.run(pool.queue.shift()!, ++pool.seq, pump);
  }
};

// runs one exiftool command through the persistent pool and resolves with its stdout.
// The argfile protocol is line-based, so args containing newlines (legal in filenames,
// if unhinged) fall back to a one-shot spawn
export const exiftoolCapture = (args: string[]): Promise<Buffer> => {
  if (args.some(arg => arg.includes("\n") || arg.includes("\r"))) return runCapture("exiftool", args);
  return new Promise((resolve, reject) => {
    pool.queue.push({ args, resolve, reject });
    pump();
  });
};
