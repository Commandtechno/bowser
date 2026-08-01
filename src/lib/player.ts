import "./player.css";
import type { AudioBufferSink, CanvasSink, Input, WrappedAudioBuffer, WrappedCanvas } from "mediabunny";

// custom media player used for video + audio lightbox slides (see Explorer.astro).
// light dom on purpose: fancybox finds the inner <video> to pause it on slide change,
// and the page's css vars (--accent etc.) style the controls.

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VOLUME_KEY = "player:volume";
const MUTED_KEY = "player:muted";

// codecs webcodecs/mediabunny can't decode natively - loaded (and registered) together with
// the core library, all in one lazy chunk fetched only on the decode/render fallback path.
// only decoders are needed: the fallback never re-encodes anything, it decodes frames/samples
// straight from the source file and renders them itself (see initFallback below)
let mediabunnyPromise: ReturnType<typeof loadMediabunny> | undefined;
const loadMediabunny = async () => {
  const [core, prores, ac3] = await Promise.all([
    import("mediabunny"),
    import("@mediabunny/prores"),
    import("@mediabunny/ac3")
  ]);

  prores.registerProresDecoder();
  ac3.registerAc3Decoder();

  return core;
};

const ICONS = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  replay:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/><text x="9" y="16" font-size="8" font-family="monospace">10</text></svg>',
  fwd: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1l5 5-5 5V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z"/><text x="7" y="16" font-size="8" font-family="monospace">10</text></svg>',
  volHigh:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  volLow:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  volMute:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm12.6 3 2.5-2.5-1.4-1.4-2.5 2.5-2.5-2.5-1.4 1.4 2.5 2.5-2.5 2.5 1.4 1.4 2.5-2.5 2.5 2.5 1.4-1.4-2.5-2.5z"/></svg>',
  pip: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 4v16h20V4H2zm18 14H4V6h16v12zm-9-7h7v5h-7v-5z"/></svg>',
  fs: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zM5 10h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
  fsExit:
    '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>'
};

const formatTime = (secs: number): string => {
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const s = Math.floor(secs % 60);
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
};

class PwPlayer extends HTMLElement {
  private video!: HTMLVideoElement;
  // only created if/when the decode/render fallback actually needs it (see initFallback) -
  // the vast majority of players never touch this, so it doesn't sit in the dom as dead
  // weight for every ordinary video/audio slide
  private canvas: HTMLCanvasElement | undefined;
  private ctx: CanvasRenderingContext2D | undefined;
  private $ = (sel: string) => this.querySelector(sel) as HTMLElement;
  private built = false;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private scrubbing = false;
  private wasPlayingBeforeScrub = false;
  private onKeydown = (e: KeyboardEvent) => this.handleKey(e);
  private volume = 1;
  private muted = false;

  // the browser couldn't play the source directly - the decode/render fallback (below) takes
  // over as a from-scratch player once this is true. fallbackAttempted just guards against
  // retrying it if the fallback's own <canvas>/audio pipeline somehow also errors out
  private fallbackAttempted = false;
  private fallback = false;

  // --- decode/render fallback state (see initFallback and the fb* methods) ---
  private input: Input | undefined;
  private videoSink: CanvasSink | undefined;
  private audioSink: AudioBufferSink | undefined;
  private audioCtx: AudioContext | undefined;
  private gainNode: GainNode | undefined;
  private firstTimestamp = 0;
  private endTimestamp = 0;
  private playing = false;
  private fbEnded = false;
  private playbackTimeAtStart = 0;
  private audioCtxStartTime = 0;
  private rate = 1;
  private videoFrameIterator: AsyncGenerator<WrappedCanvas, void, unknown> | undefined;
  private audioBufferIterator: AsyncGenerator<WrappedAudioBuffer, void, unknown> | undefined;
  private nextFrame: WrappedCanvas | undefined;
  private queuedAudioNodes = new Set<AudioBufferSourceNode>();
  private fbAsyncId = 0;
  private fbRafId = 0;
  private fbIntervalId = 0;

