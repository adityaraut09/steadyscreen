// Realistic-ish synthetic sessions (older-adult-like movement variety, landmark jitter, visibility flicker, frame-time
// jitter, dropped frames). Written by the 4th independent adversarial reviewer (eval/overnight_scratch/adversarial4/gen4.mjs)
// and promoted unchanged except for these imports, so regression tests can use it. Synthetic engineering probes only -
// NOT evidence about real people.
import { skeleton, rng } from "./synth.mjs";
import { createChairStand as NEW } from "../app/src/core/chair_stand.js";
export { NEW };
export const gauss = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
const U = (r, a, b) => a + (b - a) * r();

/** segs: [{d, to, lean?}] piecewise-cosine alpha; lean offset (rad) interpolated too. */
export function track(segs, a0 = 0) {
  const pts = []; let t = 0, a = a0, l = 0;
  for (const s of segs) { const lt = s.lean ?? l; pts.push({ t0: t, t1: t + s.d, a0: a, a1: s.to, l0: l, l1: lt, tag: s.tag }); t += s.d; a = s.to; l = lt; }
  const at = (tt) => { for (const p of pts) if (tt >= p.t0 && tt < p.t1) { const u = (tt - p.t0) / (p.t1 - p.t0), e = 0.5 - 0.5 * Math.cos(Math.PI * u); return { a: p.a0 + (p.a1 - p.a0) * e, l: p.l0 + (p.l1 - p.l0) * e }; } return { a, l }; };
  return { at, total: t, pts };
}

/**
 * Build one session. Returns {segs, GO, truthFullTimes (times alpha reached the top of a genuine full stand),
 * partialTimes}. style controls the movement variety.
 * style: {riseMs:[a,b], pauseP, rockP, lateP, holdMs:[a,b], descMs:[a,b], sitMs:[a,b], partialP, partialPeak:[a,b],
 *         topAlpha:[a,b] (genuine full stands' top alpha), leanJit (rad, per stand), practice:{late, sway, holdMs}}
 */
export function session(style, r) {
  const segs = [];
  const P = style.practice || {};
  segs.push({ d: 1500, to: 0 });
  // practice stand: optionally late straightening, with small sway during the hold
  if (P.late) { segs.push({ d: U(r, 900, 1400), to: 0.93 }); segs.push({ d: U(r, 300, 700), to: 1 }); } else segs.push({ d: U(r, 800, 1200), to: 1 });
  const hold = P.holdMs ?? U(r, 1000, 1600);
  const sway = P.sway ?? 0;
  for (let k = 0; k < 4; k++) segs.push({ d: hold / 4, to: 1 - (k % 2 ? 0 : sway), lean: (k % 2 ? -1 : 1) * sway * 0.5 });
  segs.push({ d: U(r, 900, 1300), to: 0, lean: 0 });
  segs.push({ d: 1700, to: 0 });
  const GO = segs.reduce((s, x) => s + x.d, 0) - 150;
  const truth = [], partials = [];
  let t = segs.reduce((s, x) => s + x.d, 0);
  const push = (s) => { segs.push(s); t += s.d; };
  push({ d: 250 + (style.lead || 0), to: 0 });
  while (t < GO + 33000) {
    if (r() < (style.rockP || 0)) { const n = 1 + Math.floor(r() * 2); for (let i = 0; i < n; i++) { push({ d: 250, to: U(r, 0.05, 0.12) }); push({ d: 250, to: 0 }); } }
    if (r() < (style.partialP || 0)) {
      push({ d: U(r, ...style.riseMs) * 0.7, to: U(r, ...style.partialPeak) }); push({ d: U(r, 100, 300), to: segs[segs.length - 1].to }); partials.push(t);
      push({ d: U(r, ...style.descMs), to: 0 }); push({ d: U(r, ...style.sitMs), to: 0 }); continue;
    }
    const top = U(r, ...(style.topAlpha || [1, 1])), lean = (style.leanJit || 0) * gauss(r);
    const riseMs = U(r, ...style.riseMs);
    if (r() < (style.pauseP || 0)) { const mid = U(r, 0.35, 0.6); push({ d: riseMs * mid, to: mid }); push({ d: U(r, 200, 600), to: mid + 0.02 }); push({ d: riseMs * (1 - mid), to: r() < (style.lateP || 0) ? 0.93 : top, lean }); }
    else push({ d: riseMs, to: r() < (style.lateP || 0) ? 0.93 : top, lean });
    if (segs[segs.length - 1].to === 0.93) push({ d: U(r, 250, 600), to: top, lean });
    truth.push(t);
    push({ d: U(r, ...style.holdMs), to: top, lean });
    push({ d: U(r, ...style.descMs), to: 0, lean: 0 });
    push({ d: U(r, ...style.sitMs), to: 0 });
  }
  return { segs, GO, truth, partials, trk: track(segs) };
}

