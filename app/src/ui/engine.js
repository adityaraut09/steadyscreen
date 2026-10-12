// Pose engine: loads the locally vendored MediaPipe Pose Landmarker and turns video frames into the
// core's frame format {t, poses:[[x,y,z,visibility,presence] x33]}. No network access beyond this origin.
import { FilesetResolver, PoseLandmarker } from "../../vendor/tasks-vision/vision_bundle.mjs";

const WASM = new URL("../../vendor/tasks-vision/wasm", import.meta.url).href;
const MODEL = new URL("../../vendor/models/pose_landmarker_full.task", import.meta.url).href;

// One landmarker lives for the whole page, and MediaPipe VIDEO mode needs strictly increasing timestamps
// across ALL calls. Media time restarts at 0 for every replay, so the model gets its own monotonic clock;
// the measurement core still receives the source timestamps.
let lmClock = 0;
function clockFor() { const base = lmClock + 1000; let first = null;
  return (t) => { if (first === null) first = t; const ts = Math.max(lmClock + 1, Math.round(base + (t - first))); lmClock = ts; return ts; }; }

export async function loadLandmarker({ numPoses = 2, preferGPU = true, modelUrl = MODEL } = {}) {
  const t0 = performance.now();
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  let lastErr = null;
  for (const delegate of preferGPU ? ["GPU", "CPU"] : ["CPU"]) {
    try {
      const lm = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: "VIDEO", numPoses,
        minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      return { landmarker: lm, delegate, startupMs: Math.round(performance.now() - t0) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("pose model failed to load");
}

/** Convert a PoseLandmarkerResult to the core's pose arrays. Missing visibility is kept as 0 (never assumed visible). */
export function toPoses(res) {
  return (res.landmarks || []).map((pose) => pose.map((p) => [p.x, p.y, p.z ?? 0, p.visibility ?? 0, p.presence ?? 0]));
}

/**
 * Live / real-time frame loop on a <video> element using requestVideoFrameCallback.
 * Timestamps: live camera -> rVFC 'now' (performance clock); file replay -> mediaTime (ms).
 * Frame accounting (audit H; MDN: presentedFrames gaps reveal frames with no callback):
 *   presentedSpan  = presentedFrames(last) - presentedFrames(first) + 1   (frames the compositor presented)
 *   callbacks      = rVFC callbacks received
 *   analysed       = frames passed to the pose model
 *   notAnalysed    = presentedSpan - analysed  (missed callbacks + busy + duplicates + failures)
 * onFrame({t, poses}) is called for every analysed frame; nothing is invented for frames that were not analysed.
 * Demo mode (source "demo"): no pose model runs; simulate(t) returns the simulated participant's poses for the frame at
 * performance time t (the video shows the demo's drawn scene). Timestamps and frame accounting are as for the camera.
 */
export function startFrameLoop(video, landmarker, { source, onFrame, onError, simulate = null }) {
  let stopped = false, busy = false, lastT = -Infinity, handle = null;
  const st = { callbacks: 0, analysed: 0, busySkips: 0, duplicates: 0, failures: 0, presentedFirst: null, presentedLast: null, lastError: null };
  const inferMs = [];
  const clock = clockFor();
  const tick = (now, meta) => {
    if (stopped) return;
    handle = video.requestVideoFrameCallback(tick);
    st.callbacks += 1;
    if (meta && Number.isFinite(meta.presentedFrames)) { if (st.presentedFirst === null) st.presentedFirst = meta.presentedFrames; st.presentedLast = meta.presentedFrames; }
    if (busy) { st.busySkips += 1; return; }
    const t = source === "camera" || source === "demo" ? now : meta.mediaTime * 1000;
    if (!(t > lastT)) { st.duplicates += 1; return; }
    busy = true;
    try {
      const s = performance.now();
      const res = simulate ? null : landmarker.detectForVideo(video, clock(t));
      inferMs.push(performance.now() - s); if (inferMs.length > 300) inferMs.shift();
      lastT = t; st.analysed += 1;
      onFrame({ t, poses: simulate ? simulate(t) : toPoses(res) });
    } catch (e) { st.failures += 1; st.lastError = String(e && e.message || e); onError && onError(e); }
    finally { busy = false; }
  };
  handle = video.requestVideoFrameCallback(tick);
  return {
    stop() { stopped = true; if (handle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); },
    stats() {
      const s = [...inferMs].sort((a, b) => a - b);
      const span = st.presentedFirst === null ? null : st.presentedLast - st.presentedFirst + 1;
      return { timestampDomain: source === "camera" ? "performance.now (camera frame presentation)" : source === "demo" ? "performance.now (simulated demo frames; no pose model)" : "mediaTime (video file)",
        presentedSpan: span, callbacks: st.callbacks, analysed: st.analysed, notAnalysed: span === null ? null : Math.max(0, span - st.analysed),
        busySkips: st.busySkips, duplicates: st.duplicates, failures: st.failures, lastError: st.lastError,
        medianInferMs: s.length ? +s[s.length >> 1].toFixed(1) : null, p95InferMs: s.length ? +s[Math.floor(s.length * 0.95)].toFixed(1) : null };
    },
  };
}

/**
 * Deterministic replay (test harness only): seek frame by frame, wait until the seeked frame is actually
 * presented (rVFC) with explicit timeouts, pass a decoded ImageBitmap, use monotonic timestamps.
 * Every frame that times out is reported as a failure - never silently analysed from a stale image.
 */
export async function deterministicReplay(video, landmarker, { fps, onFrame, frameTimeoutMs = 3000, maxFrames = Infinity }) {
  const clock = clockFor();
  const n = Math.min(maxFrames, Math.floor(video.duration * fps));
  const failures = []; const inferMs = [];
  const wait = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timeout")), ms))]);
  for (let i = 0; i < n; i++) {
    const target = (i + 0.5) / fps;
    try {
      const presented = new Promise((res) => video.requestVideoFrameCallback((now, meta) => res(meta)));
      const seeked = new Promise((res) => video.addEventListener("seeked", res, { once: true }));
      video.currentTime = target;
      await wait(seeked, frameTimeoutMs, "seek");
      const meta = await wait(presented, frameTimeoutMs, "present");
      const bmp = await createImageBitmap(video);
      const t = Math.round(i * 1000 / fps);
      const s = performance.now();
      const res = landmarker.detectForVideo(bmp, clock(t));
      inferMs.push(performance.now() - s);
      bmp.close();
      onFrame({ t, poses: toPoses(res), mediaTime: meta.mediaTime });
    } catch (e) { failures.push({ frame: i, error: String(e.message || e) }); }
  }
  const s = [...inferMs].sort((a, b) => a - b);
  return { frames: n, failures, medianInferMs: s.length ? +s[s.length >> 1].toFixed(1) : null, p95InferMs: s.length ? +s[Math.floor(s.length * 0.95)].toFixed(1) : null };
}