  connectedCallback() {
    if (!this.built) {
      this.built = true;
      this.render();
      this.bind();
    }
    document.addEventListener("keydown", this.onKeydown, true);
  }

  disconnectedCallback() {
    document.removeEventListener("keydown", this.onKeydown, true);
    clearTimeout(this.hideTimer);
    // media elements keep playing even once detached from the document - stop it explicitly
    // instead of relying on gc timing (matters for the panel, which swaps players on every
    // navigation/close, and for fancybox slide teardown)
    this.video?.pause();
    this.fbTeardown();
  }

  private render() {
    const src = this.dataset.src ?? "";
    const poster = this.dataset.poster ?? "";

    this.classList.add("pw-paused");
    this.innerHTML = `
      <video playsinline preload="metadata"${poster ? ` poster="${poster}"` : ""}>
        <source src="${src}" />
      </video>
      <img class="pw-art" alt="cover art"${poster ? ` src="${poster}"` : ""} />
      <div class="pw-state">${ICONS.play}</div>
      <div class="pw-spin"></div>
      <div class="pw-error">playback failed - try downloading the file instead</div>
      <div class="pw-bar">
        <button class="pw-play" title="play/pause (space)">${ICONS.play}</button>
        <span class="pw-time"><span class="pw-cur">0:00</span> / <span class="pw-dur">0:00</span></span>
        <div class="pw-seek">
          <div class="pw-buf"></div>
          <div class="pw-fill"></div>
          <div class="pw-thumb"></div>
          <div class="pw-tip">0:00</div>
        </div>
        <div class="pw-volwrap">
          <button class="pw-mute" title="mute (m)">${ICONS.volHigh}</button>
          <input class="pw-vol" type="range" min="0" max="1" step="0.01" title="volume" />
        </div>
        <div class="pw-speedwrap">
          <button class="pw-speed" title="playback speed">1x</button>
          <div class="pw-menu">
            ${SPEEDS.map(s => `<button data-speed="${s}"${s === 1 ? ' class="pw-active"' : ""}>${s}x</button>`).join("")}
          </div>
        </div>
        <button class="pw-pip" title="picture in picture">${ICONS.pip}</button>
        <button class="pw-fs" title="fullscreen (f)">${ICONS.fs}</button>
      </div>`;

    this.video = this.querySelector("video")!;
    if (!document.pictureInPictureEnabled) this.$(".pw-pip").style.display = "none";
  }

