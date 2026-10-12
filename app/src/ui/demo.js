// Demo mode: a SIMULATED participant, so the whole workflow (setup, camera check, practice-stand card, GO, 30-s count,
// review, summary) can be tried without a camera, a chair or a helper. Nothing here measures a person.
//
// - The scene (floor, a straight-backed chair without arm rests, a drawn figure with arms crossed) is painted on an
//   offscreen canvas and piped into the app's <video> element with canvas.captureStream(), so the overlay and the
//   evidence images work exactly as with a camera. Every frame carries a burned-in "SIMULATED PARTICIPANT" label.
// - No pose model runs. The body points for each frame are generated from the SAME geometry that is drawn (a port of
//   skeleton() in eval/synth.mjs: thigh angle 90deg * alpha, hip height h = 1.1 * sin(90deg * alpha)), with small
//   seeded jitter, and go through the unchanged counting core.
// - The script reacts to the app: seated, one genuine full practice stand (repeated if the observer rejects it or it
//   goes stale), seated until GO; after GO a fixed, deterministic sequence of stands (see STANDS).
// This module has no DOM access at import time, so the script can be tested in Node (tests/demo.test.mjs).

export const DEMO_LABEL = "Simulated demo — not a real person, not a real measurement";
export const DEMO_BADGE = "SIMULATED DEMO — not a real person, not a real measurement";
export const CANVAS_LABEL = "SIMULATED PARTICIPANT - demo only";
export const DEMO_W = 1280, DEMO_H = 720;
export const DEMO_SEED = 20261012;

// ---- script (all times in ms) ----
export const PRACTICE = Object.freeze({ firstLeadMs: 2500, repeatLeadMs: 1500, riseMs: 1000, holdMs: 1500, descendMs: 1000 });
export const GO_LEAD_MS = 300;                                                // reaction time after GO
// After GO: [riseMs, holdMs, descendMs, sitMs, topAlpha]. Cycles 2.55-2.75 s. Stand 5 tops out short (alpha 0.87:
// drawn with knees ~12 deg bent and the trunk stooped ~14 deg; hip height only ~0.02 short). The core sees the hip angle
// short beyond the full-stand band (fullHipDeg 4), so it is not counted, but not the strong evidence needed to call it
// "partial" silently (knee > 2 x 7 AND hip > 2 x 4 deg, or hip height > 2 x 0.12), so it asks for the observer's decision.
export const STANDS = Object.freeze([
  [900, 350, 850, 450, 1], [900, 350, 850, 450, 1], [900, 350, 900, 450, 1], [950, 350, 900, 400, 1],
  [950, 500, 850, 400, 0.87],
  [900, 350, 900, 550, 1], [950, 350, 900, 450, 1], [950, 350, 900, 450, 1], [950, 350, 900, 450, 1],
  [1000, 350, 900, 500, 1], [1000, 350, 900, 400, 1],
]);
// ...then one more rise (1 s) that is about 65% done, clearly over halfway in hip height, at the 30-s mark
// (GO + 300 + 29050 = 29350 ms): the CDC rule counts it.
export const LAST_RISE_MS = 1000;
/** What the core should find (verified in tests/demo.test.mjs). */
export const EXPECTED = Object.freeze({ full: 10, uncertain: 1, expiry: 1, counted: 11, rangeMin: 11, rangeMax: 12, uncertainRise: 5 });

const PRACTICE_AGAIN = new Set(["practice_stand_needed", "reference_stale", "reference_person_changed", "reference_camera_or_person_changed"]);

// ---- geometry (reference units of eval/synth.mjs: 720x1280 portrait; mapped onto the 1280x720 canvas) ----
const SHIN = 200, THIGH = 220, TRUNK = 300, ANKLE = [400, 1150], FLOOR_Y = 1175;
const S = 0.7, OX = 640, RX = 270, OY = 662;
const cx = (x) => OX + S * (x - RX), cy = (y) => OY + S * (y - FLOOR_Y);
const clamp01 = (a) => Math.max(0, Math.min(1, a));
const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u));

/** Body joints (reference units) for rise progress alpha (0 seated .. 1 standing). Legs and trunk exactly as synth skeleton(). */
export function bodyAt(alpha) {
  const a = clamp01(alpha), th = (Math.PI / 2) * a;
  const ankle = [...ANKLE], knee = [ANKLE[0], ANKLE[1] - SHIN];
  const hip = [knee[0] - THIGH * Math.cos(th), knee[1] - THIGH * Math.sin(th)];
  const lean = (a > 0.02 && a < 0.98 ? 0.6 * Math.sin(Math.PI * a) : 0) + 0.1 * (1 - a);   // forward lean mid-rise
  const up = [Math.sin(lean), -Math.cos(lean)], fwd = [Math.cos(lean), Math.sin(lean)];
  const sh = [hip[0] + TRUNK * up[0], hip[1] + TRUNK * up[1]];
  const at = (u, f) => [sh[0] + u * up[0] + f * fwd[0], sh[1] + u * up[1] + f * fwd[1]];
  // arms crossed on the chest (side view): elbow below and in front of the shoulder, hand back on the chest
  return { alpha: a, lean, ankle, knee, hip, sh, head: at(90, 20), elbow: at(-95, 52), wrist: at(-28, 30), toe: [ankle[0] + 40, ankle[1]],
    shL: at(0, -12), shR: at(0, 12), elbowFar: at(-95, 44), wristFar: at(-28, 22) };
}

