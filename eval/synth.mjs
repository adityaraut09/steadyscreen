// Synthetic landmark streams with exact ground truth, for engineering tests of the chair-stand core.
// These are NOT evidence about real people: they exercise protocol rules, boundaries and failure handling.
//
// Geometry (pixels, side-ish view): ankle fixed, knee fixed, thigh rotates from horizontal (seated)
// to vertical (standing). alpha in [0,1] is rise progress; thigh angle = 90deg * alpha, so the
// normalised hip height h = 1.1 * sin(90deg * alpha) (seated ~0, standing 1.1, halfway at alpha = 1/3).

const SHIN = 200, THIGH = 220, TRUNK = 300;

export function rng(seed) {                 // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/** Build a skeleton (33 landmarks, normalised) for rise progress alpha. */
export function skeleton(alpha, { x0 = 400, y0 = 1150, W = 720, H = 1280, arms = "crossed", legVis = 0.95, vis = 0.95, view = "side", leanExtra = 0 } = {}) {
  if (view === "frontal") return skeletonFrontal(alpha, { x0, y0, W, H, legVis, vis, leanExtra });
  const th = (Math.PI / 2) * Math.max(0, Math.min(1, alpha));
  const ankle = [x0, y0], knee = [x0, y0 - SHIN];
  const hip = [knee[0] - THIGH * Math.cos(th), knee[1] - THIGH * Math.sin(th)];
  const lean = (alpha > 0.02 && alpha < 0.98 ? 0.6 * Math.sin(Math.PI * alpha) : 0) + 0.1 * (1 - alpha) + leanExtra; // forward lean mid-rise (+ habitual stoop)
  const sh = [hip[0] + TRUNK * Math.sin(lean), hip[1] - TRUNK * Math.cos(lean)];
  const head = [sh[0] + 20, sh[1] - 90];
  const pts = new Array(33).fill(null).map(() => [...head]);
  const set = (i, p, v = vis) => { pts[i] = [p[0], p[1], v]; };
  for (let i = 0; i <= 10; i++) set(i, [head[0] + (i % 3) * 6, head[1] + Math.floor(i / 3) * 6]);
  set(11, [sh[0] - 12, sh[1]]); set(12, [sh[0] + 12, sh[1]]);
  const lw = arms === "crossed" ? [sh[0] + 20, sh[1] + 30] : [hip[0] - 10, hip[1] + 10];
  const rw = arms === "crossed" ? [sh[0] - 20, sh[1] + 30] : [hip[0] + 10, hip[1] + 10];
  set(13, [sh[0] + 30, sh[1] + 70]); set(14, [sh[0] - 30, sh[1] + 70]);
  set(15, lw); set(16, rw);
  for (const [i, p] of [[17, lw], [19, lw], [21, lw], [18, rw], [20, rw], [22, rw]]) set(i, p);
  set(23, [hip[0] - 10, hip[1]], legVis); set(24, [hip[0] + 10, hip[1]], legVis);
  set(25, [knee[0] - 10, knee[1]], legVis); set(26, [knee[0] + 10, knee[1]], legVis);
  set(27, [ankle[0] - 10, ankle[1]], legVis); set(28, [ankle[0] + 10, ankle[1]], legVis);
  for (const [i, p] of [[29, ankle], [30, ankle], [31, [ankle[0] + 40, ankle[1]]], [32, [ankle[0] + 40, ankle[1]]]]) set(i, p, legVis);
  return pts.map(([x, y, v]) => [x / W, y / H, 0, v ?? vis, 0.99]);
}


// Frontal view (camera faces the participant): the same sagittal motion, but joint x positions collapse per leg,
// so 2-D knee/hip angles stay ~straight whatever the flexion; only vertical distances change. Shoulders are wide.
function skeletonFrontal(alpha, { x0, y0, W, H, legVis, vis, leanExtra }) {
  const th = (Math.PI / 2) * Math.max(0, Math.min(1, alpha));
  const kneeY = y0 - SHIN, hipY = kneeY - THIGH * Math.sin(th);
  const lean = (alpha > 0.02 && alpha < 0.98 ? 0.6 * Math.sin(Math.PI * alpha) : 0) + 0.1 * (1 - alpha) + leanExtra;
  const shY = hipY - TRUNK * Math.cos(lean), headY = shY - 90;
  const pts = new Array(33).fill(null).map(() => [x0, headY, vis]);
  const set = (i, x, y, v = vis) => { pts[i] = [x, y, v]; };
  for (let i = 0; i <= 10; i++) set(i, x0 - 12 + (i % 3) * 12, headY + Math.floor(i / 3) * 6);
  set(11, x0 - 120, shY); set(12, x0 + 120, shY);
  set(13, x0 - 40, shY + 60); set(14, x0 + 40, shY + 60); set(15, x0 + 70, shY + 20); set(16, x0 - 70, shY + 20);
  for (const i of [17, 19, 21]) set(i, x0 + 70, shY + 20); for (const i of [18, 20, 22]) set(i, x0 - 70, shY + 20);
  set(23, x0 - 50, hipY, legVis); set(24, x0 + 50, hipY, legVis);
  set(25, x0 - 55, kneeY, legVis); set(26, x0 + 55, kneeY, legVis);
  set(27, x0 - 55, y0, legVis); set(28, x0 + 55, y0, legVis);
  set(29, x0 - 55, y0, legVis); set(30, x0 + 55, y0, legVis); set(31, x0 - 55, y0 + 10, legVis); set(32, x0 + 55, y0 + 10, legVis);
  return pts.map(([x, y, v]) => [x / W, y / H, 0, v, 0.99]);
}

/**
 * Motion script -> alpha(t). Segments: ["sit", ms] ["rise", ms] ["stand", ms] ["descend", ms]
 * ["partial", ms, peakAlpha] (up and back down without reaching standing).
 * Returns {alphaAt(t), stands:[t when alpha first reaches 1], partials:[...] }.
 */
export function motion(script) {
  const segs = []; let t = 0; let a = 0;
  for (const [type, dur, peak] of script) {
    const a0 = a; let a1 = a;
    if (type === "rise") a1 = 1; else if (type === "descend") a1 = 0; else if (type === "sit") a1 = 0; else if (type === "stand") a1 = 1;
    segs.push({ type, t0: t, t1: t + dur, a0: type === "sit" ? 0 : type === "stand" ? 1 : a0, a1, peak });
    t += dur; a = type === "partial" ? 0 : a1;
  }
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, u)));
  const alphaAt = (tt) => {
    for (const s of segs) {
      if (tt < s.t0 || tt >= s.t1) continue;
      const u = (tt - s.t0) / (s.t1 - s.t0);
      if (s.type === "partial") return s.peak * Math.sin(Math.PI * u);
      return s.a0 + (s.a1 - s.a0) * ease(u);
    }
    return a;
  };
  const stands = segs.filter((s) => s.type === "rise").map((s) => s.t1);
  const partials = segs.filter((s) => s.type === "partial").map((s) => s.t0);
  return { alphaAt, stands, partials, totalMs: t };
}