  private bind() {
    const video = this.video;

    // restore persisted volume state
    video.volume = Number(localStorage.getItem(VOLUME_KEY) ?? "1");
    video.muted = localStorage.getItem(MUTED_KEY) === "1";
    this.volume = video.volume;
    this.muted = video.muted;

    video.addEventListener("loadedmetadata", () => {
      // some browsers don't fire `error` for a container whose video codec they can't
      // decode (prores .mov is the common case) - they just quietly report it as having no
      // video track at all, indistinguishable from a real audio-only file... except a real
      // audio-only file always carries a poster (see Explorer.astro/PreviewPanel.astro),
      // and this one doesn't, so that's the signal to route it into the fallback instead
      if (!video.videoWidth && !this.dataset.poster && !this.fallbackAttempted) {
        void this.initFallback();
        return;
      }
      this.setMode(video.videoWidth ? "video" : "audio");
      this.sizeBox();
      this.$(".pw-dur").textContent = formatTime(video.duration);
    });
    video.addEventListener("durationchange", () => (this.$(".pw-dur").textContent = formatTime(video.duration)));
    video.addEventListener("timeupdate", () => this.renderProgress());
    video.addEventListener("progress", () => this.renderBuffered());
    video.addEventListener("play", () => this.renderPlayState());
    video.addEventListener("pause", () => this.renderPlayState());
    video.addEventListener("ended", () => this.renderPlayState());
    video.addEventListener("waiting", () => this.classList.add("pw-waiting"));
    video.addEventListener("playing", () => this.classList.remove("pw-waiting"));
    video.addEventListener("canplay", () => this.classList.remove("pw-waiting"));
    video.addEventListener("volumechange", () => this.renderVolume());
    video.addEventListener("error", () => {
      if (this.fallbackAttempted) this.classList.add("pw-failed");
      else void this.initFallback();
    });

    this.$(".pw-play").addEventListener("click", () => this.togglePlay());
    this.$(".pw-fs").addEventListener("click", () => this.toggleFullscreen());
    this.$(".pw-pip").addEventListener("click", () => video.requestPictureInPicture().catch(() => {}));

    this.$(".pw-mute").addEventListener("click", () => this.toggleMute());
    const $vol = this.$(".pw-vol") as HTMLInputElement;
    $vol.addEventListener("input", () => this.setVolume(Number($vol.value)));

    this.$(".pw-speed").addEventListener("click", () => this.$(".pw-menu").classList.toggle("pw-open"));
    for (const btn of this.querySelectorAll<HTMLButtonElement>(".pw-menu button")) {
      btn.addEventListener("click", () => this.setSpeed(Number(btn.dataset.speed)));
    }

    // clicking the video surface toggles playback; double click toggles fullscreen (the
    // canvas fallback surface gets the same treatment once/if it's created - see initFallback)
    this.bindSurfaceEvents(video);

    document.addEventListener("fullscreenchange", () => {
      this.$(".pw-fs").innerHTML = document.fullscreenElement === this ? ICONS.fsExit : ICONS.fs;

      // some browsers paint the video/canvas surface at the object-fit scale computed for the
      // fullscreen box and never repaint it once the element returns to its normal (inline)
      // size, even though its computed styles (width/object-fit) are already correct again -
      // toggling display forces a real layout+paint pass and clears the stale frame
      const surface = this.fallback ? this.canvas : this.video;
      if (surface) {
        requestAnimationFrame(() => {
          const prevDisplay = surface.style.display;
          surface.style.display = "none";
          void surface.offsetHeight;
          surface.style.display = prevDisplay;
        });
      }
    });

    // auto-hide the control bar while a video is playing
    for (const evt of ["pointermove", "pointerdown"] as const) {
      this.addEventListener(evt, () => this.wakeControls());
    }

    this.bindSeek();
    this.renderVolume();
  }

  private bindSurfaceEvents(el: HTMLElement) {
    el.addEventListener("click", () => this.togglePlay());
    el.addEventListener("dblclick", () => this.toggleFullscreen());
  }

  private setMode(mode: "video" | "audio") {
    this.setAttribute("mode", mode);
    if (mode === "audio") {
      // fullscreen/pip make no sense without a picture
      this.$(".pw-fs").style.display = "none";
      this.$(".pw-pip").style.display = "none";
    }
  }

  // the surrounding box (fancybox's .f-html slide, or the preview panel's [data-pw-box])
  // defaults to a fixed 16:9; reshape it to the real media: video aspect ratio, or a
  // compact card for audio
  private sizeBox() {
    const box = this.closest<HTMLElement>(".f-html, [data-pw-box]");
    if (!box) return;

    if (this.getAttribute("mode") === "audio") {
      // drop the pre-metadata sizing hints (fancybox applied them as inline styles,
      // which would beat the .pw-audio-box card layout)
      box.classList.add("pw-audio-box");
      box.style.aspectRatio = "";
      box.style.maxWidth = "";
      return;
    }

    // this.canvas is guaranteed to exist here: sizeBox() only reaches this point (past the
    // audio-mode early return) in fallback mode when there's a video track, which is exactly
    // when initFallback creates the canvas
    const videoWidth = this.fallback ? this.canvas!.width : this.video.videoWidth;
    const videoHeight = this.fallback ? this.canvas!.height : this.video.videoHeight;
    box.style.aspectRatio = `${videoWidth} / ${videoHeight}`;

    // in the preview panel, keep the box (and with it the control bar, which fills the box)
    // spanning the panel's full width even for a narrow/portrait video - only its height
    // shrinks to the video, via the max-height cap in PreviewPanel.astro's css, so the video
    // pillarboxes inside instead of the whole player shrinking down to its width
    if (box.hasAttribute("data-pw-box")) {
      box.style.width = "";
      box.style.height = "";
      return;
    }

    const rect = box.getBoundingClientRect();
    const heightConstrained = videoWidth / videoHeight < (rect.width || 1) / (rect.height || 1);
    box.style.width = heightConstrained ? "auto" : "";
    box.style.height = heightConstrained ? "" : "auto";
  }