/** 33 normalised landmarks [x, y, z, visibility, presence] from the body (same layout as synth skeleton()), no jitter. */
export function landmarksOf(b, vis = 0.95) {
  const pts = new Array(33).fill(null).map(() => [...b.head]);
  const set = (i, p) => { pts[i] = [p[0], p[1]]; };
  for (let i = 0; i <= 10; i++) set(i, [b.head[0] + (i % 3) * 6, b.head[1] + Math.floor(i / 3) * 6]);
  set(11, b.shL); set(12, b.shR); set(13, b.elbow); set(14, b.elbowFar); set(15, b.wrist); set(16, b.wristFar);
  for (const [i, p] of [[17, b.wrist], [19, b.wrist], [21, b.wrist], [18, b.wristFar], [20, b.wristFar], [22, b.wristFar]]) set(i, p);
  set(23, [b.hip[0] - 10, b.hip[1]]); set(24, [b.hip[0] + 10, b.hip[1]]);
  set(25, [b.knee[0] - 10, b.knee[1]]); set(26, [b.knee[0] + 10, b.knee[1]]);
  set(27, [b.ankle[0] - 10, b.ankle[1]]); set(28, [b.ankle[0] + 10, b.ankle[1]]);
  set(29, b.ankle); set(30, b.ankle); set(31, b.toe); set(32, b.toe);
  return pts.map(([x, y]) => [cx(x) / DEMO_W, cy(y) / DEMO_H, 0, vis, 0.99]);
}

function rng(seed) {                                                          // mulberry32 (as eval/synth.mjs)
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());

/**
 * The simulated participant's script. Times are on the caller's clock (performance.now() in the app).
 * start(t) once; react(t, readiness) on every camera-check frame; go(tGo) at GO. alphaAt / landmarksAt / bodyAtTime
 * are pure functions of time (jitter is seeded per 1/30-s slot), so the same times always give the same frames.
 */
export function createDemoScript({ seed = DEMO_SEED, noisePx = 2, vis = 0.95 } = {}) {
  let segs = [], t0 = null, tGo = null, practiceEnd = -Infinity, practices = 0;
  const plan = (tStart, steps) => { let t = tStart, a = 0; for (const [d, to] of steps) { segs.push({ t0: t, t1: t + d, a0: a, a1: to }); t += d; a = to; } return t; };
  const alphaAt = (t) => {
    let a = 0;
    for (const s of segs) { if (t < s.t0) break; if (t < s.t1) return s.a0 + (s.a1 - s.a0) * ease((t - s.t0) / (s.t1 - s.t0)); a = s.a1; }
    return a;
  };
  const self = {
    start(t) { if (t0 !== null) return; t0 = t; self.requestPractice(t, PRACTICE.firstLeadMs); },
    /** Plan a (new) practice stand: one at a time, never after GO. */
    requestPractice(t, leadMs = PRACTICE.repeatLeadMs) {
      if (tGo !== null || t < practiceEnd + 1000) return false;
      practices += 1;
      practiceEnd = plan(t + leadMs, [[PRACTICE.riseMs, 1], [PRACTICE.holdMs, 1], [PRACTICE.descendMs, 0]]);
      return true;
    },
    /** Called with the core's readiness during the camera check: repeat the practice stand when the app asks for one. */
    react(t, readiness) {
      if (t0 === null) self.start(t);
      if (readiness && (readiness.reasons || []).some((x) => PRACTICE_AGAIN.has(x))) self.requestPractice(t);
    },
    go(t) {
      if (tGo !== null) return;
      tGo = t; segs = segs.filter((s) => s.t1 <= t);
      let tt = t + GO_LEAD_MS;
      for (const [r, h, d, s, top] of STANDS) tt = plan(tt, [[r, top], [h, top], [d, 0], [s, 0]]);
      plan(tt, [[LAST_RISE_MS, 1], [1500, 1], [1000, 0]]);
    },
    alphaAt,
    bodyAtTime: (t) => bodyAt(alphaAt(t)),
    landmarksAt(t) {
      const lm = landmarksOf(bodyAt(alphaAt(t)), vis);
      const slot = Math.round((t - (t0 ?? 0)) * 0.03);
      const r = rng((seed ^ Math.imul(slot + 1, 0x9e3779b1)) >>> 0);
      return lm.map(([x, y, z, v, p]) => [x + (noisePx * gauss(r)) / DEMO_W, y + (noisePx * gauss(r)) / DEMO_H, z, v, p]);
    },
    get tGo() { return tGo; },
    info() {
      return { seed, noisePx, practiceStands: practices, goLeadMs: GO_LEAD_MS, stands: STANDS.map(([r, h, d, s, top]) => ({ riseMs: r, holdMs: h, descendMs: d, sitMs: s, topAlpha: top })),
        lastRiseMs: LAST_RISE_MS, expected: EXPECTED };
    },
  };
  return self;
}

