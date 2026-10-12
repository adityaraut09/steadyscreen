// Per-frame geometric features from BlazePose landmarks (33 points).
// Landmarks arrive as [x, y, z, visibility, presence] with x, y normalised to image width/height.
// Everything is converted to pixels first so distances are isotropic.
import { PARAMS } from "./params.js";

export const LM = {
  L_SHOULDER: 11, R_SHOULDER: 12, L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_ANKLE: 27, R_ANKLE: 28,
};
const SIDES = [
  { hip: LM.L_HIP, knee: LM.L_KNEE, ankle: LM.L_ANKLE },
  { hip: LM.R_HIP, knee: LM.R_KNEE, ankle: LM.R_ANKLE },
];

const px = (lm, i, w, h) => [lm[i][0] * w, lm[i][1] * h];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const vis = (lm, i) => lm[i][3] ?? 0;
const inFrame = (lm, i) => lm[i][0] >= 0 && lm[i][0] <= 1 && lm[i][1] >= 0 && lm[i][1] <= 1;

/** Torso centre, torso length and a loose bounding box, used for identity tracking. */
export function torsoGeometry(lm, w, h) {
  const ls = px(lm, LM.L_SHOULDER, w, h), rs = px(lm, LM.R_SHOULDER, w, h);
  const lh = px(lm, LM.L_HIP, w, h), rh = px(lm, LM.R_HIP, w, h);
  const centre = [(ls[0] + rs[0] + lh[0] + rh[0]) / 4, (ls[1] + rs[1] + lh[1] + rh[1]) / 4];
  const size = (dist(ls, lh) + dist(rs, rh)) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of lm) {
    if ((p[3] ?? 0) < 0.3) continue;
    x0 = Math.min(x0, p[0] * w); y0 = Math.min(y0, p[1] * h);
    x1 = Math.max(x1, p[0] * w); y1 = Math.max(y1, p[1] * h);
  }
  return { centre, size, box: [x0, y0, x1, y1] };
}

/**
 * Normalised hip height h = (knee_y - hip_y) / shin_length for each usable leg side.
 * Seated: hip near knee level (value depends on camera angle). Full stand: thigh vertical, h ~ 1.0-1.3.
 * shinRef (running reference, px) rejects landmark swaps; returns null when no side is usable.
 */
export function hipHeight(lm, w, h, shinRef) {
  const vals = [];
  for (const s of SIDES) {
    if (vis(lm, s.hip) < PARAMS.minVisibility || vis(lm, s.knee) < PARAMS.minVisibility ||
        vis(lm, s.ankle) < PARAMS.minVisibility) continue;
    if (!inFrame(lm, s.hip) || !inFrame(lm, s.knee) || !inFrame(lm, s.ankle)) continue;
    const hip = px(lm, s.hip, w, h), knee = px(lm, s.knee, w, h), ankle = px(lm, s.ankle, w, h);
    const shin = dist(knee, ankle);
    if (shin < 1) continue;
    if (shinRef && Math.abs(shin - shinRef) / shinRef > PARAMS.shinJumpTolerance) continue;
    const hv = (knee[1] - hip[1]) / shin;
    if (hv < PARAMS.hPlausibleMin || hv > PARAMS.hPlausibleMax) continue;
    vals.push({ h: hv, shin, v: Math.min(vis(lm, s.hip), vis(lm, s.knee), vis(lm, s.ankle)) });
  }
  if (!vals.length) return null;
  // Use the better-seen side (averaging a good side with a swapped one produced the dev-set spikes).
  vals.sort((a, b) => b.v - a.v);
  if (vals.length === 2 && Math.abs(vals[0].h - vals[1].h) < 0.25) {
    return { h: (vals[0].h + vals[1].h) / 2, shin: (vals[0].shin + vals[1].shin) / 2, sides: 2 };
  }
  return { h: vals[0].h, shin: vals[0].shin, sides: 1 };
}

/**
 * Arms-crossed heuristic: each wrist near the opposite shoulder.
 * Returns true (crossed), false (look uncrossed) or null (wrists not observable).
 * This only raises a flag for the observer; it never certifies protocol compliance.
 */
export function armsCrossed(lm, w, h, torsoSize) {
  if (vis(lm, LM.L_WRIST) < PARAMS.minVisibility || vis(lm, LM.R_WRIST) < PARAMS.minVisibility) return null;
  const lw = px(lm, LM.L_WRIST, w, h), rw = px(lm, LM.R_WRIST, w, h);
  const ls = px(lm, LM.L_SHOULDER, w, h), rs = px(lm, LM.R_SHOULDER, w, h);
  const far = PARAMS.armsFarFactor * torsoSize;
  return dist(lw, rs) <= far && dist(rw, ls) <= far;
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return ua > 0 ? inter / ua : 0;
}

const angleDeg = (a, b, c) => {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = Math.hypot(...v1) * Math.hypot(...v2);
  return d > 0 ? (Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / d))) * 180) / Math.PI : NaN;
};

/**
 * Leg/trunk geometry for full-stand classification (checkpoint 3).
 * Uses the better-seen side. Returns h (as hipHeight), 2-D knee angle (hip-knee-ankle), 2-D hip angle
 * (shoulder-hip-knee) and the view ratio (shoulder width / torso length: small = side view).
 * Angles are only meaningful in a side-ish view; the core decides that from the practice stand.
 */
export function legGeometry(lm, w, h, shinRef) {
  const hh = hipHeight(lm, w, h, shinRef);
  if (!hh) return null;
  const sideOf = (s) => Math.min(vis(lm, s.hip), vis(lm, s.knee), vis(lm, s.ankle), vis(lm, s.hip === LM.L_HIP ? LM.L_SHOULDER : LM.R_SHOULDER));
  const s = sideOf(SIDES[0]) >= sideOf(SIDES[1]) ? SIDES[0] : SIDES[1];
  const sh = s.hip === LM.L_HIP ? LM.L_SHOULDER : LM.R_SHOULDER;
  let knee = NaN, hip = NaN;
  if (sideOf(s) >= PARAMS.minVisibility) {
    knee = angleDeg(px(lm, s.hip, w, h), px(lm, s.knee, w, h), px(lm, s.ankle, w, h));
    hip = angleDeg(px(lm, sh, w, h), px(lm, s.hip, w, h), px(lm, s.knee, w, h));
  }
  const ls = px(lm, LM.L_SHOULDER, w, h), rs = px(lm, LM.R_SHOULDER, w, h);
  const lh = px(lm, LM.L_HIP, w, h), rh = px(lm, LM.R_HIP, w, h);
  const torso = Math.hypot((ls[0] + rs[0] - lh[0] - rh[0]) / 2, (ls[1] + rs[1] - lh[1] - rh[1]) / 2);
  const viewRatio = torso > 0 ? dist(ls, rs) / torso : NaN;
  return { h: hh.h, shin: hh.shin, knee, hip, viewRatio };
}