  // === decode/render fallback ===
  //
  // mirrors mediabunny's own media-player example: rather than re-encoding the whole file
  // into a browser-playable container (which needs an encoder for the target codec and, for
  // very large files, either buffers the whole result in memory or streams it to a scratch
  // file before anything can play), decode frames/samples straight off the source and render
  // them ourselves - a CanvasSink paints video frames onto <canvas>, an AudioBufferSink feeds
  // samples into the Web Audio API. playback can start after the first frame decodes, memory
  // use stays bounded by a small frame/sample pool regardless of file size, and only a decoder
  // (never an encoder) is required for the source codec.

  private async initFallback() {
    this.fallbackAttempted = true;
    const src = this.dataset.src;
    if (!src) return;

    this.classList.add("pw-waiting");
    try {
      mediabunnyPromise ??= loadMediabunny();
      const { Input, ALL_FORMATS, UrlSource, CanvasSink, AudioBufferSink } = await mediabunnyPromise;

      this.input = new Input({ formats: ALL_FORMATS, source: new UrlSource(src) });

      // don't just take the "primary" video track: many pro camera/NLE exports (this is
      // common for prores .movs in particular) embed a separate single-frame poster/thumbnail
      // track alongside the real footage, and mediabunny's primary-track pick can land on
      // that thumbnail instead. scan every video track and use the first one that's both
      // decodable and has more than one frame (a still image isn't "video", it's cover art)
      let videoTrack: Awaited<ReturnType<typeof this.input.getPrimaryVideoTrack>> = null;
      let sawUndecodableVideo = false;
      for (const track of await this.input.getVideoTracks()) {
        const codec = await track.getCodec();
        const decodable = codec !== null && (await track.canDecode());
        if (!decodable) {
          console.error("pw-player: video track not decodable", { src, codec });
          sawUndecodableVideo = true;
          continue;
        }
        const { packetCount } = await track.computePacketStats(2, { skipLiveWait: true });
        if (packetCount >= 2) {
          videoTrack = track;
          break;
        }
      }

      let audioTrack = await this.input.getPrimaryAudioTrack();
      if (audioTrack && (!(await audioTrack.getCodec()) || !(await audioTrack.canDecode()))) audioTrack = null;

      if (!videoTrack && !audioTrack) throw new Error("no decodable track");
      // a decodable audio track alone isn't a substitute for a video track that failed - this
      // is a "video" kind item, so an undecodable video track is a hard failure, not a
      // silent downgrade to audio-only
      if (!videoTrack && sawUndecodableVideo) throw new Error("video track not decodable");

      const tracks = [videoTrack, audioTrack].filter((t): t is NonNullable<typeof t> => t !== null);
      this.firstTimestamp = Math.max(await this.input.getFirstTimestamp(tracks), 0);
      this.endTimestamp =
        (await this.input.getDurationFromMetadata(tracks, { skipLiveWait: true })) ??
        (await this.input.computeDuration(tracks, { skipLiveWait: true }));
      this.playbackTimeAtStart = this.firstTimestamp;

      // the audio context doubles as the playback clock even for video-only files, so
      // getPlaybackTime() below has a single consistent time source either way
      this.audioCtx = new AudioContext({ sampleRate: audioTrack ? await audioTrack.getSampleRate() : undefined });
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.connect(this.audioCtx.destination);
      this.fbUpdateVolume();

      this.videoSink = videoTrack ? new CanvasSink(videoTrack, { poolSize: 2, fit: "contain" }) : undefined;
      this.audioSink = audioTrack ? new AudioBufferSink(audioTrack) : undefined;

      if (videoTrack) {
        // lazily create the canvas surface only now that it's actually needed
        if (!this.canvas) {
          this.canvas = document.createElement("canvas");
          this.canvas.className = "pw-canvas";
          this.video.insertAdjacentElement("afterend", this.canvas);
          this.bindSurfaceEvents(this.canvas);
          this.ctx = this.canvas.getContext("2d")!;
        }
        this.canvas.width = await videoTrack.getDisplayWidth();
        this.canvas.height = await videoTrack.getDisplayHeight();
      }

      this.fallback = true;
      this.setAttribute("data-engine", "fallback");
      this.$(".pw-pip").style.display = "none"; // no captureStream()-based PiP for the canvas path
      this.setMode(videoTrack ? "video" : "audio");
      this.sizeBox();
      this.$(".pw-dur").textContent = formatTime(this.fbDuration());

      await this.fbStartVideoIterator();
      this.renderProgress();
      this.renderPlayState();

      this.fbRafId = requestAnimationFrame(() => this.fbLoop());
      // also tick on an interval so progress keeps updating in backgrounded tabs, where rAF is throttled
      this.fbIntervalId = window.setInterval(() => this.fbLoop(false), 500);
    } catch (err) {
      console.error("pw-player: decode/render fallback failed", src, err);
      this.classList.add("pw-failed");
    } finally {
      this.classList.remove("pw-waiting");
    }
  }