/**
 * Render frames. opts: fps, durationMs, seed, noisePx, dropFrac (random missing poses),
 * gaps [[t0,t1]] (no frames at all: hidden tab / decoder stall), poseGaps [[t0,t1]] (frames but no pose),
 * legOcclusion [[t0,t1]], drift {dx, dy, scale0, scale1}, arms, helper {mode, ...}, swapFrac, visScale.
 */
export function render(script, opts = {}) {
  const { fps = 30, seed = 1, noisePx = 1.5, dropFrac = 0, gaps = [], poseGaps = [], legOcclusion = [],
    drift = null, arms = "crossed", helper = null, swapFrac = 0, W = 720, H = 1280, visScale = 1, view = "side", leanExtra = 0 } = opts;
  const m = motion(script);
  const durationMs = opts.durationMs ?? m.totalMs;
  const r = rng(seed); const frames = [];
  const inAny = (t, list) => list.some(([a, b]) => t >= a && t < b);
  for (let i = 0; ; i++) {
    const t = Math.round(i * 1000 / fps);
    if (t > durationMs) break;
    if (inAny(t, gaps)) continue;
    const alpha = m.alphaAt(t);
    const u = t / Math.max(1, durationMs);
    let x0 = 400, y0 = 1150, sc = 1;
    if (drift) { x0 += drift.dx * u; y0 += drift.dy * u; sc = drift.scale0 + (drift.scale1 - drift.scale0) * u; }
    let lm = skeleton(alpha, { W, H, arms, x0, y0, view, leanExtra, legVis: inAny(t, legOcclusion) ? 0.2 : 0.95 * visScale, vis: 0.95 * visScale });
    if (sc !== 1) lm = lm.map(([x, y, z, v, p]) => [(x - x0 / W) * sc + x0 / W, (y - y0 / H) * sc + y0 / H, z, v, p]);
    lm = lm.map(([x, y, z, v, p]) => [x + (noisePx * gauss(r)) / W, y + (noisePx * gauss(r)) / H, z, v, p]);
    if (swapFrac && r() < swapFrac) { const k = lm[25]; lm[25] = lm[23]; lm[23] = k; const k2 = lm[26]; lm[26] = lm[24]; lm[24] = k2; }
    const poses = [];
    if (!inAny(t, poseGaps) && !(dropFrac && r() < dropFrac)) poses.push(lm);
    if (helper) {
      const hx = helper.xAt ? helper.xAt(t) : helper.x;
      if (hx !== null && hx !== undefined) {
        const ha = helper.alphaAt ? helper.alphaAt(t) : helper.seated ? 0 : 1;   // seated helper = alpha 0 (fixes checkpoint-2 fixture that drew a standing helper)
        const hl = skeleton(ha, { W, H, x0: hx, y0: helper.y0 ?? 1150, view }).map(([x, y, z, v, p]) => [x + (noisePx * gauss(r)) / W, y + (noisePx * gauss(r)) / H, z, v, p]);
        if (helper.first) poses.unshift(hl); else poses.push(hl);
      }
    }
    frames.push({ t, poses });
  }
  return { width: W, height: H, fps, frames, truth: m };
}

