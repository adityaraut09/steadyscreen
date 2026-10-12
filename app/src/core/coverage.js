// Per-decision evidence coverage (checkpoint 4, audit B). Spec: docs/CONTRACTS_CP4.md section 2.
// Input: the core result and the timestamps (same clock as the core) of images that were ACTUALLY captured.
// Output: for each decision the observer can make, whether suitable images exist within stated bounds.
// An image elsewhere in the session never covers a decision it was not taken for.
export const COVERAGE_VERSION = "coverage-1";
export const COVERAGE_LIMITS = Object.freeze({
  referenceSlackMs: 150,     // image inside the practice-stand hold [t0-150, t1+150]
  anchorMaxMs: 250,          // image within 250 ms of a rise's top (tFull / tExpiry / tPeak)
  flagSlackMs: 200,          // flag window extended by 200 ms each side ...
  flagMaxGapMs: 500,         // ... and covered with no gap > 500 ms
  endpointMaxMs: 250,        // image within 250 ms of the 30-s mark
  scanMaxGapMs: 1000,        // whole-test images with no gap > 1 s (needed to look for missed stands)
});
export const RISE_RESOLVED_FLAGS = new Set(["uncertain_rises", "extension_unverifiable_view", "no_practice_stand", "no_accepted_reference", "expiry_without_practice_stand"]);

export function anchorTime(e) { return e.tFull ?? e.tExpiry ?? e.tPeak ?? e.tRise ?? null; }

function nearest(times, t) {            // times sorted ascending
  let lo = 0, hi = times.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid + 1; else hi = mid - 1; }
  for (const i of [lo - 1, lo]) if (i >= 0 && i < times.length && (best === null || Math.abs(times[i] - t) < Math.abs(best - t))) best = times[i];
  return best;
}
function spanCovered(times, a, b, maxGap) {
  const inside = times.filter((t) => t >= a && t <= b);
  const pts = [a, ...inside, b];
  let worst = 0; const gaps = [];
  for (let i = 1; i < pts.length; i++) { const g = pts[i] - pts[i - 1]; worst = Math.max(worst, g); if (g > maxGap) gaps.push([Math.round(pts[i - 1]), Math.round(pts[i])]); }
  return { ok: inside.length > 0 && worst <= maxGap, maxGapMs: Math.round(worst), images: inside.length, gaps };
}

export function computeCoverage(result, imageTimes, L = COVERAGE_LIMITS) {
  const times = [...(imageTimes || [])].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const out = { version: COVERAGE_VERSION, limits: { ...L }, imageCount: times.length, imageTimes: times.map((t) => Math.round(t * 1000) / 1000),
    reference: { ok: false }, events: {}, flags: {}, endpoint: { ok: false, required: false }, scan: { ok: false } };
  const ref = result.reference || (result.calibration && result.calibration.stand) || null;
  if (ref && Number.isFinite(ref.t0) && Number.isFinite(ref.t1)) {
    const inHold = times.filter((t) => t >= ref.t0 - L.referenceSlackMs && t <= ref.t1 + L.referenceSlackMs);
    out.reference = { ok: inHold.length > 0, images: inHold.length, imageT: inHold.length ? inHold[inHold.length >> 1] : null };
  }
  for (const e of result.events || []) {
    const a = anchorTime(e); const n = a === null ? null : nearest(times, a);
    const d = n === null ? null : Math.abs(n - a);
    out.events[e.n] = { ok: d !== null && d <= L.anchorMaxMs, anchorT: a, imageT: n, distMs: d === null ? null : Math.round(d),
      startImageT: e.tRise != null ? nearest(times, e.tRise) : null, endImageT: e.tSeat != null ? nearest(times, e.tSeat) : null };
  }
  const tGo = result.window.tGo, tEnd = result.window.tEnd;
  out.scan = { ...spanCovered(times, tGo, tEnd, L.scanMaxGapMs), from: tGo, to: tEnd };
  for (const f of result.reviewFlags || []) {
    if (RISE_RESOLVED_FLAGS.has(f)) { out.flags[f] = { ok: null, resolvedByRises: true }; continue; }
    const wins = (result.flagWindows && result.flagWindows[f]) || [];
    if (!wins.length) { out.flags[f] = { ok: out.scan.ok, windows: [], viaWholeTest: true }; continue; }   // session-wide flags need the whole test
    const ws = wins.map(([a, b]) => ({ t0: a, t1: b, ...spanCovered(times, a - L.flagSlackMs, b + L.flagSlackMs, L.flagMaxGapMs) }));
    out.flags[f] = { ok: ws.every((w) => w.ok), windows: ws };
  }
  const endpointRequired = (result.events || []).some((e) => e.cls === "expiry" || (e.flags || []).some((x) => /^expiry_/.test(x))) ||
    (result.reviewFlags || []).some((f) => /^expiry_/.test(f)) || (result.expiry && result.expiry.decision && !["none", "closed_descending_rise"].includes(result.expiry.decision));
  const en = nearest(times, tEnd);
  out.endpoint = { required: !!endpointRequired, ok: en !== null && Math.abs(en - tEnd) <= L.endpointMaxMs, imageT: en, distMs: en === null ? null : Math.round(Math.abs(en - tEnd)) };
  return out;
}

/** True if an observer-added stand's time is exactly an image time (it was picked from an image). */
export function hasImageAt(coverage, t) { return !!coverage && coverage.imageTimes.some((x) => Math.abs(x - t) <= 1); }