  private fbDuration(): number {
    return this.endTimestamp - this.firstTimestamp;
  }

  // playback position, in the same "seconds from zero" units the native <video> uses
  private fbCurrentTime(): number {
    if (!this.playing || !this.audioCtx) return this.playbackTimeAtStart - this.firstTimestamp;
    return this.playbackTimeAtStart - this.firstTimestamp + (this.audioCtx.currentTime - this.audioCtxStartTime) * this.rate;
  }

  private async fbStartVideoIterator() {
    if (!this.videoSink) return;
    const id = ++this.fbAsyncId;

    await this.videoFrameIterator?.return();
    this.videoFrameIterator = this.videoSink.canvases(this.firstTimestamp + this.fbCurrentTime());

    const first = (await this.videoFrameIterator.next()).value ?? undefined;
    if (id !== this.fbAsyncId) return;
    const second = (await this.videoFrameIterator.next()).value ?? undefined;
    if (id !== this.fbAsyncId) return;

    this.nextFrame = second;
    if (first) {
      this.ctx!.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
      this.ctx!.drawImage(first.canvas, 0, 0);
    }
  }

  // runs every frame (plus a background-tab-safe interval) while in fallback mode; advances
  // the canvas and progress bar to match the audio-context clock
  private fbLoop = (requestNext = true) => {
    if (this.fallback) {
      const t = this.fbCurrentTime();
      if (this.playing && t >= this.fbDuration()) {
        this.fbPause();
        this.fbEnded = true;
        this.playbackTimeAtStart = this.endTimestamp;
        this.renderPlayState();
      }

      if (this.nextFrame && this.nextFrame.timestamp - this.firstTimestamp <= this.fbCurrentTime()) {
        this.ctx!.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
        this.ctx!.drawImage(this.nextFrame.canvas, 0, 0);
        this.nextFrame = undefined;
        void this.fbAdvanceFrame();
      }

      if (!this.scrubbing) this.renderProgress();
    }

    if (requestNext) this.fbRafId = requestAnimationFrame(() => this.fbLoop());
  };