/** Frames: jitter px per landmark; shoulder flicker prob; leg-side flicker prob; frame-time jitter; drops. */
export function* framesOf(sess, { fps = 30, noisePx = 3, shoulderFlick = 0, legFlick = 0, tJit = 0, drop = 0, leanBase = 0, seed = 1, until = null, farHidden = false, nearShoulderFlick = 0 } = {}) {
  const r = rng(seed * 7919 + fps * 31 + Math.round(noisePx * 10));
  const end = until ?? sess.GO + 30600; let last = -1;
  for (let i = 0; ; i++) {
    let t = Math.round(i * 1000 / fps + (tJit ? U(r, -tJit, tJit) : 0));
    if (t <= last) t = last + 1;
    if (t > end) break;
    if (drop && r() < drop) continue;
    last = t;
    const { a, l } = sess.trk.at(t);
    let lm = skeleton(a, { leanExtra: leanBase + l });
    lm = lm.map(([x, y, z, v, p]) => [x + noisePx * gauss(r) / 720, y + noisePx * gauss(r) / 1280, z, v, p]);
    if (farHidden) for (const k of [12, 14, 16, 24, 26, 28]) lm[k] = [lm[k][0], lm[k][1], 0, 0.2, 0.99];   // far side occluded (side view)
    if (farHidden && nearShoulderFlick && r() < nearShoulderFlick) lm[11] = [lm[11][0], lm[11][1], 0, 0.35, 0.99];
    if (shoulderFlick && r() < shoulderFlick) { const k = r() < 0.5 ? 11 : 12; lm[k] = [lm[k][0], lm[k][1], 0, 0.3, 0.99]; if (r() < 0.5) { const k2 = 23 - k + 0; } }
    if (legFlick && r() < legFlick) { const side = r() < 0.5 ? [23, 25, 27] : [24, 26, 28]; for (const k of side) lm[k] = [lm[k][0], lm[k][1], 0, 0.3, 0.99]; }
    yield { t, a, poses: [lm] };
  }
}

/** Drive one session through a core factory. */
export function runCore(mk, sess, fo, { accept = true } = {}) {
  const core = mk({ width: 720, height: 1280 }); let started = false, res = null, notReady = null, tStart = null;
  for (const f of framesOf(sess, fo)) {
    if (core.phase === "calibrating" && f.t >= sess.GO && !started && notReady === null) {
      const pr = core.readiness().practice || {};
      if (accept && pr.state === "detected") { core.freezeReference?.(pr.refId); core.acceptReference({ refId: pr.refId, basis: "image" }); }
      const rd = core.readiness();
      if (rd.ready) { core.start(f.t); started = true; tStart = f.t; } else notReady = rd.reasons.join(",");
    }
    const s = core.push({ t: f.t, poses: f.poses });
    if (s.result) { res = s.result; break; }
  }
  if (!started) return { notReady: notReady || core.readiness().reasons.join(",") };
  return { r: res || core.finish("stream_end"), tStart };
}

export function truthCount(sess, tStart) {
  // genuine full stands whose top (end of the rise segment reaching the top) falls in (tStart, tStart+30000]
  const tops = []; for (const p of sess.trk.pts) if (p.a1 >= 0.985 && p.a0 < 0.985 && p.t0 > sess.GO - 100) tops.push(p.t1);
  const tEnd = tStart + 30000;
  const n = tops.filter((t) => t > tStart && t <= tEnd).length;
  const aEnd = sess.trk.at(tEnd).a, aPrev = sess.trk.at(tEnd - 60).a;
  const seg = sess.trk.pts.find((p) => tEnd >= p.t0 && tEnd < p.t1);
  const rising = !!seg && seg.a1 > seg.a0 + 1e-3 && aEnd > aPrev + 1e-4;   // inside a rising segment at 30 s (its top not yet reached)
  const frac = Math.sin(Math.PI / 2 * aEnd);
  const kase = rising ? (Math.abs(frac - 0.5) <= 0.1 ? "near" : frac > 0.5 ? "over" : "under") : "none";
  return { n, kase, nWithExpiry: n + (kase === "over" ? 1 : 0), tops: tops.filter((t) => t > tStart && t <= tEnd) };
}