/** Map the demo onto the decision gate's live/replay distinction: the demo runs the live workflow in real time (its own
 *  GO, 30-s clock and checks); everything it produces is labelled as a simulated demo (report, review, export). */
export const decisionSource = (source) => (source === "demo" ? "camera" : source);

/** Fields added to the downloaded record of a demo session. */
export function demoRecord(script) {
  return { simulated: true, realPerson: false, realMeasurement: false, label: DEMO_LABEL,
    note: "The participant, the picture and the body points were generated by the app's demo script (no camera, no pose model). The numbers show how the workflow behaves; they describe no one.",
    script: script ? script.info() : null };
}

// ---- drawing (browser only) ----
const COL = { wall: "#eef2f6", floor: "#d9dee5", line: "#9aa3ad", wood: "#8b5a2b", woodDark: "#6e4520", trousers: "#2f3e56", shirt: "#3f7cac", sleeve: "#24496b", skin: "#e2b48e", shoe: "#222" };
function stroke(ctx, pts, width, color) {
  ctx.strokeStyle = color; ctx.lineWidth = width * S; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.moveTo(cx(pts[0][0]), cy(pts[0][1])); for (const p of pts.slice(1)) ctx.lineTo(cx(p[0]), cy(p[1])); ctx.stroke();
}
export function drawScene(ctx, b) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = COL.wall; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = COL.floor; ctx.fillRect(0, cy(FLOOR_Y), W, H - cy(FLOOR_Y));
  ctx.strokeStyle = COL.line; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, cy(FLOOR_Y)); ctx.lineTo(W, cy(FLOOR_Y)); ctx.stroke();
  // straight-backed chair, no arm rests (seat top about knee height minus a cushion)
  stroke(ctx, [[110, 1000], [110, 1175]], 18, COL.woodDark); stroke(ctx, [[322, 1000], [322, 1175]], 18, COL.woodDark);
  stroke(ctx, [[100, 640], [100, 1000]], 22, COL.wood);
  stroke(ctx, [[100, 700], [100, 900]], 30, COL.wood);
  stroke(ctx, [[100, 992], [332, 992]], 24, COL.wood);
  // figure: legs, trunk, head, near arm crossed on the chest
  stroke(ctx, [b.ankle, b.toe.map((v, i) => v + (i === 0 ? 12 : 0))], 30, COL.shoe);
  stroke(ctx, [b.hip, b.knee, b.ankle], 50, COL.trousers);
  stroke(ctx, [b.hip, b.knee], 62, COL.trousers);
  stroke(ctx, [[b.hip[0] + 0.12 * (b.sh[0] - b.hip[0]), b.hip[1] + 0.12 * (b.sh[1] - b.hip[1])], b.sh], 84, COL.shirt);
  stroke(ctx, [b.sh, [b.sh[0] + 0.25 * (b.head[0] - b.sh[0]), b.sh[1] + 0.25 * (b.head[1] - b.sh[1])]], 30, COL.skin);
  ctx.fillStyle = COL.skin; ctx.beginPath(); ctx.arc(cx(b.head[0]), cy(b.head[1]), 50 * S, 0, 2 * Math.PI); ctx.fill();
  stroke(ctx, [b.sh, b.elbow, b.wrist], 28, COL.sleeve);
  ctx.fillStyle = COL.skin; ctx.beginPath(); ctx.arc(cx(b.wrist[0]), cy(b.wrist[1]), 13 * S, 0, 2 * Math.PI); ctx.fill();
  // burned-in label: every frame (and so every evidence image) says what this is
  ctx.font = "bold 40px system-ui, sans-serif"; const w = ctx.measureText(CANVAS_LABEL).width;
  ctx.fillStyle = "#fff"; ctx.fillRect(18, 16, w + 28, 60); ctx.strokeStyle = "#b3261e"; ctx.lineWidth = 4; ctx.strokeRect(18, 16, w + 28, 60);
  ctx.fillStyle = "#b3261e"; ctx.textBaseline = "middle"; ctx.fillText(CANVAS_LABEL, 32, 47);
  ctx.font = "26px system-ui, sans-serif"; ctx.fillStyle = "#444"; ctx.fillText("Computer-drawn figure. Not a camera image, not a real person.", 22, H - 24);
}

/** Start the offscreen scene and return its video stream (browser only). */
export function startDemoScene(script, { fps = 30, now = () => performance.now() } = {}) {
  const canvas = document.createElement("canvas"); canvas.width = DEMO_W; canvas.height = DEMO_H;
  const ctx = canvas.getContext("2d");
  script.start(now());
  let stopped = false, raf = null;
  const frame = () => { if (stopped) return; drawScene(ctx, script.bodyAtTime(now())); raf = requestAnimationFrame(frame); };
  frame();
  const stream = canvas.captureStream(fps);
  return { stream, stop() { stopped = true; if (raf !== null) cancelAnimationFrame(raf); stream.getTracks().forEach((t) => t.stop()); } };
}