  // iterates the video frame generator until it finds a frame still in the future
  private async fbAdvanceFrame() {
    const id = this.fbAsyncId;
    while (this.videoFrameIterator) {
      const value = (await this.videoFrameIterator.next()).value ?? undefined;
      if (!value || id !== this.fbAsyncId) break;

      if (value.timestamp - this.firstTimestamp <= this.fbCurrentTime()) {
        this.ctx!.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
        this.ctx!.drawImage(value.canvas, 0, 0);
      } else {
        this.nextFrame = value;
        break;
      }
    }
  }

  // schedules decoded audio buffers onto the audio context at the right wall-clock time,
  // accounting for the current playback rate
  private async fbRunAudioIterator() {
    if (!this.audioSink || !this.audioCtx || !this.gainNode) return;

    const iterator = this.audioSink.buffers(this.firstTimestamp + this.fbCurrentTime());
    this.audioBufferIterator = iterator;
    const relativeStart = this.playbackTimeAtStart - this.firstTimestamp;

    for await (const { buffer, timestamp } of iterator) {
      if (this.audioBufferIterator !== iterator) return;

      const node = this.audioCtx.createBufferSource();
      node.buffer = buffer;
      node.playbackRate.value = this.rate;
      node.connect(this.gainNode);

      const relativeTimestamp = timestamp - this.firstTimestamp;
      let startTime = this.audioCtxStartTime + (relativeTimestamp - relativeStart) / this.rate;
      startTime = Math.round(this.audioCtx.sampleRate * startTime) / this.audioCtx.sampleRate;

      if (startTime >= this.audioCtx.currentTime) {
        node.start(startTime);
      } else {
        // already past due - play only the remaining audible tail
        node.start(this.audioCtx.currentTime, (this.audioCtx.currentTime - startTime) * this.rate);
      }

      this.queuedAudioNodes.add(node);
      node.onended = () => this.queuedAudioNodes.delete(node);

      // don't decode too far ahead of playback
      if (relativeTimestamp - this.fbCurrentTime() >= 1) {
        await new Promise<void>(resolve => {
          const id = setInterval(() => {
            if (relativeTimestamp - this.fbCurrentTime() < 1) {
              clearInterval(id);
              resolve();
            }
          }, 100);
        });
      }
    }
  }

  private async fbPlay() {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === "suspended") await this.audioCtx.resume();

    if (this.fbEnded || this.fbCurrentTime() >= this.fbDuration()) {
      this.playbackTimeAtStart = this.firstTimestamp;
      this.fbEnded = false;
      await this.fbStartVideoIterator();
    }

    this.audioCtxStartTime = this.audioCtx.currentTime;
    this.playing = true;

    if (this.audioSink) {
      void this.audioBufferIterator?.return();
      void this.fbRunAudioIterator();
    }