/**
 * CDC reference count for a synthetic script with Go at tGo: full stands reached in (tGo, tGo+30s],
 * plus one if at expiry the participant is on the way up and over halfway in hip height.
 */
export function referenceCount(m, tGo, windowMs = 30000) {
  const tEnd = tGo + windowMs;
  let n = m.stands.filter((t) => t > tGo && t <= tEnd).length;
  const a = m.alphaAt(tEnd), aPrev = m.alphaAt(tEnd - 100);
  const hNow = 1.1 * Math.sin((Math.PI / 2) * a);
  const rising = a > aPrev + 1e-6 && a < 1;
  if (rising && hNow > 0.55) n += 1;         // halfway between seated (~0) and standing (1.1)
  return { count: n, halfwayCase: rising ? (hNow > 0.55 ? "over" : "under") : "none", hAtExpiry: +hNow.toFixed(3) };
}

/**
 * Independent CDC reference for scripts (checkpoint 3). Counts rise segments that reach full extension
 * (alpha = 1) at or before expiry, plus the CDC position rule at expiry: an attempt that has left the seat,
 * has not yet reached full standing in this attempt, and whose hip is more than halfway (in hip height) between
 * seated and standing -> +1. No velocity condition. Cases within +/-nearBand of halfway are reported as "near".
 * A descending attempt that never reached standing is reported as "descending_uncounted_attempt" (the CDC text
 * states position only; tests accept either counting it or a review flag).
 */
export function referencePositionCount(script, tGo, windowMs = 30000, nearBand = 0.07) {
  const m = motion(script); const tEnd = tGo + windowMs;
  const n = m.stands.filter((t) => t > tGo && t <= tEnd).length;
  let t0 = 0, cur = null;
  for (const [type, dur, peak] of script) { if (tEnd >= t0 && tEnd < t0 + dur) cur = { type, t0, dur, peak }; t0 += dur; }
  const a = m.alphaAt(tEnd);
  const frac = Math.sin((Math.PI / 2) * a);               // hip-height fraction of the seated->standing displacement
  let kase = "none";
  if (cur && (cur.type === "rise" || cur.type === "partial")) {
    const u = (tEnd - cur.t0) / cur.dur;
    const descending = cur.type === "partial" && u > 0.5;
    if (Math.abs(frac - 0.5) <= nearBand) kase = "near";
    else if (frac > 0.5) kase = descending ? "descending_uncounted_attempt" : "over";
    else kase = "under";
  }
  return { count: n + (kase === "over" ? 1 : 0), fullStandsBeforeExpiry: n, case: kase, fracAtExpiry: +frac.toFixed(3) };
}

/** Standard practice-stand prefix used by checkpoint-3 tests: sit still, one full practice stand held 1 s, sit still. */
export const PRACTICE = [["sit", 1500], ["rise", 800], ["stand", 1000], ["descend", 800], ["sit", 1600]];
export const PRACTICE_GO = 5700;   // Go time (ms) right after the practice prefix