    this.renderPlayState();
  }

  private fbPause() {
    this.playbackTimeAtStart = this.fbCurrentTime() + this.firstTimestamp;
    this.playing = false;
    void this.audioBufferIterator?.return();
    this.audioBufferIterator = undefined;

    for (const node of this.queuedAudioNodes) node.stop();
    this.queuedAudioNodes.clear();

    this.renderPlayState();
  }

  // seconds are in the same "from zero" units as fbCurrentTime()/the native video's currentTime
  private async fbSeek(seconds: number) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.fbPause();

    this.playbackTimeAtStart = this.firstTimestamp + Math.min(Math.max(seconds, 0), this.fbDuration());
    this.fbEnded = false;
    await this.fbStartVideoIterator();
    this.renderProgress();

    if (wasPlaying) await this.fbPlay();
  }

  private async fbSetRate(rate: number) {
    const wasPlaying = this.playing;
    if (wasPlaying) this.fbPause();
    this.rate = rate;
    if (wasPlaying) await this.fbPlay();
  }

  private fbUpdateVolume() {
    if (this.gainNode) this.gainNode.gain.value = this.muted ? 0 : this.volume;
  }

  private fbTeardown() {
    cancelAnimationFrame(this.fbRafId);
    clearInterval(this.fbIntervalId);
    this.fbAsyncId++;
    void this.videoFrameIterator?.return();
    void this.audioBufferIterator?.return();
    for (const node of this.queuedAudioNodes) node.stop();
    this.queuedAudioNodes.clear();
    void this.audioCtx?.close();
  }

  // === end decode/render fallback ===

  private togglePlay() {
    if (this.fallback) {
      if (this.playing) this.fbPause();
      else void this.fbPlay().catch(() => this.classList.add("pw-failed"));
      return;
    }
    if (this.video.paused || this.video.ended) void this.video.play().catch(() => this.classList.add("pw-failed"));
    else this.video.pause();
  }

  private skip(secs: number) {
    if (this.fallback) {
      void this.fbSeek(Math.min(Math.max(this.fbCurrentTime() + secs, 0), this.fbDuration()));
      return;
    }
    this.video.currentTime = Math.min(Math.max(this.video.currentTime + secs, 0), this.video.duration || Infinity);
  }

  private setSpeed(speed: number) {
    if (this.fallback) void this.fbSetRate(speed);
    else this.video.playbackRate = speed;
    this.$(".pw-speed").textContent = `${speed}x`;
    this.$(".pw-menu").classList.remove("pw-open");
    for (const btn of this.querySelectorAll<HTMLButtonElement>(".pw-menu button")) {
      btn.classList.toggle("pw-active", Number(btn.dataset.speed) === speed);
    }
  }

  private setVolume(v: number) {
    v = Math.min(Math.max(v, 0), 1);
    this.volume = v;
    this.muted = v === 0 ? this.muted : false;
    if (this.fallback) this.fbUpdateVolume();
    else {
      this.video.volume = v;
      this.video.muted = this.muted;
    }
    localStorage.setItem(VOLUME_KEY, String(v));
    localStorage.setItem(MUTED_KEY, this.muted ? "1" : "0");
    this.renderVolume();
  }

  private toggleMute() {
    this.muted = !this.muted;
    if (this.fallback) this.fbUpdateVolume();
    else this.video.muted = this.muted;
    localStorage.setItem(MUTED_KEY, this.muted ? "1" : "0");
    this.renderVolume();
  }

  private toggleFullscreen() {
    if (this.getAttribute("mode") === "audio") return;
    if (document.fullscreenElement === this) void document.exitFullscreen();
    else void this.requestFullscreen().catch(() => {});
  }

  private renderPlayState() {
    const paused = this.fallback ? !this.playing : this.video.paused;
    const ended = this.fallback ? this.fbEnded : this.video.ended;
    this.classList.toggle("pw-paused", paused && !ended);
    this.classList.toggle("pw-ended", ended);
    this.$(".pw-play").innerHTML = ended ? ICONS.replay : paused ? ICONS.play : ICONS.pause;
    this.$(".pw-state").innerHTML = ended ? ICONS.replay : ICONS.play;
    this.wakeControls();
  }

  private renderProgress(overrideTime?: number) {
    const currentTime = overrideTime ?? (this.fallback ? this.fbCurrentTime() : this.video.currentTime);
    const duration = this.fallback ? this.fbDuration() : this.video.duration;
    const frac = duration ? currentTime / duration : 0;
    this.$(".pw-fill").style.width = `${frac * 100}%`;
    this.$(".pw-thumb").style.left = `${frac * 100}%`;
    this.$(".pw-cur").textContent = formatTime(currentTime);
  }

  private renderBuffered() {
    if (this.fallback) return; // no buffered-ranges concept for the decode/render fallback
    const { buffered, duration } = this.video;
    if (!duration || buffered.length === 0) return;
    this.$(".pw-buf").style.width = `${(buffered.end(buffered.length - 1) / duration) * 100}%`;
  }

  private renderVolume() {
    const muted = this.fallback ? this.muted : this.video.muted;
    const volume = this.fallback ? this.volume : this.video.volume;
    this.$(".pw-mute").innerHTML = muted || volume === 0 ? ICONS.volMute : volume < 0.5 ? ICONS.volLow : ICONS.volHigh;
    (this.$(".pw-vol") as HTMLInputElement).value = String(muted ? 0 : volume);
  }

  private bindSeek() {
    const seek = this.$(".pw-seek");
    const tip = this.$(".pw-tip");

    const timeAt = (e: PointerEvent): number => {
      const rect = seek.getBoundingClientRect();
      const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      const duration = this.fallback ? this.fbDuration() : this.video.duration || 0;
      return frac * duration;
    };

    seek.addEventListener("pointerdown", e => {
      this.scrubbing = true;
      this.classList.add("pw-seeking");
      this.wasPlayingBeforeScrub = this.fallback ? this.playing : !this.video.paused;
      seek.setPointerCapture(e.pointerId);

      if (this.fallback) {
        // restarting decode on every pointer event would be far too expensive - only
        // preview the time while dragging, and seek for real on release (see pointerup)
        if (this.playing) this.fbPause();
        this.renderProgress(timeAt(e));
      } else {
        this.video.pause();
        this.video.currentTime = timeAt(e);
      }
    });

    seek.addEventListener("pointermove", e => {
      const rect = seek.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(e.clientX - rect.left, 0), rect.width)}px`;
      tip.textContent = formatTime(timeAt(e));
      if (!this.scrubbing) return;
      if (this.fallback) this.renderProgress(timeAt(e));
      else this.video.currentTime = timeAt(e);
    });

    seek.addEventListener("pointerup", e => {
      this.scrubbing = false;
      this.classList.remove("pw-seeking");

      if (this.fallback) {
        void this.fbSeek(timeAt(e)).then(() => {
          if (this.wasPlayingBeforeScrub) void this.fbPlay();
        });
      } else if (this.wasPlayingBeforeScrub) {
        void this.video.play().catch(() => {});
      }
    });
  }

  private wakeControls() {
    this.classList.remove("pw-hide");
    clearTimeout(this.hideTimer);
    const paused = this.fallback ? !this.playing : this.video.paused;
    if (this.getAttribute("mode") !== "video" || paused) return;
    this.hideTimer = setTimeout(() => {
      if (!this.scrubbing && !this.$(".pw-menu").classList.contains("pw-open")) this.classList.add("pw-hide");
    }, 2500);
  }

  // only the player on the currently shown lightbox slide responds to the keyboard - but
  // outside of fancybox (i.e. the preview panel, which only ever hosts one player at a time)
  // there's no slide to check, so it's active by default
  private isActive(): boolean {
    const slide = this.closest(".fancybox__slide");
    return slide ? slide.classList.contains("is-selected") : true;
  }

  private handleKey(e: KeyboardEvent) {
    if (!this.isActive() || e.target instanceof HTMLInputElement) return;

    const currentVolume = this.fallback ? this.volume : this.video.volume;
    const actions: Record<string, () => void> = {
      " ": () => this.togglePlay(),
      k: () => this.togglePlay(),
      ArrowLeft: () => this.skip(-5),
      ArrowRight: () => this.skip(5),
      j: () => this.skip(-10),
      l: () => this.skip(10),
      ArrowUp: () => this.setVolume(currentVolume + 0.05),
      ArrowDown: () => this.setVolume(currentVolume - 0.05),
      m: () => this.toggleMute(),
      f: () => this.toggleFullscreen()
    };

    const action = actions[e.key];
    if (!action) return; // escape & friends stay with fancybox

    // fancybox binds arrow keys to slide navigation - the player wins while it's shown
    e.preventDefault();
    e.stopImmediatePropagation();
    action();
    this.wakeControls();
  }
}

customElements.define("pw-player", PwPlayer);
